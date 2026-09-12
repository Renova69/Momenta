-- ====================================================================
-- Migration: 009_subscription_and_slug_integrity.sql
-- Project: WedMoments
--
-- SEC-D5 — nothing stopped a user ending up with two 'active' subscription
-- rows (registration inserts one, and any future upgrade/billing path that
-- inserts instead of updates would add another). getUploadContext and
-- getEffectiveTierForEvent both pick "the" active row with
-- `ORDER BY created_at DESC LIMIT 1`, so a duplicate does not crash anything
-- today — it just makes which tier applies depend on insert order, and
-- retention's join against subscriptions would fan out one row into two.
-- A partial unique index makes the invariant the code already assumes
-- actually hold.
-- ====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_active
  ON subscriptions (user_id)
  WHERE status = 'active';
