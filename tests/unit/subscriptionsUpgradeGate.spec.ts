import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * server/routes/subscriptions.ts writes a plan tier with no payment behind
 * it. That is the deliberate zero-setup fallback while Stripe is unconfigured
 * — and a free-money hole the moment it is not, since any authenticated user
 * can call it directly regardless of what the pricing UI prefers to do.
 *
 * These specs pin the gate that closes it. Stripe is mocked as *configured*,
 * which is the state the real dev/test environment never reaches on its own
 * (no keys are set), so it is the one case that would otherwise ship untested.
 */
vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => true,
  getStripeClient: () => {
    throw new Error('not used in this spec');
  },
}));

import { authRouter } from '../../server/routes/auth';
import { subscriptionsRouter } from '../../server/routes/subscriptions';
import { query } from '../../server/lib/db';

const TEST_PORT = 6627;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `gate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Upgrade Gate Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id };
}

function upgrade(token: string, tier: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tier }),
  });
}

async function tierOf(userId: string): Promise<string> {
  const res = await query("SELECT tier FROM subscriptions WHERE user_id = $1 AND status = 'active'", [userId]);
  return res.rows[0].tier;
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (server) server.close();
});

describe('POST /api/subscriptions/upgrade with Stripe configured', () => {
  it('refuses to hand out a paid tier without a payment', async () => {
    const { token, userId } = await registerHost();

    const res = await upgrade(token, 'pro_planner');

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CHECKOUT_REQUIRED');
    expect(await tierOf(userId)).toBe('free');
  });

  it('refuses every paid tier, not just the most expensive one', async () => {
    const { token, userId } = await registerHost();

    for (const tier of ['celebration_pass', 'deluxe_keepsake']) {
      expect((await upgrade(token, tier)).status).toBe(403);
    }
    expect(await tierOf(userId)).toBe('free');
  });

  it('still allows a downgrade to free — no payment is involved in giving something up', async () => {
    const { token, userId } = await registerHost();

    const res = await upgrade(token, 'free');

    expect(res.status).toBe(200);
    expect(await tierOf(userId)).toBe('free');
  });

  it('rejects an unauthenticated caller before anything else', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'pro_planner' }),
    });
    expect(res.status).toBe(401);
  });
});
