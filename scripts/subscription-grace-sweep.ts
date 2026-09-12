/**
 * Dunning grace enforcement.
 *
 *   npm run grace:report   — list accounts whose past_due grace has run out
 *   npm run grace:sweep    — the same, then downgrade them to free
 *
 * The safety net for the webhook's grace window (migration 018). When a card
 * fails, Stripe marks the subscription `past_due` and the webhook keeps the
 * tier alive with a deadline. Normally Stripe's dunning ends with an event —
 * a recovery, or a cancellation — and the webhook acts on it.
 *
 * Normally. A dunning cycle can end without another subscription event ever
 * arriving, and a webhook delivery can be missed outright. Then nothing would
 * ever revisit that deadline and the account keeps a plan it stopped paying
 * for, indefinitely. This closes that gap without depending on Stripe.
 *
 * Downgrading only happens with GRACE_ENFORCED=true, matching
 * retention-sweep.ts: taking a plan away is never a side effect of running a
 * report. Run from cron; hourly is plenty, daily is fine.
 */
import { pool } from '../server/lib/db';
import { applyTierDowngradeToFree } from '../server/lib/subscriptionUpgrade';
import { errorLabel } from '../server/lib/errors';

const enforce = process.env.GRACE_ENFORCED === 'true';

interface ExpiredGraceRow {
  user_id: string;
  email: string;
  tier: string;
  past_due_grace_expiry: string;
}

async function loadExpired(): Promise<ExpiredGraceRow[]> {
  const { rows } = await pool.query(
    `SELECT s.user_id, u.email, s.tier, s.past_due_grace_expiry
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
        AND s.tier <> 'free'
        AND s.past_due_grace_expiry IS NOT NULL
        AND s.past_due_grace_expiry < NOW()
      ORDER BY s.past_due_grace_expiry`
  );
  return rows;
}

async function main(): Promise<void> {
  const expired = await loadExpired();

  console.log('');
  console.log(`Subscription grace sweep — ${expired.length} account(s) past their deadline`);
  console.log(enforce ? 'Mode: ENFORCING (accounts will be downgraded)' : 'Mode: report only (set GRACE_ENFORCED=true to downgrade)');
  console.log('');

  if (expired.length === 0) {
    console.log('  (none)');
    console.log('');
    return;
  }

  for (const row of expired) {
    console.log(
      `  ${row.email.padEnd(38).slice(0, 38)}  ${row.tier.padEnd(17)}  grace ended ${row.past_due_grace_expiry
        .toString()
        .slice(0, 10)}`
    );
  }
  console.log('');

  if (!enforce) return;

  let downgraded = 0;
  for (const row of expired) {
    try {
      // One account's failure must not abandon the rest of the sweep.
      await applyTierDowngradeToFree(row.user_id);
      downgraded += 1;
      console.log(`  downgraded ${row.email}`);
    } catch (err) {
      console.error(`  FAILED to downgrade ${row.email}:`, errorLabel(err));
    }
  }

  console.log('');
  console.log(`Downgraded ${downgraded}/${expired.length}.`);
  console.log('');
}

main()
  .catch((err) => {
    console.error('[grace-sweep] failed:', errorLabel(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
