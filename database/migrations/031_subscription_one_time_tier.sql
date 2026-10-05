-- 031 — Keep the one-time pass under a subscription bought on top of it (N-45)
--
-- An account has one active subscriptions row, and its `tier` is the plan in
-- force. A host on a one-time pass (Celebration Pass or Deluxe Keepsake) may
-- buy Pro Planner on top of it; the grant overwrote `tier`, and nothing
-- recorded the earlier purchase. When the subscription ended, the account
-- dropped to free, and the pass it had already paid for went with it.
--
-- This column remembers the best one-time pass the account has bought. A
-- subscription that ends, or is suspended for non-payment, now falls back to
-- it instead of to free.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS one_time_tier VARCHAR(50);

COMMENT ON COLUMN subscriptions.one_time_tier IS
  'The best one-time pass this account has bought, or NULL. What the account falls back to when a subscription on top of it ends or is suspended.';

-- A row holding a pass today is the record of buying it. A pass already lost
-- to this bug cannot be recovered: nothing recorded it.
UPDATE subscriptions
   SET one_time_tier = tier
 WHERE status = 'active'
   AND tier IN ('celebration_pass', 'deluxe_keepsake')
   AND one_time_tier IS NULL;
