import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * Stripe is forced UNCONFIGURED: POST /api/subscriptions/upgrade only writes a
 * PAID tier at all while there is no payment processor to route through. Once
 * STRIPE_SECRET_KEY is set the route answers 403 CHECKOUT_REQUIRED for paid
 * tiers by design, so the fallback behaviour these specs cover is only
 * observable in the no-keys state. Pinning it here keeps them from passing or
 * failing on whatever the developer's .env holds — they began failing the
 * moment real sandbox keys were added. The gate itself has its own spec,
 * subscriptionsUpgradeGate.spec.ts, which mocks the opposite state.
 */
vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => false,
  getStripeClient: () => {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  },
}));

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { subscriptionsRouter } from '../../server/routes/subscriptions';
import { query } from '../../server/lib/db';
import { computeExpiry } from '../../server/lib/retention';

/**
 * Regression for OPEN_ITEMS.md P1 — Broken Plan Upgrade Pipeline.
 *
 * PricingPlansModal used to write `event.planTier` into localStorage and fire
 * confetti immediately, then PUT /api/events/:id — a request the server
 * silently ignored because `planTier` was never in the PUT handler's field
 * map. The subscriptions row (the only thing `tierGate.ts` actually trusts)
 * never changed, so the tier reverted on the next page load.
 *
 * POST /api/subscriptions/upgrade closes that gap by writing the
 * subscriptions row directly (no payment gateway — see the route file for
 * why that's the deliberate scope here).
 */

const TEST_PORT = 6601;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ token: string; userId: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Subscription Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

describe('POST /api/subscriptions/upgrade', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/subscriptions', subscriptionsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    if (server) server.close();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'celebration_pass' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid tier value', async () => {
    const { token } = await registerHost();
    const res = await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: 'ultra_mega_plan' }),
    });
    expect(res.status).toBe(400);
  });

  it('actually persists the tier — GET /api/events reflects it immediately', async () => {
    const { token, eventId } = await registerHost();

    const before = await (
      await fetch(`${BASE_URL}/api/events`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    expect(before.find((e: { id: string }) => e.id === eventId).planTier).toBe('free');

    const upgradeRes = await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: 'deluxe_keepsake' }),
    });
    expect(upgradeRes.status).toBe(200);
    const upgraded = await upgradeRes.json();
    expect(upgraded.tier).toBe('deluxe_keepsake');

    const after = await (
      await fetch(`${BASE_URL}/api/events`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    expect(after.find((e: { id: string }) => e.id === eventId).planTier).toBe('deluxe_keepsake');
  });

  it('supports downgrading back to free', async () => {
    const { token } = await registerHost();

    await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: 'celebration_pass' }),
    });

    const downgradeRes = await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: 'free' }),
    });
    expect(downgradeRes.status).toBe(200);
    expect((await downgradeRes.json()).tier).toBe('free');
  });

  it('recomputes the event\'s expires_at to the new tier\'s retention window (SEC-05)', async () => {
    const { token, eventId } = await registerHost();

    const before = await query('SELECT event_date, created_at, expires_at FROM events WHERE id = $1', [eventId]);
    const freeExpiry = computeExpiry('free', before.rows[0].event_date, before.rows[0].created_at);
    // Registration's own event-creation path already stamps this correctly -
    // confirms the free-tier baseline this test's upgrade needs to move away
    // from is what we think it is.
    expect(new Date(before.rows[0].expires_at).toISOString()).toBe(freeExpiry!.toISOString());

    const upgradeRes = await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: 'deluxe_keepsake' }),
    });
    expect(upgradeRes.status).toBe(200);

    const after = await query('SELECT expires_at FROM events WHERE id = $1', [eventId]);
    const deluxeExpiry = computeExpiry('deluxe_keepsake', before.rows[0].event_date, before.rows[0].created_at);
    expect(new Date(after.rows[0].expires_at).toISOString()).toBe(deluxeExpiry!.toISOString());
    // The 12-month deluxe window is genuinely later than the 7-day free one -
    // guards against a fix that just left the stale value in place unnoticed.
    expect(new Date(after.rows[0].expires_at).getTime()).toBeGreaterThan(new Date(before.rows[0].expires_at).getTime());
  });

  it('raises the event limit for pro_planner and leaves other tiers at 1', async () => {
    const { token, userId } = await registerHost();

    await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: 'pro_planner' }),
    });

    const { rows } = await query('SELECT event_limit FROM subscriptions WHERE user_id = $1 AND status = $2', [
      userId,
      'active',
    ]);
    expect(rows[0].event_limit).toBe(10);

    // A second event should now succeed (registration already created one).
    const secondEvent = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostName: 'Pro Planner Host', title: 'Second Wedding' }),
    });
    expect(secondEvent.status).toBe(201);
  });
});
