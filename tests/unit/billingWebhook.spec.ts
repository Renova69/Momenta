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
/**
 * What Stripe says a subscription's status is *now*, as opposed to what the
 * event carrying it says (N-44). postEvent records each subscription.updated
 * snapshot here, so an in-order delivery reads back exactly what it carried;
 * a test about a stale delivery pins the current status first with stripeSays.
 * Absent means active.
 */
const stripeNow = vi.hoisted(() => new Map<string, string>());
const pinnedByTest = vi.hoisted(() => new Set<string>());
const UNREACHABLE = '__unreachable__';
const MISSING = '__missing__';

vi.mock('../../server/lib/stripe', async () => {
  // The real status rule, not a restated copy that could drift from it.
  const actual = await vi.importActual<typeof import('../../server/lib/stripe')>('../../server/lib/stripe');
  return {
    isStripeConfigured: () => true,
    isLiveSubscriptionStatus: actual.isLiveSubscriptionStatus,
    getStripeClient: () => ({
      webhooks: {
        constructEvent: (body: Buffer) => JSON.parse(body.toString()),
      },
    }),
    retrieveSubscriptionOrNull: async (id: string) => {
      const status = stripeNow.get(id) ?? 'active';
      if (status === '__unreachable__') throw new Error('ECONNRESET');
      if (status === '__missing__') return null;
      return { id, status };
    },
  };
});

function stripeSays(subscriptionId: string, status: string): void {
  stripeNow.set(subscriptionId, status);
  pinnedByTest.add(subscriptionId);
}

import { handleStripeWebhook, eventCustomerId } from '../../server/routes/billingWebhook';
import { applyTierUpgrade, suspendTierForNonPayment } from '../../server/lib/subscriptionUpgrade';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

const TEST_PORT = 6626;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * A host account on the free tier, created in the database directly.
 *
 * Not through POST /api/auth/register: this spec is about the webhook, and the
 * register route's limiter allows 25 accounts per address per 15 minutes. Past
 * that every further host came back as a 429 with no user, and the tests that
 * happened to run last failed for a reason that had nothing to do with them.
 * The @test.com address is what the end-of-run purge matches on.
 */
async function registerHost(): Promise<string> {
  const user = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role)
     VALUES ($1, 'Webhook Spec Host', 'x', 'couple') RETURNING id`,
    [`webhook-${uniqueId('u')}@test.com`]
  );
  const userId = user.rows[0].id;
  await query(
    `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit)
     VALUES ($1, 'free', 'active', 'one_time', 0, 'EUR', 1)`,
    [userId]
  );
  return userId;
}

async function postEvent(event: Record<string, unknown>): Promise<Response> {
  if (event.type === 'customer.subscription.updated') {
    const object = (event.data as { object: { id: string; status: string } }).object;
    if (!pinnedByTest.has(object.id)) stripeNow.set(object.id, object.status);
  }
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
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (server) server.close();
});

describe('a one-time pass belongs to an album (N-169)', () => {
  it('is recorded on the album checkout was opened for, not just the newest', async () => {
    const userId = await registerHost();
    const albums = await query<{ id: string }>(
      `INSERT INTO events (title, slug, host_name, host_email, event_date, host_user_id, created_at)
       VALUES ('Older', $2, 'Host', 'host@test.com', NOW(), $1, NOW() - INTERVAL '1 day'),
              ('Newer', $3, 'Host', 'host@test.com', NOW(), $1, NOW())
       RETURNING id`,
      [userId, uniqueId('older').toLowerCase(), uniqueId('newer').toLowerCase()]
    );
    const [older, newer] = albums.rows.map((r) => r.id);

    const res = await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 4900,
        metadata: { userId, tier: 'celebration_pass', eventId: older },
      })
    );

    expect(res.status).toBe(200);
    const passes = await query<{ id: string; pass_tier: string | null }>(
      'SELECT id, pass_tier FROM events WHERE id = ANY($1)',
      [[older, newer]]
    );
    const byId = Object.fromEntries(passes.rows.map((r) => [r.id, r.pass_tier]));
    expect(byId[older]).toBe('celebration_pass');
    expect(byId[newer]).toBeNull();
    await deleteEventFixtures([older, newer]);
  });
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
    // One id for both. This used to cancel a different subscription from the
    // one on file and expect a downgrade, which is the N-43 bug written down
    // as a requirement: the point of the test is only that metadata finds
    // the account.
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_meta');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: { userId } } },
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
    // `canceled`, not `unpaid`: an unpaid subscription has not ended at Stripe
    // and can still be paid, so it suspends rather than ends (N-35, below).
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_canceled');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('free');
    expect(row.stripe_subscription_id).toBeNull();
  });
});

/**
 * N-35 — running out of grace is not a cancellation.
 *
 * The grace sweep, the expired past_due branch and `unpaid` all used to end
 * the plan the way a cancellation does: tier to free, stored subscription id
 * cleared. But Stripe was still retrying the card. When a retry succeeded,
 * the renewal found a free account and refreshed nothing, the subscription
 * went on charging every month, and with the id gone checkout would open a
 * second one. Now those paths suspend: the tier drops, the subscription stays
 * on file, and a payment on it brings the plan back.
 */
describe('dunning suspension (N-35)', () => {
  function renewalInvoice(subscriptionId: string, metadata: Record<string, string> = {}): Record<string, unknown> {
    return {
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_cycle',
          amount_paid: 4900,
          parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId, metadata } },
        },
      },
    };
  }

  function subscriptionUpdated(subscriptionId: string, userId: string, status: string): Record<string, unknown> {
    return {
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status, metadata: { userId } } },
    };
  }

  it('keeps the subscription on file when grace runs out, and a late payment restores the plan', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_late_payer');
    await seedExpiredGrace(userId, subscriptionId, 1);

    await postEvent(subscriptionUpdated(subscriptionId, userId, 'past_due'));

    const suspended = await subscriptionRow(userId);
    expect(suspended.tier).toBe('free');
    // Still live at Stripe, so still ours to match a recovery against — and
    // still there for checkout's ALREADY_SUBSCRIBED guard to find.
    expect(suspended.stripe_subscription_id).toBe(subscriptionId);

    await postEvent(renewalInvoice(subscriptionId));

    const restored = await subscriptionRow(userId);
    expect(restored.tier).toBe('pro_planner');
    expect(restored.past_due_grace_expiry).toBeNull();
  });

  it('suspends an unpaid subscription, and restores it once it is active again', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_unpaid');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent(subscriptionUpdated(subscriptionId, userId, 'unpaid'));

    const suspended = await subscriptionRow(userId);
    expect(suspended.tier).toBe('free');
    expect(suspended.stripe_subscription_id).toBe(subscriptionId);

    await postEvent(subscriptionUpdated(subscriptionId, userId, 'active'));

    expect((await subscriptionRow(userId)).tier).toBe('pro_planner');
  });

  it('suspends from the grace sweep the same way', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_swept');
    await seedExpiredGrace(userId, subscriptionId, 1);

    await suspendTierForNonPayment(userId);

    const suspended = await subscriptionRow(userId);
    expect(suspended.tier).toBe('free');
    expect(suspended.stripe_subscription_id).toBe(subscriptionId);
    expect(suspended.past_due_grace_expiry).toBeNull();

    await postEvent(renewalInvoice(subscriptionId));

    expect((await subscriptionRow(userId)).tier).toBe('pro_planner');
  });

  it('restores nothing from a payment on a different subscription', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_suspended');
    await seedExpiredGrace(userId, subscriptionId, 1);
    await postEvent(subscriptionUpdated(subscriptionId, userId, 'past_due'));

    await postEvent(renewalInvoice(uniqueId('sub_other'), { userId }));

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });

  it('ends a suspended plan for good when Stripe finally cancels, and a stray payment then restores nothing', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_gave_up');
    await seedExpiredGrace(userId, subscriptionId, 1);
    await postEvent(subscriptionUpdated(subscriptionId, userId, 'past_due'));

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: { userId } } },
    });

    const ended = await subscriptionRow(userId);
    expect(ended.tier).toBe('free');
    expect(ended.stripe_subscription_id).toBeNull();

    await postEvent(renewalInvoice(subscriptionId, { userId }));

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });
});

/**
 * N-43 — the handlers found the account by metadata.userId, which every
 * checkout-created subscription carries, and never asked whether the event's
 * subscription was the one on file. An account can hold two: two checkouts
 * opened in parallel, or a new one started after an old one's id was lost.
 * Then the old one ending downgraded an account paid up on the new one.
 */
describe('events about a subscription other than the one on file (N-43)', () => {
  async function payingOn(subscriptionId: string): Promise<string> {
    const userId = await registerHost();
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });
    return userId;
  }

  it('an old subscription ending does not downgrade an account paying on a newer one', async () => {
    const current = uniqueId('sub_current');
    const userId = await payingOn(current);

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: uniqueId('sub_old'), status: 'canceled', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.stripe_subscription_id).toBe(current);
  });

  it('an old subscription going past_due does not start a grace window', async () => {
    const userId = await payingOn(uniqueId('sub_current'));

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: uniqueId('sub_old'), status: 'past_due', metadata: { userId } } },
    });

    expect((await subscriptionRow(userId)).past_due_grace_expiry).toBeNull();
  });

  it('an old subscription renewing does not replace the one on file', async () => {
    const current = uniqueId('sub_current');
    const userId = await payingOn(current);

    await postEvent({
      id: uniqueId('evt'),
      type: 'invoice.paid',
      data: {
        object: {
          id: uniqueId('in'),
          billing_reason: 'subscription_cycle',
          amount_paid: 4900,
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: uniqueId('sub_old'), metadata: { userId } },
          },
        },
      },
    });

    expect((await subscriptionRow(userId)).stripe_subscription_id).toBe(current);
  });
});

/**
 * N-44 — Stripe does not guarantee delivery order, and every handler acted on
 * the snapshot its event carried. A past_due redelivered after the recovery
 * started a new grace window on a paid-up account; a checkout completion
 * processed after its subscription was deleted granted Pro for good. The
 * handlers now ask Stripe for the subscription's state when it decides.
 */
describe('events delivered out of order (N-44)', () => {
  it('a past_due delivered after the recovery does not start a grace window', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_recovered_first');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });
    stripeSays(subscriptionId, 'active');

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('pro_planner');
    expect(row.past_due_grace_expiry).toBeNull();
  });

  it('a checkout completion processed after its subscription was cancelled grants nothing', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_cancelled_first');
    stripeSays(subscriptionId, 'canceled');

    await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 4900,
        customer: uniqueId('cus'),
        subscription: subscriptionId,
        metadata: { userId, tier: 'pro_planner' },
      })
    );

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });

  it('asks Stripe to retry when it cannot be asked, rather than acting on the snapshot', async () => {
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_unreachable');
    stripeSays(subscriptionId, UNREACHABLE);

    const res = await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 4900,
        customer: uniqueId('cus'),
        subscription: subscriptionId,
        metadata: { userId, tier: 'pro_planner' },
      })
    );

    expect(res.status).toBe(500);
    expect((await subscriptionRow(userId)).tier).toBe('free');
  });

  it('acts on the snapshot when Stripe no longer has the subscription at all', async () => {
    // Nothing newer exists to prefer over it.
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_vanished');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });
    stripeSays(subscriptionId, MISSING);

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: { userId } } },
    });

    expect((await subscriptionRow(userId)).tier).toBe('free');
  });
});

/**
 * N-45 — a host on a one-time pass may buy Pro Planner on top of it. The
 * grant overwrote the one subscriptions row, nothing recorded the earlier
 * purchase, and when the subscription ended the account dropped to free: the
 * pass, already paid for, was gone with it.
 */
/** Found by the review of e70c78f and 14c9987. */
describe('suspension edge cases', () => {
  it('the grace sweep does not suspend an account whose payment landed after it made its list', async () => {
    // The sweep lists expired accounts, then suspends them one by one outside
    // any lock. A renewal handled in between clears the grace deadline; the
    // suspension must notice, or a paying customer sits on free for a month.
    const userId = await registerHost();
    const subscriptionId = uniqueId('sub_paid_meanwhile');
    await seedExpiredGrace(userId, subscriptionId, 1);
    await query(
      "UPDATE subscriptions SET past_due_grace_expiry = NULL WHERE user_id = $1 AND status = 'active'",
      [userId]
    );

    await suspendTierForNonPayment(userId, undefined, { onlyIfGraceExpired: true });

    expect((await subscriptionRow(userId)).tier).toBe('pro_planner');
  });

  it('a new subscription starts clean of the old suspension', async () => {
    // Suspended on subscription A, then a fresh checkout on B. B's own dunning
    // must still open a grace window rather than being ignored as "already
    // suspended".
    const userId = await registerHost();
    const old = uniqueId('sub_old_suspended');
    await seedExpiredGrace(userId, old, 1);
    await suspendTierForNonPayment(userId);

    const fresh = uniqueId('sub_fresh');
    await postEvent(
      checkoutSessionEvent('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 4900,
        customer: uniqueId('cus'),
        subscription: fresh,
        metadata: { userId, tier: 'pro_planner' },
      })
    );
    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: fresh, status: 'past_due', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.stripe_subscription_id).toBe(fresh);
    expect(row.past_due_grace_expiry).not.toBeNull();
  });
});

describe('a one-time pass held under a subscription (N-45)', () => {
  async function passThenPro(pass: 'celebration_pass' | 'deluxe_keepsake', subscriptionId: string) {
    const userId = await registerHost();
    await applyTierUpgrade(userId, pass, { billingType: 'one_time', amountPaidCents: 8900 });
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });
    return userId;
  }

  it('falls back to the pass when the subscription ends, not to free', async () => {
    const subscriptionId = uniqueId('sub_on_top_of_pass');
    const userId = await passThenPro('deluxe_keepsake', subscriptionId);
    expect((await subscriptionRow(userId)).tier).toBe('pro_planner');

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('deluxe_keepsake');
    expect(row.stripe_subscription_id).toBeNull();
  });

  it('falls back to the pass while suspended, and a late payment still restores Pro', async () => {
    const subscriptionId = uniqueId('sub_suspended_over_pass');
    const userId = await passThenPro('celebration_pass', subscriptionId);
    await query(
      "UPDATE subscriptions SET past_due_grace_expiry = NOW() - INTERVAL '1 day' WHERE user_id = $1 AND status = 'active'",
      [userId]
    );

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });
    expect((await subscriptionRow(userId)).tier).toBe('celebration_pass');

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
    expect((await subscriptionRow(userId)).tier).toBe('pro_planner');
  });

  it('a further past_due on a plan already suspended over a pass starts nothing new', async () => {
    // Suspended down to the pass, the account is on a paid tier again. A later
    // retry failure must not open a grace window on the pass itself.
    const subscriptionId = uniqueId('sub_suspended_then_pastdue');
    const userId = await passThenPro('deluxe_keepsake', subscriptionId);
    await suspendTierForNonPayment(userId);

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.updated',
      data: { object: { id: subscriptionId, status: 'past_due', metadata: { userId } } },
    });

    const row = await subscriptionRow(userId);
    expect(row.tier).toBe('deluxe_keepsake');
    expect(row.past_due_grace_expiry).toBeNull();
  });

  it('does not count a subscription plan as a pass to fall back to', async () => {
    // Pro Planner is sold monthly. A row that once held it on the pre-Stripe
    // self-serve path (billing_type one_time) must not become a "pass".
    const userId = await registerHost();
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'one_time' });
    const subscriptionId = uniqueId('sub_after_selfserve_pro');
    await applyTierUpgrade(userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: subscriptionId });

    await postEvent({
      id: uniqueId('evt'),
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, status: 'canceled', metadata: { userId } } },
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
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: subscriptionId, metadata: {} },
          },
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
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: subscriptionId, metadata: {} },
          },
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

/**
 * Which customer a webhook event is about.
 *
 * `processEvent` takes a transaction-scoped advisory lock keyed on this id, so
 * two concurrent deliveries for the same customer queue instead of racing their
 * read-then-write. If the extractor returns nothing, `if (customerId)` is false
 * and **no lock is taken at all** — the race is back, and nothing in the logs
 * says so.
 *
 * Mutation testing found this: flipping the `typeof === 'string'` test made a
 * bare-id event yield `('cus_x').id`, which is undefined, and all four spec
 * files reaching this module stayed green. Stripe sends both shapes depending
 * on the event type, so both have to work.
 */
describe('the customer an event is about', () => {
  const asEvent = (customer: unknown) =>
    ({ data: { object: { customer } } }) as unknown as Parameters<typeof eventCustomerId>[0];

  it('reads a bare customer id', () => {
    // checkout.session.completed and the invoice events send it this way.
    expect(eventCustomerId(asEvent('cus_PlainString'))).toBe('cus_PlainString');
  });

  it('reads an expanded customer object', () => {
    // Subscription events send the object. Both must key the same lock, or two
    // deliveries about one customer take two different locks and neither waits.
    expect(eventCustomerId(asEvent({ id: 'cus_Expanded' }))).toBe('cus_Expanded');
  });

  it('answers null when there is no customer to lock on', () => {
    for (const absent of [null, undefined]) {
      expect(eventCustomerId(asEvent(absent))).toBeNull();
    }
    expect(eventCustomerId({ data: { object: {} } } as unknown as Parameters<typeof eventCustomerId>[0])).toBeNull();
  });

  it('never answers undefined, which would silently skip the lock', () => {
    // `processEvent` branches on truthiness, so undefined and null behave the
    // same there — but null is the documented "nothing to lock on" and
    // undefined is what a broken extractor returns. Keeping them distinct is
    // what makes the first case a decision rather than an accident.
    for (const shape of ['cus_x', { id: 'cus_y' }]) {
      expect(eventCustomerId(asEvent(shape))).not.toBeUndefined();
    }
  });
});
