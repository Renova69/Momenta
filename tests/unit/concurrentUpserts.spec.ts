import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * Stripe is forced UNCONFIGURED so the subscription-upgrade half of this file
 * still reaches the upsert it is testing: with keys set, paid tiers are
 * refused up front with 403 CHECKOUT_REQUIRED and the race under test never
 * runs. The DB-08 concurrency guarantee is unrelated to Stripe — this only
 * keeps the route reachable.
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

/**
 * Regression for OPEN_ITEMS.md DB-08 — both the qr-config PUT and the
 * subscription upgrade endpoint used a check-then-branch UPDATE-or-INSERT.
 * Two concurrent requests that both saw "no existing row" could both take
 * the INSERT branch, and the loser hit an unhandled 500 against a real
 * UNIQUE constraint (qr_canvas_configs.event_id, and the partial
 * UNIQUE(user_id) WHERE status='active' index on subscriptions) instead of
 * both succeeding. The fix is a real `INSERT ... ON CONFLICT DO UPDATE` for
 * each, which is actually atomic.
 */

const TEST_PORT = 6618;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ token: string; eventId: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `upsert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Upsert Race Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, eventId: data.event.id, userId: data.user.id };
}

describe('Concurrent upsert races do not 500 (DB-08)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/subscriptions', subscriptionsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  it('PUT /api/events/:id/qr-config: concurrent first-time writes all succeed, exactly one row exists', async () => {
    const host = await registerHost();
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);

    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        fetch(`${BASE_URL}/api/events/${host.eventId}/qr-config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
          body: JSON.stringify({ headline: `Racer ${i}` }),
        })
      )
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);

    const rows = await query('SELECT COUNT(*)::int AS c FROM qr_canvas_configs WHERE event_id = $1', [host.eventId]);
    expect(rows.rows[0].c).toBe(1);

    await query('DELETE FROM events WHERE id = $1', [host.eventId]).catch(() => undefined);
    // Registration hashes a password with bcrypt and this then issues five
    // concurrent writes, all against a pool deliberately capped at 5 per
    // worker (vitest.config.ts). Vitest's 5s default is enough on its own and
    // not enough under a full parallel run, which makes it a timeout that
    // fails by scheduling luck rather than by anything about the code.
  }, 20_000);

  it('POST /api/subscriptions/upgrade: concurrent upgrades all succeed, exactly one active row exists', async () => {
    const host = await registerHost();
    // Force the race scenario the finding describes: no active row for this
    // user (the one from registration deactivated), so every concurrent
    // request hits the same "insert a fresh active row" branch.
    await query("UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1", [host.userId]);

    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
          body: JSON.stringify({ tier: 'deluxe_keepsake' }),
        })
      )
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);

    const rows = await query(
      "SELECT COUNT(*)::int AS c FROM subscriptions WHERE user_id = $1 AND status = 'active'",
      [host.userId]
    );
    expect(rows.rows[0].c).toBe(1);

    await query('DELETE FROM events WHERE id = $1', [host.eventId]).catch(() => undefined);
  }, 20_000);

  afterAll(() => {
    if (server) server.close();
  });
});
