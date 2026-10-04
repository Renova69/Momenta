-- 029 — A plan suspended for non-payment, rather than ended (N-35)
--
-- When a Pro Planner card failed and the grace window (migration 018) ran
-- out, the account was dropped to free the same way a cancellation drops it:
-- tier to free, stripe_subscription_id cleared. But running out of grace is
-- not a cancellation. Stripe is still retrying the card, the subscription is
-- still live, and when a retry succeeds the money arrives. With the plan
-- erased and the id gone, that payment refreshed nothing, the subscription
-- went on charging every month for a free account, and checkout would open a
-- second subscription beside it.
--
-- So an unpaid plan is now suspended: the tier drops to free, the Stripe
-- subscription id stays on file, and the tier it held is recorded here. A
-- payment on that same subscription restores it. A real cancellation clears
-- both, which is what ends a plan for good.
--
-- NULL on every row that is not suspended, which is every row today.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS lapsed_tier VARCHAR(50);

COMMENT ON COLUMN subscriptions.lapsed_tier IS
  'The paid tier this account held before it was suspended for non-payment, or NULL. Restored by a payment on the stored stripe_subscription_id; cleared when that subscription ends.';
