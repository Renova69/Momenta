import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * Stripe is forced UNCONFIGURED here, rather than left to whatever the
 * developer's .env happens to hold.
 *
 * These specs assert the no-keys contract — 503 STRIPE_NOT_CONFIGURED instead
 * of a crash or a silent no-op — which only means something when the absence
 * of keys is guaranteed. Reading it from the environment made the file pass or
 * fail depending on the machine it ran on, and it started failing the moment
 * real sandbox keys were added to .env. The configured-Stripe paths have their
 * own specs (billingCheckout, billingPriceMap, billingWebhook), each mocking
 * the state it needs.
 */
vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => false,
  getStripeClient: () => {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  },
}));

import { authRouter } from '../../server/routes/auth';
import { billingRouter } from '../../server/routes/billing';
import { handleStripeWebhook } from '../../server/routes/billingWebhook';
import { applyTierUpgrade, applyTierDowngradeToFree } from '../../server/lib/subscriptionUpgrade';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';

/**
 * Stripe checkout — server/routes/billing.ts. STRIPE_SECRET_KEY is
 * intentionally unset in this dev/test environment (the owner will add real
 * keys later), so the meaningful, honestly-testable behavior right now is:
 * the route correctly reports itself as unconfigured (503, not a crash or a
 * silent no-op) rather than pretending to take a payment, and the DB-writing
 * logic the webhook will eventually call (applyTierUpgrade /
 * applyTierDowngradeToFree) is already correct and tested directly.
 */

const TEST_PORT = 6625;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `billing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Billing Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id };
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (server) server.close();
});

describe('POST /api/billing/checkout-session', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier: 'celebration_pass',
        successUrl: 'http://localhost:6500/?checkout=success',
        cancelUrl: 'http://localhost:6500/?checkout=cancelled',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects the free tier — a checkout session is only for paid tiers', async () => {
    const { token } = await registerHost();
    const res = await fetch(`${BASE_URL}/api/billing/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tier: 'free',
        successUrl: 'http://localhost:6500/?checkout=success',
        cancelUrl: 'http://localhost:6500/?checkout=cancelled',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a redirect URL outside the configured CORS origins', async () => {
    const { token } = await registerHost();
    const res = await fetch(`${BASE_URL}/api/billing/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tier: 'celebration_pass',
        successUrl: 'https://evil.example.com/?checkout=success',
        cancelUrl: 'http://localhost:6500/?checkout=cancelled',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a redirect back to PUBLIC_BASE_URL even when it is absent from CORS_ORIGIN', async () => {
    const { token } = await registerHost();
    const publicOrigin = new URL(CONFIG.PUBLIC_BASE_URL).origin;

    const res = await fetch(`${BASE_URL}/api/billing/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tier: 'celebration_pass',
        successUrl: `${publicOrigin}/?checkout=success`,
        cancelUrl: `${publicOrigin}/?checkout=cancelled`,
      }),
    });

    // Getting past redirect validation to the "no keys yet" answer is the
    // assertion — a same-origin deployment that leaves CORS_ORIGIN blank must
    // not be locked out of its own checkout by the default-deny rule.
    expect(res.status).toBe(503);
  });

  it('reports 503 STRIPE_NOT_CONFIGURED rather than a crash or a silent no-op', async () => {
    const { token } = await registerHost();
    const res = await fetch(`${BASE_URL}/api/billing/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tier: 'celebration_pass',
        successUrl: 'http://localhost:6500/?checkout=success',
        cancelUrl: 'http://localhost:6500/?checkout=cancelled',
      }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('STRIPE_NOT_CONFIGURED');
  });
});

describe('POST /api/billing/webhook', () => {
  it('reports unconfigured rather than accepting an unverifiable event', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    expect(res.status).toBe(503);
  });
});

describe('applyTierUpgrade (the DB write the webhook will call once Stripe is live)', () => {
  it('persists Stripe customer/subscription IDs and the monthly billing type', async () => {
    const { userId } = await registerHost();

    const result = await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      amountPaidCents: 4900,
      stripeCustomerId: 'cus_test123',
      stripeSubscriptionId: 'sub_test456',
    });
    expect(result.tier).toBe('pro_planner');
    expect(result.event_limit).toBe(10);

    const row = await query(
      'SELECT billing_type, amount_paid_cents, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = $2',
      [userId, 'active']
    );
    expect(row.rows[0]).toMatchObject({
      billing_type: 'monthly',
      amount_paid_cents: 4900,
      stripe_customer_id: 'cus_test123',
      stripe_subscription_id: 'sub_test456',
    });
  });

  it('keeps the Stripe customer id on a later upgrade that does not repeat it', async () => {
    const { userId } = await registerHost();

    await applyTierUpgrade(userId, 'celebration_pass', {
      billingType: 'one_time',
      amountPaidCents: 4900,
      stripeCustomerId: 'cus_keep_me',
    });
    // A second checkout (e.g. upgrading again later) that doesn't carry a
    // customer id of its own must not blank out the one already on file.
    await applyTierUpgrade(userId, 'deluxe_keepsake', { billingType: 'one_time', amountPaidCents: 8900 });

    const row = await query('SELECT stripe_customer_id, tier FROM subscriptions WHERE user_id = $1 AND status = $2', [
      userId,
      'active',
    ]);
    expect(row.rows[0].tier).toBe('deluxe_keepsake');
    expect(row.rows[0].stripe_customer_id).toBe('cus_keep_me');
  });

  it('keeps a live subscription id when a one-time pass is bought on top of it', async () => {
    const { userId } = await registerHost();

    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      amountPaidCents: 4900,
      stripeCustomerId: 'cus_still_subscribed',
      stripeSubscriptionId: 'sub_still_live',
    });

    // A one-time purchase arrives from a `mode: 'payment'` session, where
    // session.subscription is null — which used to overwrite the live
    // subscription id with NULL, leaving the eventual
    // customer.subscription.deleted with nothing to match on and the account
    // paid forever.
    await applyTierUpgrade(userId, 'celebration_pass', { billingType: 'one_time', amountPaidCents: 4900 });

    const row = await query(
      'SELECT tier, stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = $2',
      [userId, 'active']
    );
    expect(row.rows[0].tier).toBe('celebration_pass');
    expect(row.rows[0].stripe_subscription_id).toBe('sub_still_live');
  });

  it('applyTierDowngradeToFree resets the tier when a subscription is cancelled', async () => {
    const { userId } = await registerHost();
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      stripeCustomerId: 'cus_cancel_test',
      stripeSubscriptionId: 'sub_cancel_test',
    });

    await applyTierDowngradeToFree(userId);

    const row = await query(
      'SELECT tier, event_limit, stripe_subscription_id, stripe_customer_id FROM subscriptions WHERE user_id = $1 AND status = $2',
      [userId, 'active']
    );
    expect(row.rows[0].tier).toBe('free');
    expect(row.rows[0].event_limit).toBe(1);
    // The Stripe subscription is genuinely gone, so a stale id left behind
    // would be a false match for a later webhook lookup. The customer id
    // stays, so a returning customer reuses their Stripe customer record.
    expect(row.rows[0].stripe_subscription_id).toBeNull();
    expect(row.rows[0].stripe_customer_id).toBe('cus_cancel_test');
  });
});
