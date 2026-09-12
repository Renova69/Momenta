-- Dunning grace window for recurring subscriptions.
--
-- When a Pro Planner card fails, Stripe marks the subscription `past_due` and
-- starts its own retry schedule, which runs for about a week before it gives
-- up and cancels. Downgrading on the first failed charge would cut off a
-- paying customer whose card succeeds two days later — and possibly mid-event,
-- which is the worst moment this product has.
--
-- So `past_due` keeps the tier and stamps a deadline here instead. Recovery
-- clears it; passing it downgrades. The webhook applies whichever it sees
-- first, and scripts/subscription-grace-sweep.ts is the safety net for the
-- case where Stripe's dunning ends without another event ever arriving.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS past_due_grace_expiry TIMESTAMPTZ;

-- The sweep looks for exactly one thing: active rows whose grace has run out.
-- A partial index keeps that scan proportional to the number of accounts
-- actually in dunning, not to the whole subscriptions table.
CREATE INDEX IF NOT EXISTS idx_subscriptions_past_due_grace_expiry
  ON subscriptions(past_due_grace_expiry)
  WHERE past_due_grace_expiry IS NOT NULL;
