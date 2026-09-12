import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * H7 — a self-service downgrade left the customer paying.
 *
 * POST /api/subscriptions/upgrade {"tier":"free"} was always allowed, on the
 * reasoning that a downgrade needs no payment step. But it cleared the stored
 * `stripe_subscription_id` without cancelling anything at Stripe, so:
 *
 *   - the card kept being charged while the account sat on `free`;
 *   - the next `invoice.paid` found tier=free, failed `isPaidTier`, logged a
 *     warning and did nothing — so the money arrived and bought nothing;
 *   - `refreshExpiryDates` recomputed retention at the free tier's 7 days,
 *     which for a wedding already in the past is a date already gone, putting
 *     a paying customer's photos in the retention sweep's path.
 *
 * The route now refuses while a live subscription exists and points at the
 * Billing Portal, which is where Stripe expects cancellation to happen.
 * Separately, no tier recompute may ever make an album deletable sooner than
 * the grace period from now — that guard holds regardless of how the tier
 * changed.
 */

const LIVE_SUBSCRIPTIONS = new Set<string>();

vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => true,
  // The real helper is a thin wrapper over subscriptions.retrieve; mocking it
  // directly keeps this spec about the downgrade decision rather than about
  // Stripe's status vocabulary, which lib/stripe owns and states explicitly.
  isSubscriptionLiveAtStripe: async (id: string) => LIVE_SUBSCRIPTIONS.has(id),
  getStripeClient: () => ({
    subscriptions: {
      retrieve: async (id: string) => ({ status: LIVE_SUBSCRIPTIONS.has(id) ? 'active' : 'canceled' }),
    },
    billingPortal: {
      sessions: {
        create: async () => ({ url: 'https://billing.stripe.test/session/abc' }),
      },
    },
  }),
}));

import { authRouter } from '../../server/routes/auth';
import { subscriptionsRouter } from '../../server/routes/subscriptions';
import { billingRouter } from '../../server/routes/billing';
import { refreshExpiryDates, GRACE_PERIOD_DAYS } from '../../server/lib/retention';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';

const TEST_PORT = 6638;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];
const createdUsers: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `downgrade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Downgrade Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  createdUsers.push(data.user.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

function downgrade(host: Host) {
  return fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ tier: 'free' }),
  });
}

async function givePaidPlan(host: Host, subscriptionId: string | null): Promise<void> {
  await query(
    `UPDATE subscriptions
        SET tier = 'pro_planner', event_limit = 10, stripe_customer_id = $2, stripe_subscription_id = $3
      WHERE user_id = $1 AND status = 'active'`,
    [host.userId, `cus_${host.userId.slice(0, 8)}`, subscriptionId]
  );
}

describe('downgrade guard (H7)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/subscriptions', subscriptionsRouter);
    app.use('/api/billing', billingRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(() => undefined);
    if (server) server.close();
    LIVE_SUBSCRIPTIONS.clear();
  });

  it('refuses to downgrade while a live Stripe subscription exists', async () => {
    const host = await registerHost();
    const subId = `sub_live_${Date.now()}`;
    LIVE_SUBSCRIPTIONS.add(subId);
    await givePaidPlan(host, subId);

    const res = await downgrade(host);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('MANAGE_SUBSCRIPTION_IN_PORTAL');

    // The tier must be untouched — a refused request changes nothing.
    const sub = await query<{ tier: string; stripe_subscription_id: string }>(
      "SELECT tier, stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = 'active'",
      [host.userId]
    );
    expect(sub.rows[0].tier).toBe('pro_planner');
    expect(sub.rows[0].stripe_subscription_id).toBe(subId);
  });

  it('allows the downgrade once the subscription is no longer live at Stripe', async () => {
    const host = await registerHost();
    await givePaidPlan(host, `sub_dead_${Date.now()}`); // never added to LIVE_SUBSCRIPTIONS

    const res = await downgrade(host);

    expect(res.status).toBe(200);
    const sub = await query<{ tier: string }>(
      "SELECT tier FROM subscriptions WHERE user_id = $1 AND status = 'active'",
      [host.userId]
    );
    expect(sub.rows[0].tier).toBe('free');
  });

  it('allows the downgrade for an account that never had a subscription id', async () => {
    const host = await registerHost();
    await givePaidPlan(host, null);

    const res = await downgrade(host);

    expect(res.status).toBe(200);
  });

  it('offers a Billing Portal session to redirect to', async () => {
    const host = await registerHost();
    await givePaidPlan(host, `sub_portal_${Date.now()}`);

    const res = await fetch(`${BASE_URL}/api/billing/portal-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ returnUrl: `${CONFIG.PUBLIC_BASE_URL}/` }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://billing.stripe.test/session/abc');
  });

  it('refuses a portal session for an unauthenticated caller', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/portal-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnUrl: `${CONFIG.PUBLIC_BASE_URL}/` }),
    });

    expect(res.status).toBe(401);
  });

  it('pins the portal return URL to an allowed origin', async () => {
    const host = await registerHost();
    await givePaidPlan(host, `sub_portal2_${Date.now()}`);

    const res = await fetch(`${BASE_URL}/api/billing/portal-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ returnUrl: 'https://evil.example/thanks' }),
    });

    expect(res.status).toBe(400);
  });

  describe('retention floor', () => {
    it('never recomputes an expiry that is already past the grace period', async () => {
      // A wedding that happened months ago, on an account being recomputed at
      // the free tier's 7 days. Without a floor the new expiry is a date long
      // gone, and the very next sweep treats the album as eligible.
      const host = await registerHost();
      await query(
        "UPDATE events SET event_date = NOW() - INTERVAL '6 months', created_at = NOW() - INTERVAL '7 months' WHERE id = $1",
        [host.eventId]
      );

      await refreshExpiryDates(host.userId);

      const row = await query<{ expires_at: string }>('SELECT expires_at FROM events WHERE id = $1', [host.eventId]);
      const expiresAt = new Date(row.rows[0].expires_at).getTime();
      const graceFloor = Date.now() + (GRACE_PERIOD_DAYS - 1) * 24 * 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThan(graceFloor);
    });

    it('leaves a future expiry exactly where the plan puts it', async () => {
      const host = await registerHost();
      await query("UPDATE events SET event_date = NOW() + INTERVAL '30 days' WHERE id = $1", [host.eventId]);

      await refreshExpiryDates(host.userId);

      const row = await query<{ expires_at: string; event_date: string }>(
        'SELECT expires_at, event_date FROM events WHERE id = $1',
        [host.eventId]
      );
      const expiresAt = new Date(row.rows[0].expires_at).getTime();
      const eventDate = new Date(row.rows[0].event_date).getTime();

      // Free tier keeps an album 7 days past the celebration.
      const expected = eventDate + 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt - expected)).toBeLessThan(60 * 1000);
    });

    it('leaves an indefinite retention indefinite', async () => {
      const host = await registerHost();
      await query("UPDATE subscriptions SET tier = 'pro_planner' WHERE user_id = $1 AND status = 'active'", [
        host.userId,
      ]);

      await refreshExpiryDates(host.userId);

      const row = await query<{ expires_at: string | null }>('SELECT expires_at FROM events WHERE id = $1', [
        host.eventId,
      ]);
      expect(row.rows[0].expires_at).toBeNull();
    });
  });
});
