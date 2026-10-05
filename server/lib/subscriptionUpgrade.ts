import { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { errorLabel } from './errors';
import { BackendPlanTier } from '../middleware/tierGate';
import { TIER_WEIGHTS } from '../../shared/planCaps';
import { refreshExpiryDates } from './retention';
import { isPaidTier, PAID_TIER_PRICING } from './stripePlans';

// Pro Planner pools its allowance across up to 10 concurrent weddings; every
// other tier is single-event. Mirrors the comment on the same number in
// events.ts's event-limit check.
const EVENT_LIMIT_FOR_TIER: Record<BackendPlanTier, number> = {
  free: 1,
  celebration_pass: 1,
  deluxe_keepsake: 1,
  pro_planner: 10,
};

/**
 * The stored tier's rank, as SQL, built from the one table of weights the
 * whole app shares. Inlining the names and numbers keeps the comparison
 * inside the single atomic statement — reading the current tier first and
 * comparing in TypeScript would reopen the race the ON CONFLICT closes — and
 * building the expression from `TIER_WEIGHTS` keeps it from drifting away
 * from the gate that enforces the same order.
 */
function tierRankSql(column: string): string {
  return `CASE ${column} ${Object.entries(TIER_WEIGHTS)
    .map(([name, weight]) => `WHEN '${name}' THEN ${weight}`)
    .join(' ')} ELSE 0 END`;
}

const STORED_TIER_RANK = tierRankSql('subscriptions.tier');

/** The event limit of whichever tier `column` names, as SQL. */
function eventLimitSql(column: string): string {
  return `CASE ${column} ${Object.entries(EVENT_LIMIT_FOR_TIER)
    .map(([name, limit]) => `WHEN '${name}' THEN ${limit}`)
    .join(' ')} ELSE ${EVENT_LIMIT_FOR_TIER.free} END`;
}

/**
 * The tiers sold as one-time passes. Only these are remembered in
 * `one_time_tier` (N-45): Pro Planner is sold monthly, so a row that once held
 * it with billing_type one_time (the pre-Stripe self-serve path) bought no pass.
 */
const ONE_TIME_TIERS = Object.entries(PAID_TIER_PRICING)
  .filter(([, pricing]) => pricing.mode === 'payment')
  .map(([tier]) => tier);

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
   * COALESCE note on the upsert below. Clears any suspension record with it:
   * a plan suspended for non-payment can only be restored through the
   * subscription it lapsed from, and that subscription is now gone.
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
   * Let this write LOWER the tier. Only the self-serve route passes it, for
   * a host choosing "downgrade to free" with no payment involved. Every
   * payment path leaves it off, so a purchase can raise a tier and never
   * take one away.
   */
  allowLowerTier?: boolean;
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
  const tierRank = TIER_WEIGHTS[tier] ?? 0;
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
  // A purchase may raise the tier and must never lower it. A Pro Planner
  // subscriber who buys a one-time Celebration Pass arrives here with the
  // lower tier, and overwriting would take away the plan they are still
  // paying for: 100 GB and ten events down to 10 GB and one, with every
  // album's retention restamped to 90 days by the recompute below. Their
  // Stripe subscription id stays on file either way, so the eventual
  // cancellation of the real subscription would then drop them to free —
  // charging them for a pass and deleting it in the same breath.
  // `billing.ts` refuses that checkout before any money moves; this is the
  // net under it, for a payment that arrives another way (a Stripe dashboard
  // charge, a payment link, a webhook retried out of order).
  // Deliberate downgrades do not come through here — cancellation and
  // terminal failure call applyTierDowngradeToFree, which writes 'free'
  // directly.
  //
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
       stripe_customer_id, stripe_subscription_id, past_due_grace_expiry, one_time_tier
     )
     VALUES ($1, $2, 'active', $3, $4, 'EUR', $5, $6, $7, $10, $13)
     ON CONFLICT (user_id) WHERE status = 'active'
     DO UPDATE SET
       tier = CASE WHEN $12::boolean OR $11::int >= (${STORED_TIER_RANK})
                   THEN EXCLUDED.tier ELSE subscriptions.tier END,
       event_limit = CASE WHEN $12::boolean OR $11::int >= (${STORED_TIER_RANK})
                          THEN EXCLUDED.event_limit ELSE subscriptions.event_limit END,
       billing_type = EXCLUDED.billing_type,
       amount_paid_cents = EXCLUDED.amount_paid_cents,
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = CASE
         WHEN $8::boolean THEN NULL
         ELSE COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id)
       END,
       -- A suspension belongs to the subscription it lapsed from: gone when
       -- that subscription is cleared, and gone when a different one takes
       -- its place. Otherwise the new subscription's own dunning would be
       -- ignored as "already suspended".
       lapsed_tier = CASE
         WHEN $8::boolean THEN NULL
         WHEN EXCLUDED.stripe_subscription_id IS NOT NULL
          AND EXCLUDED.stripe_subscription_id IS DISTINCT FROM subscriptions.stripe_subscription_id THEN NULL
         ELSE subscriptions.lapsed_tier
       END,
       -- N-45: remember the best one-time pass bought, so a subscription bought
       -- on top of it can end without taking it away.
       one_time_tier = CASE
         WHEN EXCLUDED.one_time_tier IS NOT NULL
          AND (${tierRankSql('EXCLUDED.one_time_tier')}) > (${tierRankSql('subscriptions.one_time_tier')})
         THEN EXCLUDED.one_time_tier ELSE subscriptions.one_time_tier
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
      tierRank,
      options.allowLowerTier === true,
      billingType === 'one_time' && ONE_TIME_TIERS.includes(tier) ? tier : null,
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
  await refreshExpiriesAfterTierChange(userId, db, options.db !== undefined);

  return result.rows[0];
}

/**
 * A failure here must not fail the tier change itself when the tier write has
 * already committed on its own — so on the pool it is logged, not thrown.
 * Inside a caller's transaction the opposite is true: the tier write has NOT
 * committed yet, and swallowing the error would commit a tier whose retention
 * deadlines were never recomputed. There, let it propagate and roll the whole
 * thing back — Stripe will retry the webhook.
 */
async function refreshExpiriesAfterTierChange(
  userId: string,
  db: Pool | PoolClient,
  inCallerTransaction: boolean
): Promise<void> {
  try {
    await refreshExpiryDates(userId, db);
  } catch (err) {
    if (inCallerTransaction) throw err;
    console.error('[Subscriptions] expires_at refresh after tier change failed:', errorLabel(err));
  }
}

/**
 * Downgrades a user back to the free tier — used when a Stripe subscription
 * is cancelled or a payment fails terminally. The subscription id is cleared
 * explicitly: that Stripe subscription is genuinely gone, and leaving a stale
 * id behind would make it a false match for a later webhook lookup. The
 * customer id is deliberately kept, so a returning customer re-uses their
 * existing Stripe customer record rather than creating a duplicate.
 *
 * N-45 — "free" unless the account holds a one-time pass under the
 * subscription that ended. That pass was paid for separately and outlives it.
 * Read then written, so a caller racing another write for this account must
 * hold the webhook's per-customer lock, which is the only caller.
 */
export async function applyTierDowngradeToFree(
  userId: string,
  db?: Pool | PoolClient
): Promise<void> {
  const { rows } = await (db ?? pool).query(
    "SELECT one_time_tier FROM subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1",
    [userId]
  );
  const heldPass = rows[0]?.one_time_tier as string | undefined;
  const fallbackTier: BackendPlanTier = isPaidTier(heldPass) ? heldPass : 'free';

  await applyTierUpgrade(userId, fallbackTier, {
    billingType: 'one_time',
    amountPaidCents: 0,
    clearStripeSubscriptionId: true,
    // A cancellation is the one lowering that is meant: the plan is gone.
    // Purchases never pass this.
    allowLowerTier: true,
    // Whatever dunning window was open is moot once the plan is gone; leaving
    // it set would strand a stale deadline on a free account for the grace
    // sweep to keep finding.
    pastDueGraceExpiry: null,
    db,
  });
}

/**
 * Suspends a plan whose payment has failed for good: the grace window ran out,
 * or Stripe marked the subscription `unpaid`. Returns false when there was no
 * paid plan to suspend.
 *
 * N-35 — this is not a cancellation, and used to be treated as one. Stripe is
 * still retrying the card and the subscription is still live there, so the
 * stored subscription id stays on file: it is what a later payment is matched
 * against, and what stops checkout opening a second subscription beside this
 * one. The tier drops to free, or to a one-time pass the account still holds
 * (N-45), so the plan stops being used without being paid for, and the tier it held is kept in `lapsed_tier` so a recovery can put it
 * back (restoreLapsedTier). One statement, so the sweep — which runs outside
 * any transaction — cannot leave the tier dropped and the record unwritten.
 */
export async function suspendTierForNonPayment(
  userId: string,
  db?: Pool | PoolClient,
  options: {
    /**
     * Suspend only if the grace deadline is still set and past. For the grace
     * sweep, which works from a list made before it gets to each account and
     * holds no lock: a renewal handled in between clears the deadline, and
     * suspending then would leave a paying customer on free for a month.
     */
    onlyIfGraceExpired?: boolean;
  } = {}
): Promise<boolean> {
  const client = db ?? pool;
  const result = await client.query(
    // Down to the one-time pass the account holds, if any, not to free (N-45).
    `UPDATE subscriptions
        SET lapsed_tier = tier,
            tier = COALESCE(one_time_tier, 'free'),
            event_limit = ${eventLimitSql("COALESCE(one_time_tier, 'free')")},
            past_due_grace_expiry = NULL, updated_at = NOW()
      WHERE user_id = $1 AND status = 'active' AND tier <> COALESCE(one_time_tier, 'free')
        AND (NOT $2::boolean OR (past_due_grace_expiry IS NOT NULL AND past_due_grace_expiry < NOW()))`,
    [userId, options.onlyIfGraceExpired === true]
  );
  if ((result.rowCount ?? 0) === 0) return false;

  await refreshExpiriesAfterTierChange(userId, client, db !== undefined);
  return true;
}

/**
 * Restores a plan suspended for non-payment, when a payment arrives on the
 * subscription it lapsed from. Returns false, and changes nothing, unless this
 * account is suspended and `subscriptionId` is the one on file — a payment on
 * any other subscription says nothing about this plan.
 *
 * Reads then writes, so it must run inside the webhook's transaction, under
 * the per-customer lock that serialises every event for this account.
 */
export async function restoreLapsedTier(
  userId: string,
  subscriptionId: string,
  options: { amountPaidCents?: number; db: PoolClient }
): Promise<boolean> {
  const { rows } = await options.db.query(
    `SELECT lapsed_tier FROM subscriptions
      WHERE user_id = $1 AND status = 'active'
        AND lapsed_tier IS NOT NULL AND stripe_subscription_id = $2`,
    [userId, subscriptionId]
  );
  const lapsedTier = rows[0]?.lapsed_tier as string | undefined;
  if (!isPaidTier(lapsedTier)) return false;

  await applyTierUpgrade(userId, lapsedTier, {
    billingType: 'monthly',
    amountPaidCents: options.amountPaidCents,
    pastDueGraceExpiry: null,
    db: options.db,
  });
  await options.db.query("UPDATE subscriptions SET lapsed_tier = NULL WHERE user_id = $1 AND status = 'active'", [
    userId,
  ]);
  return true;
}
