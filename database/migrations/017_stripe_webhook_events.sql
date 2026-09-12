-- Idempotency ledger for Stripe webhooks.
--
-- Stripe re-delivers an event on any non-2xx response, and server/routes/
-- billingWebhook.ts deliberately answers 500 on a transient DB failure so
-- that retry actually happens. Without a record of what has already been
-- applied, every retry re-runs the handler: amount_paid_cents gets
-- overwritten with a repeat charge's total, and there is no audit trail of
-- which Stripe events were ever acted on.
--
-- The handler claims an event id here BEFORE doing any work and deletes the
-- claim again if the work throws, so a genuine failure is still retryable
-- while a duplicate delivery of an event already applied is a no-op.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rows here are only useful for as long as Stripe might still retry an event
-- (its retry window is days, not months). This index is what makes pruning
-- old rows cheap: DELETE FROM stripe_webhook_events WHERE received_at < NOW() - INTERVAL '90 days';
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received_at
  ON stripe_webhook_events(received_at);
