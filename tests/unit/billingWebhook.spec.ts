import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * server/routes/billingWebhook.ts — the only code path that turns money into
 * access, exercised end-to-end over HTTP against the real database.
 *
 * A webhook secret has to exist before server/lib/config.ts is imported,
 * hence vi.hoisted: CONFIG reads process.env once, at module load.
 */
vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_webhook_spec';
  // Force the price map OFF. These specs cover the metadata path — the one
  // that runs when no Stripe Price IDs are configured — so the state has to be
  // pinned rather than inherited from .env. Adding real STRIPE_PRICE_* values
  // there switched the code to the Price path, which calls
  // checkout.sessions.listLineItems and is covered by billingPriceMap.spec.ts.
  process.env.STRIPE_PRICE_CELEBRATION_PASS = '';
  process.env.STRIPE_PRICE_DELUXE_KEEPSAKE = '';
  process.env.STRIPE_PRICE_PRO_PLANNER = '';
});

/**
 * Signature verification is Stripe's own code, and testing it would only test
 * their HMAC. What needs testing is everything we do *after* an event is
 * accepted, so constructEvent is stubbed to parse the raw body it was handed
 * — the same Stripe.Event object a real verified delivery produces.
 */
vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => true,
  getStripeClient: () => ({
    webhooks: {
      constructEvent: (body: Buffer) => JSON.parse(body.toString()),
    },
  }),
}));

import { authRouter } from '../../server/routes/auth';
import { handleStripeWebhook } from '../../server/routes/billingWebhook';
import { applyTierUpgrade } from '../../server/lib/subscriptionUpgrade';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';

const TEST_PORT = 6626;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function registerHost(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `webhook-${uniqueId('u')}@test.com`,
      fullName: 'Webhook Spec Host',
      password: 'Password123!',
    }),
  });
  return (await res.json()).user.id as string;
}

async function postEvent(event: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stubbed' },
    body: JSON.stringify(event),
  });
}

async function subscriptionRow(userId: string) {
  const res = await query(
    "SELECT tier, amount_paid_cents, billing_type, stripe_subscription_id, stripe_customer_id, past_due_grace_expiry FROM subscriptions WHERE user_id = $1 AND status = 'active'",
    [userId]
  );
  return res.rows[0];
}

/** Puts a user on a paid plan whose dunning window ended `daysAgo` days ago. */
async function seedExpiredGrace(userId: string, subscriptionId: string, daysAgo: number): Promise<void> {
  await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });
  await query(
    "UPDATE subscriptions SET past_due_grace_expiry = NOW() - ($2 || ' days')::interval WHERE user_id = $1 AND status = 'active'",
    [userId, String(daysAgo)]
  );
}

function checkoutSessionEvent(
  type: string,
  session: Record<string, unknown>,
  eventId = uniqueId('evt')
): Record<string, unknown> {
  return { id: eventId, type, data: { object: { id: uniqueId('cs'), ...session } } };
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (server) server.close();
});

describe('checkout.session.completed — payment settlement', () => {
  it('does NOT grant the tier when the session completed but the payment has not settled', async () => {
    const userId = await registerHost();

    // What SEPA Direct Debit looks like: the session is done, the money is
    // not. Granting here would hand out a paid tier for a payment that may
    // never arrive.
    const res = await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'payment',
        payment_status: 'unpaid',
        amount_total: 4900,
        metadata: { userId, tier: 'celebration_pass' },
      })
    );

    expect(res.status).toBe(200);
    expect((await subscriptionRow(userId)).tier).toBe('free');
  });

  it('grants the tier once the delayed payment succeeds', async () => {
    const userId = await registerHost();

    await postEvent(
      checkoutSessionEvent('checkout.session.async_payment_succeeded', {
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 8900,
        customer: 'cus_async_settled',
        metadata: { userId, tier: 'deluxe_keepsake' },
      })
    );

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('deluxe_keepsake');
    expect(row.amount_paid_cents).toBe(8900);
  });

  it('grants the tier on a normally paid session', async () => {
    const userId = await registerHost();

    await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 4900,
        customer: 'cus_paid_ok',
        subscription: 'sub_paid_ok',
        metadata: { userId, tier: 'pro_planner' },
      })
    );

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.billing_type).toBe('monthly');
    expect(row.stripe_subscription_id).toBe('sub_paid_ok');
  });

  it('ignores a session whose tier metadata is not a plan this app sells', async () => {
    const userId = await registerHost();

    const res = await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 4900,
        metadata: { userId, tier: 'enterprise_unlimited' },
      })
    );

    expect(res.status).toBe(200);
    expect((await subscriptionRow(userId)).tier).toBe('free');
  });
});

describe('webhook idempotency', () => {
  it('applies an event once and reports a re-delivery of it as a duplicate', async () => {
    const userId = await registerHost();
    const eventId = uniqueId('evt_dup');
    const event = checkoutSessionEvent(
      'checkout.session.completed',
      {
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 4900,
        metadata: { userId, tier: 'celebration_pass' },
      },
      eventId
    );

    const first = await postEvent(event);
    expect(await first.json()).toMatchObject({ received: true });

    // Stripe re-delivers on any non-2xx, and this handler answers 500 on a
    // transient DB error, so re-delivery of an already-applied event is
    // routine rather than exceptional.
    const second = await postEvent(event);
    expect(await second.json()).toMatchObject({ received: true, duplicate: true });

    const claims = await query('SELECT COUNT(*)::int AS n FROM stripe_webhook_events WHERE event_id = $1', [eventId]);
    expect(claims.rows[0].n).toBe(1);
  });

  it('applies an event exactly once even when two deliveries land at the same moment', async () => {
    const userId = await registerHost();
    const event = checkoutSessionEvent('checkout.session.completed', {
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 8900,
      customer: uniqueId('cus_race'),
      metadata: { userId, tier: 'deluxe_keepsake' },
    });

    // Stripe fans deliveries out concurrently. Note this passes on the
    // PRIMARY KEY alone — the second transaction blocks on the conflicting
    // insert and sees DO NOTHING once the first commits — so it does NOT
    // exercise the per-customer advisory lock, which guards a different case
    // (two *different* events read-modify-writing the same row).
    const [first, second] = await Promise.all([postEvent(event), postEvent(event)]);
    const bodies = [await first.json(), await second.json()];

    expect(bodies.filter((b) => b.duplicate === true)).toHaveLength(1);
    expect((await subscriptionRow(userId)).tier).toBe('deluxe_keepsake');

    const claims = await query('SELECT COUNT(*)::int AS n FROM stripe_webhook_events WHERE event_id = $1', [
      event.id as string,
    ]);
    expect(claims.rows[0].n).toBe(1);
  });
});

describe('customer.subscription.deleted — cancellation', () => {
  it('downgrades via subscription metadata', async () => {
    const userId = await registerHost();
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      stripeSubscriptionId: uniqueId('sub_meta'),
    });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: uniqueId('sub'), status: 'canceled', metadata: { userId } } },
    });

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });

  it('downgrades a subscription carrying no metadata, by looking up the stored id', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_nometa');
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      stripeSubscriptionId: subscriptionId,
    });

    // A subscription created from the Stripe Dashboard, or re-created by a
    // Billing Portal plan change, carries none of our metadata. Trusting
    // metadata alone made those cancellations a silent no-op.
    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: {} } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('free');
    expect(row.stripe_subscription_id).toBeNull();
  });
});

describe('customer.subscription.updated', () => {
  it('keeps the paid tier when the customer has cancelled but paid through the period', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_periodend');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'active', cancel_at_period_end: true, metadata: { userId } } },
    });

    expect((await subscriptionRow(userId)).tier).toBe('pro_planner');
  });

  it('keeps the paid tier while Stripe is still retrying a late payment, and stamps a deadline', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_pastdue');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    // Cutting off a paying customer on the first failed charge — possibly
    // mid-wedding — is worse than carrying them while Stripe retries.
    expect(row.past_due_grace_expiry).not.toBeNull();
    expect(new Date(row.past_due_grace_expiry).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not extend a deadline that is already running on each further retry failure', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_pastdue_twice');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    const pastDue = () => ({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });

    await postEvent(pastDue());
    const first = (await subscriptionRow(userId)).past_due_grace_expiry;
    await postEvent(pastDue());
    const second = (await subscriptionRow(userId)).past_due_grace_expiry;

    // Otherwise a subscription retrying for weeks would never actually expire.
    expect(new Date(second).getTime()).toBe(new Date(first).getTime());
  });

  it('downgrades once the grace deadline has passed', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_grace_gone');
    await seedExpiredGrace(userId, subscriptionId, 1);

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });

  it('clears the deadline when the payment recovers', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_recovered');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });
    expect((await subscriptionRow(userId)).past_due_grace_expiry).not.toBeNull();

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'active', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.past_due_grace_expiry).toBeNull();
  });

  it('downgrades when the subscription has ended for good', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_unpaid');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'unpaid', metadata: { userId } } },
    });

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });
});

describe('invoice.paid — monthly renewal', () => {
  it('re-applies the tier on a renewal so retention deadlines keep moving', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_renewal');
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      amountPaidCents: 1,
      stripeSubscriptionId: subscriptionId,
    });

    await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_cycle',
          amount_paid: 4900,
          parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId, metadata: {} } },
        },
      },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.amount_paid_cents).toBe(4900);
  });

  it('reads the subscription from a pre-2025 invoice payload shape too', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_legacy');
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      amountPaidCents: 1,
      stripeSubscriptionId: subscriptionId,
    });

    // Event payload shape follows the API version set on the webhook
    // endpoint, which is a separate setting from the SDK's pinned version.
    await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_cycle',
          amount_paid: 4900,
          subscription: subscriptionId,
        },
      },
    });

    expect((await subscriptionRow(userId)).amount_paid_cents).toBe(4900);
  });

  it('ignores the first invoice of a subscription — the checkout session already granted it', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_create');
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      amountPaidCents: 4900,
      stripeSubscriptionId: subscriptionId,
    });

    await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_create',
          amount_paid: 9999,
          parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId, metadata: {} } },
        },
      },
    });

    expect((await subscriptionRow(userId)).amount_paid_cents).toBe(4900);
  });
});

describe('event types the app does not handle', () => {
  it('accepts and records them rather than erroring', async () => {
    const eventId = uniqueId('evt_ignored');

    const res = await postEvent({
      id: eventId,
      type: 'charge.updated',
      data: { object: { id: uniqueId('ch'), object: 'charge' } },
    });

    expect(res.status).toBe(200);
    // Recorded, so a re-delivery of it is still a no-op. This is also what
    // makes the "no handler — recorded and ignored" log line honest.
    const claims = await query('SELECT COUNT(*)::int AS n FROM stripe_webhook_events WHERE event_id = $1', [eventId]);
    expect(claims.rows[0].n).toBe(1);
  });
});

describe('webhook configuration failures', () => {
  it('answers 503, not 4xx, when the webhook secret is missing so Stripe keeps retrying', async () => {
    const original = CONFIG.STRIPE_WEBHOOK_SECRET;
    CONFIG.STRIPE_WEBHOOK_SECRET = '';
    try {
      const res = await postEvent(checkoutSessionEvent('checkout.session.completed', { payment_status: 'paid' }));
      expect(res.status).toBe(503);
    } finally {
      CONFIG.STRIPE_WEBHOOK_SECRET = original;
    }
  });

  it('rejects a delivery with no signature header at all', async () => {
    const res = await fetch(`${BASE_URL}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: uniqueId('evt'), type: 'checkout.session.completed' }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * The same field, two shapes.
 *
 * Stripe returns a related object as either a bare id string or an expanded
 * object, and which one arrives depends on the API version and the expansion
 * settings on the endpoint — neither of which this app controls, and both of
 * which can change without a deploy here. Reading only the string form would
 * lose the subscription or customer id on an expanded payload, and the failure
 * is the worst-shaped one billing has: the webhook returns 200, Stripe records
 * a successful delivery and never retries, and the customer who has just paid
 * stays on the free plan with no error anywhere.
 */
describe('expanded payload shapes', () => {
  it('grants the tier when subscription and customer arrive as objects, not strings', async () => {
    const userId = await registerHost();

    await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 4900,
        customer: { id: 'cus_expanded_ok' },
        subscription: { id: 'sub_expanded_ok' },
        metadata: { userId, tier: 'pro_planner' },
      })
    );

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.stripe_subscription_id).toBe('sub_expanded_ok');
  });

  it('renews on an invoice whose subscription is an expanded object', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_invoice_expanded');
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      amountPaidCents: 1,
      stripeSubscriptionId: subscriptionId,
    });

    await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_cycle',
          amount_paid: 4900,
          parent: { subscription_details: { subscription: { id: subscriptionId } } },
        },
      },
    });

    // The amount is what proves the renewal was actually applied. Asserting
    // the tier alone would pass whether or not the invoice resolved, since the
    // tier was already pro_planner before the event arrived.
    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.amount_paid_cents).toBe(4900);
  });

  it('downgrades on a cancellation whose customer is an expanded object', async () => {
    const userId = await registerHost();
    await applyTierUpgrade(userId, 'pro_planner', {
      billingType: 'monthly',
      stripeSubscriptionId: 'sub_cancel_expanded',
    });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_cancel_expanded',
          status: 'canceled',
          customer: { id: 'cus_cancel_expanded' },
        },
      },
    });

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });
});

describe('events about subscriptions this app has never seen', () => {
  it('accepts a cancellation for an unknown subscription instead of erroring', async () => {
    // Stripe sends every event on the account, including ones created outside
    // this app or belonging to a deleted user. A 500 here makes Stripe retry
    // the same unresolvable event for days and can mark the endpoint unhealthy,
    // which then delays the deliveries that *do* matter.
    const res = await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_never_seen_here', status: 'canceled', customer: 'cus_unknown' } },
    });

    expect(res.status).toBe(200);
  });

  it('accepts a renewal invoice for an unknown subscription', async () => {
    const res = await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: 'sub_never_seen_either' } },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it('accepts an invoice carrying no subscription reference at all', async () => {
    // A one-off invoice, which has no subscription to re-apply a tier from.
    const res = await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: { object: { id: uniqueId('in'), billing_reason: 'manual' } },
    });

    expect(res.status).toBe(200);
  });
});
