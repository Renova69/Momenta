import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * POST /api/billing/checkout-session with Stripe configured — the state the
 * real dev/test environment never reaches on its own, since no keys are set.
 *
 * Focus is the duplicate-subscription guard: WedMoments would otherwise
 * happily create a second live Pro Planner subscription for an account that
 * already has one, and bill it twice a month forever.
 */
vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_checkout_spec';
});

/** Status Stripe will report for a subscription id, set per test. */
const subscriptionStatuses = new Map<string, string>();

vi.mock('../../server/lib/stripe', async () => {
  // isSubscriptionLiveAtStripe lives in this module, so the mock has to supply
  // it — but it delegates to the module's REAL status predicate rather than
  // restating the list, which is what this spec is actually driving through
  // `subscriptionStatuses`. Restating it here would let the two copies drift
  // and quietly turn these assertions into a test of the mock.
  const actual = await vi.importActual<typeof import('../../server/lib/stripe')>('../../server/lib/stripe');
  return {
  ...actual,
  isStripeConfigured: () => true,
  isSubscriptionLiveAtStripe: async (id: string) =>
    actual.isLiveSubscriptionStatus(subscriptionStatuses.get(id) ?? ''),
  getStripeClient: () => ({
    subscriptions: {
      retrieve: (id: string) => {
        const status = subscriptionStatuses.get(id);
        if (!status) throw new Error(`No such subscription: ${id}`);
        return { id, status };
      },
    },
    checkout: {
      sessions: {
        create: () => ({ url: 'https://checkout.stripe.com/c/pay/stubbed' }),
      },
    },
  }),
  };
});

import { authRouter } from '../../server/routes/auth';
import { billingRouter } from '../../server/routes/billing';
import { applyTierUpgrade } from '../../server/lib/subscriptionUpgrade';
import { CONFIG } from '../../server/lib/config';

const TEST_PORT = 6629;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function registerHost(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `checkout-${uniqueId('u')}@test.com`,
      fullName: 'Checkout Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id };
}

async function startCheckout(token: string, tier: string): Promise<Response> {
  const origin = new URL(CONFIG.PUBLIC_BASE_URL).origin;
  return fetch(`${BASE_URL}/api/billing/checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      tier,
      successUrl: `${origin}/?checkout=success`,
      cancelUrl: `${origin}/?checkout=cancelled`,
    }),
  });
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (server) server.close();
});

describe('duplicate subscription guard', () => {
  it('refuses a second subscription while one is live at Stripe', async () => {
    const { token, userId } = await registerHost();
    const subscriptionId = uniqueId('sub_live');
    subscriptionStatuses.set(subscriptionId, 'active');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    const res = await startCheckout(token, 'pro_planner');

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ALREADY_SUBSCRIBED');
  });

  it('treats a subscription still in dunning as live', async () => {
    const { token, userId } = await registerHost();
    const subscriptionId = uniqueId('sub_pastdue');
    subscriptionStatuses.set(subscriptionId, 'past_due');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    expect((await startCheckout(token, 'pro_planner')).status).toBe(400);
  });

  it('allows a new subscription when the stored one was cancelled', async () => {
    const { token, userId } = await registerHost();
    const subscriptionId = uniqueId('sub_cancelled');
    subscriptionStatuses.set(subscriptionId, 'canceled');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    expect((await startCheckout(token, 'pro_planner')).status).toBe(200);
  });

  it('allows a new subscription when Stripe has never heard of the stored id', async () => {
    const { token, userId } = await registerHost();
    // A stale row — the cancellation webhook was missed, say. Blocking on it
    // would lock this customer out of subscribing again permanently, which is
    // worse than the duplicate the guard exists to prevent.
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      stripeSubscriptionId: uniqueId('sub_unknown_to_stripe'),
    });

    expect((await startCheckout(token, 'pro_planner')).status).toBe(200);
  });

  it('never blocks a one-time pass — it is not a second subscription', async () => {
    const { token, userId } = await registerHost();
    const subscriptionId = uniqueId('sub_live_onetime');
    subscriptionStatuses.set(subscriptionId, 'active');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    expect((await startCheckout(token, 'celebration_pass')).status).toBe(200);
  });
});
