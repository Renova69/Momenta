import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import Stripe from 'stripe';
import { pool } from '../lib/db';
import { CONFIG } from '../lib/config';
import { errorLabel } from '../lib/errors';
import { getStripeClient, isStripeConfigured } from '../lib/stripe';
import { applyTierUpgrade, applyTierDowngradeToFree } from '../lib/subscriptionUpgrade';
import {
  PAID_TIER_PRICING,
  PaidPlanTier,
  isPaidTier,
  isPriceMapConfigured,
  tierForPriceId,
} from '../lib/stripePlans';
import { BackendPlanTier } from '../middleware/tierGate';

/**
 * POST /api/billing/webhook — the only place a paid tier is ever actually
 * written. Mounted in server/index.ts with express.raw() BEFORE the global
 * express.json() middleware: Stripe's signature verification needs the exact
 * raw request bytes, which a JSON-parsed-then-restringified body cannot
 * reliably reproduce.
 *
 * Everything here treats the event as untrusted-but-authenticated input: the
 * signature proves Stripe sent it, not that its metadata says what we expect,
 * so every field is re-checked before it turns into a database write.
 */

/**
 * Statuses that mean the subscription is over for good. `past_due` is
 * pointedly absent — it opens a grace window instead (see handleSubscriptionChange).
 * `paused` likewise: Stripe still considers that subscription live.
 */
const ENDED_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'unpaid',
  'incomplete_expired',
]);

/** Statuses where the customer is paid up and any open dunning window is over. */
const HEALTHY_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing']);

/** Claims an event id so a re-delivery is a no-op. False when already claimed. */
async function claimEvent(db: PoolClient, event: Stripe.Event): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO stripe_webhook_events (event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [event.id, event.type]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Serializes every state change for one Stripe customer, across processes.
 *
 * Stripe fans events out concurrently and retries independently, so two
 * deliveries for the same account can be in flight at once — a cancellation
 * and a renewal, say — and the loser's read-then-write would overwrite the
 * winner. A transaction-scoped advisory lock (the same idiom tierGate.ts uses
 * for upload bursts) makes them queue instead. It releases on COMMIT/ROLLBACK,
 * so there is no unlock to forget.
 */
async function lockStripeCustomer(db: PoolClient, customerId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`stripe_customer_${customerId}`]);
}

/** The Stripe customer every one of the handled event types carries, for locking. */
function eventCustomerId(event: Stripe.Event): string | null {
  const object = event.data.object as { customer?: string | { id: string } | null };
  if (!object?.customer) return null;
  return typeof object.customer === 'string' ? object.customer : object.customer.id;
}

async function userIdForSubscriptionId(db: PoolClient, subscriptionId: string): Promise<string | null> {
  const result = await db.query(
    'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [subscriptionId]
  );
  return (result.rows[0]?.user_id as string | undefined) ?? null;
}

async function activeSubscriptionRow(
  db: PoolClient,
  userId: string
): Promise<{ tier: BackendPlanTier; past_due_grace_expiry: Date | null } | null> {
  const result = await db.query(
    "SELECT tier, past_due_grace_expiry FROM subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1",
    [userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Subscription metadata is set from subscription_data at checkout, so it is
 * present for anything this app created. It is absent for a subscription
 * created any other way — from the Stripe Dashboard by hand, or re-created by
 * a Billing Portal plan change — and trusting metadata alone meant those
 * cancellations silently did nothing at all. The stored id is the fallback,
 * which is what migration 016's index exists for.
 */
async function resolveSubscriptionUserId(
  db: PoolClient,
  subscription: Stripe.Subscription
): Promise<string | null> {
  return subscription.metadata?.userId || (await userIdForSubscriptionId(db, subscription.id));
}

/**
 * The invoice's subscription moved between API versions: 2025-and-later
 * payloads nest it under `parent.subscription_details`, earlier ones carry a
 * top-level `subscription`. An event's shape follows the version configured
 * on the webhook endpoint in the Dashboard — which is not the version this
 * SDK is pinned to and is easy to set differently by accident — so read both
 * rather than silently ignoring every renewal on a mismatch.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const nested = invoice.parent?.subscription_details?.subscription;
  if (nested) return typeof nested === 'string' ? nested : nested.id;

  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;

  return null;
}

function sessionSubscriptionId(session: Stripe.Checkout.Session): string | null {
  if (!session.subscription) return null;
  return typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
}

function sessionCustomerId(session: Stripe.Checkout.Session): string | null {
  if (!session.customer) return null;
  return typeof session.customer === 'string' ? session.customer : session.customer.id;
}

/**
 * What the customer actually bought, decided by the Stripe Price they paid.
 *
 * The Price is the authoritative record — it is what the money was charged
 * against — whereas `metadata.tier` is a free-form string editable from the
 * Stripe Dashboard by anyone with access. So when real Price IDs are
 * configured, the Price wins and metadata is only a cross-check: a
 * disagreement means something is wrong (a mis-mapped Price, a hand-edited
 * session, a stale deploy) and is refused rather than guessed at.
 *
 * Without a configured Price map, checkout uses ad-hoc `price_data` and there
 * is no Price to consult, so metadata is all there is. That path still works —
 * it is just the weaker claim, which is why isPriceMapConfigured() is
 * all-or-nothing.
 */
async function resolvePurchasedTier(session: Stripe.Checkout.Session): Promise<PaidPlanTier | null> {
  const metadataTier = session.metadata?.tier;

  if (!isPriceMapConfigured()) {
    if (!isPaidTier(metadataTier)) {
      console.warn(`[Billing] session ${session.id} metadata.tier=${String(metadataTier)} is not a plan this app sells`);
      return null;
    }
    return metadataTier;
  }

  const lineItems = await getStripeClient().checkout.sessions.listLineItems(session.id, { limit: 10 });
  const priceIds = lineItems.data.map((item) => item.price?.id).filter((id): id is string => !!id);
  const tiers = [...new Set(priceIds.map(tierForPriceId).filter((t): t is PaidPlanTier => t !== null))];

  if (tiers.length !== 1) {
    console.warn(
      `[Billing] session ${session.id} resolved ${tiers.length} known tiers from prices [${priceIds.join(', ')}] — ` +
      'refusing to guess which plan was bought'
    );
    return null;
  }

  const tier = tiers[0];
  if (metadataTier != null && metadataTier !== tier) {
    console.error(
      `[Billing] session ${session.id} metadata.tier="${metadataTier}" contradicts the price it was paid against ` +
      `("${tier}") — refusing to grant either. Check the STRIPE_PRICE_* mapping.`
    );
    return null;
  }

  return tier;
}

/**
 * Grants the purchased tier — the one write that turns money into access.
 *
 * Shared by checkout.session.completed and checkout.session.async_payment_succeeded
 * because the paid-check below is what actually gates the grant, not which of
 * the two events carried the session.
 */
async function grantTierFromSession(
  db: PoolClient,
  session: Stripe.Checkout.Session,
  purchasedTier: PaidPlanTier | null
): Promise<void> {
  const userId = session.metadata?.userId || session.client_reference_id;
  if (!userId) {
    console.warn(`[Billing] checkout session ${session.id} carries no userId — ignoring`);
    return;
  }

  // A session completing is NOT proof the money arrived. Delayed-notification
  // payment methods (SEPA Direct Debit above all, which is squarely in scope
  // for EUR pricing) complete the session immediately and settle days later,
  // or fail. Granting on `completed` alone hands out paid tiers for payments
  // that may never clear. The real grant for those arrives separately as
  // checkout.session.async_payment_succeeded, which routes back through here.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    console.info(
      `[Billing] checkout session ${session.id} completed with payment_status=${session.payment_status} — ` +
      'holding the tier until the payment settles'
    );
    return;
  }

  // M7 — already resolved, outside the transaction. See prefetchSessionTier.
  const tier = purchasedTier;
  if (!tier) return;

  await applyTierUpgrade(userId, tier, {
    billingType: session.mode === 'subscription' ? 'monthly' : 'one_time',
    amountPaidCents: session.amount_total ?? PAID_TIER_PRICING[tier].amountCents,
    stripeCustomerId: sessionCustomerId(session),
    stripeSubscriptionId: sessionSubscriptionId(session),
    // A completed purchase settles any dunning window that was open.
    pastDueGraceExpiry: null,
    db,
  });
}

/**
 * A monthly Pro Planner renewal. Without this the tier itself survives (it is
 * never un-set), but retention deadlines do not: an event's expires_at is
 * recomputed only by applyTierUpgrade, so after the first month a paying
 * subscriber's photos would keep drifting toward the expiry stamped at the
 * original upgrade. Re-applying the tier they already hold is what refreshes
 * those dates.
 */
async function handleInvoicePaid(db: PoolClient, invoice: Stripe.Invoice): Promise<void> {
  // Renewals only. subscription_create is already covered by the checkout
  // session, and re-running it here would double-count amount_paid_cents.
  if (invoice.billing_reason !== 'subscription_cycle') return;

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    console.warn(`[Billing] invoice ${invoice.id} has billing_reason=subscription_cycle but no subscription id — ignoring`);
    return;
  }

  const userId =
    invoice.parent?.subscription_details?.metadata?.userId || (await userIdForSubscriptionId(db, subscriptionId));
  if (!userId) {
    console.warn(`[Billing] no account matches subscription ${subscriptionId} for invoice ${invoice.id} — renewal not applied`);
    return;
  }

  // Take the tier from our own record rather than the invoice: the invoice
  // says money arrived, it does not say which plan the account is on, and a
  // renewal never changes the plan anyway.
  const current = await activeSubscriptionRow(db, userId);
  if (!isPaidTier(current?.tier)) {
    console.warn(`[Billing] renewal for subscription ${subscriptionId} but user ${userId} is on tier=${current?.tier} — nothing to refresh`);
    return;
  }

  await applyTierUpgrade(userId, current.tier, {
    billingType: 'monthly',
    amountPaidCents: invoice.amount_paid ?? PAID_TIER_PRICING[current.tier].amountCents,
    stripeSubscriptionId: subscriptionId,
    // Payment recovered — close any grace window the failed charge opened.
    pastDueGraceExpiry: null,
    db,
  });
}

/**
 * Handles both customer.subscription.updated and .deleted.
 *
 * Three outcomes, and the middle one is the point of the grace window:
 *
 *  - terminal status (or `deleted`) → downgrade now.
 *  - `past_due` → keep the tier, stamp a deadline. Stripe is still retrying
 *    the card; cutting a paying customer off on the first failed charge —
 *    possibly mid-wedding — is worse than carrying them for a week. If a
 *    deadline is already set it is left alone, so repeated retry failures
 *    cannot keep pushing it forward indefinitely. Past the deadline, downgrade.
 *  - anything else (`active`, `trialing`, `paused`, `cancel_at_period_end`)
 *    → keep the tier; clear the deadline once healthy again.
 */
async function handleSubscriptionChange(
  db: PoolClient,
  subscription: Stripe.Subscription,
  eventType: string
): Promise<void> {
  const isDeleted = eventType === 'customer.subscription.deleted';
  const hasEnded = isDeleted || ENDED_SUBSCRIPTION_STATUSES.has(subscription.status);
  const needsWrite = hasEnded || subscription.status === 'past_due' || HEALTHY_SUBSCRIPTION_STATUSES.has(subscription.status);
  if (!needsWrite) return;

  const userId = await resolveSubscriptionUserId(db, subscription);
  if (!userId) {
    console.warn(
      `[Billing] subscription ${subscription.id} changed (status=${subscription.status}) but no account matches it ` +
      '— no userId metadata and no stored stripe_subscription_id. Tier NOT changed; check this account by hand.'
    );
    return;
  }

  if (hasEnded) {
    await applyTierDowngradeToFree(userId, db);
    return;
  }

  const current = await activeSubscriptionRow(db, userId);
  if (!isPaidTier(current?.tier)) return;

  if (subscription.status === 'past_due') {
    const existingDeadline = current.past_due_grace_expiry ? new Date(current.past_due_grace_expiry) : null;
    if (existingDeadline && Date.now() > existingDeadline.getTime()) {
      console.warn(
        `[Billing] grace expired for user ${userId} at ${existingDeadline.toISOString()} — downgrading to free`
      );
      await applyTierDowngradeToFree(userId, db);
      return;
    }

    const deadline = existingDeadline ?? new Date(Date.now() + CONFIG.SUBSCRIPTION_GRACE_DAYS * 24 * 60 * 60 * 1000);
    console.warn(
      `[Billing] subscription ${subscription.id} is past_due — keeping ${current.tier} until ${deadline.toISOString()}`
    );
    await applyTierUpgrade(userId, current.tier, { billingType: 'monthly', pastDueGraceExpiry: deadline, db });
    return;
  }

  // Healthy again: drop the deadline so the sweep stops watching this account.
  if (current.past_due_grace_expiry) {
    await applyTierUpgrade(userId, current.tier, { billingType: 'monthly', pastDueGraceExpiry: null, db });
  }
}

async function dispatchEvent(
  db: PoolClient,
  event: Stripe.Event,
  prefetched: PrefetchedEventData
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await grantTierFromSession(db, event.data.object as Stripe.Checkout.Session, prefetched.purchasedTier);
      break;

    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      console.warn(`[Billing] checkout session ${session.id} async payment failed — no tier granted`);
      break;
    }

    case 'invoice.paid':
      await handleInvoicePaid(db, event.data.object as Stripe.Invoice);
      break;

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await handleSubscriptionChange(db, event.data.object as Stripe.Subscription, event.type);
      break;

    default:
      // Deliberately logged rather than passed over in silence. An ignored
      // event is still accepted, claimed and committed, so without this line
      // a correctly-delivered webhook produced no output whatsoever — leaving
      // "did Stripe reach us at all?" answerable only by querying the
      // idempotency ledger, which is a poor way to debug a listener.
      //
      // Ignored types are cheap to log because the endpoint should be
      // subscribed to the six types above and little else. If it is ever
      // pointed at "all events", expect this to be chatty — that is a signal
      // the subscription is too broad, not a reason to remove the line.
      console.info(`[Billing] webhook ${event.id} (${event.type}) has no handler — recorded and ignored`);
      break;
  }
}

/**
 * One transaction per event: take the per-customer lock, claim the event id,
 * apply it. A throw rolls back all three, which un-claims the event for free —
 * no compensating delete to get wrong — and the 500 below tells Stripe to
 * retry. A duplicate delivery finds the claim already taken and commits
 * nothing.
 */
/**
 * Anything that has to be fetched from Stripe to handle this event, gathered
 * BEFORE the transaction opens (M7).
 *
 * resolvePurchasedTier makes a network round trip to Stripe
 * (checkout.sessions.listLineItems). Calling it from inside the transaction
 * meant a pooled connection and the per-customer advisory lock were both held
 * for the duration of that call, so a slow or degraded Stripe stalled every
 * other delivery for the same customer behind it — and Stripe fans events out
 * concurrently and retries independently, which is exactly when that queue
 * forms. Nothing here writes, so there is nothing to roll back if it fails.
 */
interface PrefetchedEventData {
  purchasedTier: PaidPlanTier | null;
}

async function prefetchExternalData(event: Stripe.Event): Promise<PrefetchedEventData> {
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return { purchasedTier: null };
  }

  const session = event.data.object as Stripe.Checkout.Session;
  // Mirrors grantTierFromSession's own gate: an unsettled session grants
  // nothing, so there is no tier to look up and no call worth making.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { purchasedTier: null };
  }

  return { purchasedTier: await resolvePurchasedTier(session) };
}

async function processEvent(event: Stripe.Event, prefetched: PrefetchedEventData): Promise<{ duplicate: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = eventCustomerId(event);
    if (customerId) {
      await lockStripeCustomer(client, customerId);
    }

    if (!(await claimEvent(client, event))) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    await dispatchEvent(client, event, prefetched);
    await client.query('COMMIT');
    return { duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // The connection is already unusable; releasing it below is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function handleStripeWebhook(req: Request, res: Response) {
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  // A missing secret is a server misconfiguration, not a bad request. Stripe
  // stops retrying after a 4xx, so answering 400 here would permanently drop
  // every event that arrived during the gap — including paid checkouts. 503
  // keeps them queued for retry until the secret is actually set.
  if (!CONFIG.STRIPE_WEBHOOK_SECRET) {
    console.error('[Billing] STRIPE_WEBHOOK_SECRET is not set — webhooks cannot be verified');
    return res.status(503).json({ error: 'Webhook secret not configured' });
  }

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(req.body, signature, CONFIG.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('[Billing] webhook signature verification failed:', errorLabel(err));
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    // Outside the transaction, deliberately (M7).
    const prefetched = await prefetchExternalData(event);
    const { duplicate } = await processEvent(event, prefetched);
    if (duplicate) {
      console.info(`[Billing] webhook ${event.id} (${event.type}) already applied — skipping duplicate delivery`);
      return res.json({ received: true, duplicate: true });
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`[Billing] webhook ${event.id} (${event.type}) handling error:`, errorLabel(err));
    // Stripe retries on a non-2xx response — a transient DB error should be
    // retried, not silently swallowed as a 200.
    res.status(500).json({ error: 'Webhook handling failed' });
  }
}
