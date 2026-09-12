-- Stripe identifiers on the subscription row, so a webhook event (which only
-- carries Stripe's own customer/subscription IDs) can be traced back to the
-- account it belongs to, and so a recurring Pro Planner subscription can be
-- looked up again later (cancellation, plan change, dunning).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id
  ON subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
