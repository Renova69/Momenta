import { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { errorLabel } from './errors';
import { BackendPlanTier } from '../middleware/tierGate';
import { refreshExpiryDates } from './retention';

// Pro Planner pools its allowance across up to 10 concurrent weddings; every
// other tier is single-event. Mirrors the comment on the same number in
// events.ts's event-limit check.
const EVENT_LIMIT_FOR_TIER: Record<BackendPlanTier, number> = {
  free: 1,
  celebration_pass: 1,
  deluxe_keepsake: 1,
  pro_planner: 10,
};

export interface TierUpgradeResult {
  id: string;
  tier: BackendPlanTier;
  status: string;
  event_limit: number;
}

export interface TierUpgradeOptions {
  /** Matches the existing subscriptions.billing_type convention: 'one_time' | 'monthly' | 'annual'. */
  billingType?: 'one_time' | 'monthly' | 'annual';
  amountPaidCents?: number;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  /**
   * Blank out any stored Stripe subscription id instead of keeping it.
   * Omitting a subscription id and *wanting it gone* are different
   * intentions, and only a cancellation means the latter — see the
   * COALESCE note on the upsert below.
   */
  clearStripeSubscriptionId?: boolean;
  /**
   * Deadline after which a `past_due` subscription loses its tier, or `null`
   * to clear a grace window that no longer applies (payment recovered, plan
   * cancelled outright). Left undefined, any existing deadline is preserved —
   * the same "absent is not the same as cleared" rule the Stripe id columns
   * follow. See migration 018.
   */
  pastDueGraceExpiry?: Date | null;
  /**
   * Run against an open transaction instead of the pool. The Stripe webhook
   * passes its transaction client so the tier write, the expiry recompute and
   * the event-idempotency claim all commit or roll back as one unit.
   */
  db?: Pool | PoolClient;
}

/**
 * Sets a user's plan tier for real — shared by the direct self-serve route
 * (server/routes/subscriptions.ts, kept as a fallback while Stripe keys
 * aren't configured yet) and the Stripe webhook (server/routes/billing.ts,
 * the real path once they are). Both must behave identically: same
 * atomic upsert, same expires_at recompute, same event limit per tier.
 */
export async function applyTierUpgrade(
  userId: string,
  tier: BackendPlanTier,
  options: TierUpgradeOptions = {}
): Promise<TierUpgradeResult> {
  const eventLimit = EVENT_LIMIT_FOR_TIER[tier];
  const billingType = options.billingType || 'one_time';
  const amountPaidCents = options.amountPaidCents ?? 0;
  const db = options.db ?? pool;

  // DB-08: the check-then-branch UPDATE-then-INSERT-if-zero-rows this
  // replaced had a race window between the two statements — two concurrent
  // upgrades on an account with no active row yet (should not happen
  // post-registration, but a fresh account shape or a reactivated
  // subscription both land here) could both see zero rows updated and
  // both attempt the INSERT, and the loser hit an unhandled 500 against
  // the partial UNIQUE(user_id) WHERE status='active' index (migration
  // 009). ON CONFLICT targeting that same partial index is what's actually
  // atomic — its predicate has to match the index's exactly.
  // Both Stripe id columns COALESCE rather than overwrite, for the same
  // reason: a write that simply doesn't carry an id must not erase one
  // already on file. The subscription id used to overwrite unconditionally,
  // which silently broke a real sequence — a Pro Planner subscriber buying a
  // one-time Celebration Pass arrives here from a `mode: 'payment'` session,
  // where session.subscription is null. That nulled the live subscription id,
  // and the later customer.subscription.deleted for that still-real Stripe
  // subscription then had nothing to match on, leaving the account paid
  // forever. Clearing the id is now only ever explicit, via
  // clearStripeSubscriptionId (i.e. an actual cancellation).
  const result = await db.query(
    `INSERT INTO subscriptions (
       user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit,
       stripe_customer_id, stripe_subscription_id, past_due_grace_expiry
     )
     VALUES ($1, $2, 'active', $3, $4, 'EUR', $5, $6, $7, $10)
     ON CONFLICT (user_id) WHERE status = 'active'
     DO UPDATE SET
       tier = EXCLUDED.tier,
       event_limit = EXCLUDED.event_limit,
       billing_type = EXCLUDED.billing_type,
       amount_paid_cents = EXCLUDED.amount_paid_cents,
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = CASE
         WHEN $8::boolean THEN NULL
         ELSE COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id)
       END,
       past_due_grace_expiry = CASE
         WHEN $9::boolean THEN EXCLUDED.past_due_grace_expiry
         ELSE subscriptions.past_due_grace_expiry
       END,
       status = 'active',
       updated_at = NOW()
     RETURNING id, tier, status, event_limit`,
    [
      userId,
      tier,
      billingType,
      amountPaidCents,
      eventLimit,
      options.stripeCustomerId ?? null,
      options.clearStripeSubscriptionId ? null : options.stripeSubscriptionId ?? null,
      options.clearStripeSubscriptionId === true,
      // `undefined` means "leave whatever is there"; an explicit Date or null
      // means "write this". Only the latter touches the column.
      options.pastDueGraceExpiry !== undefined,
      options.pastDueGraceExpiry ?? null,
    ]
  );

  // SEC-05 — an event's expires_at is stamped from the tier active at
  // *creation* and never touched again on its own. Without this, a host
  // upgrading from free (7-day retention) to a paid plan keeps the old,
  // short deadline until someone happens to run the retention report/sweep
  // script — an upgraded couple's photos could still be eligible for
  // deletion under a plan they just paid to extend. refreshExpiryDates()
  // is already safe to call repeatedly (it recomputes from current plans,
  // batched in one statement) and is the same function the sweep script
  // uses; scoped to this user so a burst of concurrent upgrades never
  // means a burst of full-table recomputes.
  //
  // A failure here must not fail the upgrade itself when the tier write has
  // already committed on its own — so on the pool it is logged, not thrown.
  // Inside a caller's transaction the opposite is true: the tier write has
  // NOT committed yet, and swallowing the error would commit a tier whose
  // retention deadlines were never recomputed. There, let it propagate and
  // roll the whole thing back — Stripe will retry the webhook.
  try {
    await refreshExpiryDates(userId, db);
  } catch (err) {
    if (options.db) throw err;
    console.error('[Subscriptions] expires_at refresh after upgrade failed:', errorLabel(err));
  }

  return result.rows[0];
}

/**
 * Downgrades a user back to the free tier — used when a Stripe subscription
 * is cancelled or a payment fails terminally. The subscription id is cleared
 * explicitly: that Stripe subscription is genuinely gone, and leaving a stale
 * id behind would make it a false match for a later webhook lookup. The
 * customer id is deliberately kept, so a returning customer re-uses their
 * existing Stripe customer record rather than creating a duplicate.
 */
export async function applyTierDowngradeToFree(
  userId: string,
  db?: Pool | PoolClient
): Promise<void> {
  await applyTierUpgrade(userId, 'free', {
    billingType: 'one_time',
    amountPaidCents: 0,
    clearStripeSubscriptionId: true,
    // Whatever dunning window was open is moot once the plan is gone; leaving
    // it set would strand a stale deadline on a free account for the grace
    // sweep to keep finding.
    pastDueGraceExpiry: null,
    db,
  });
}
