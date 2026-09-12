-- 024 — notice before deletion (D1), and a real erasure path (D2).
--
-- ============================================================
-- D1: an album may not be deleted until its host has been told
-- ============================================================
--
-- `sweepExpiredAlbums(enforce = true)` deleted media the moment an album passed
-- `expires_at` plus the 30-day grace period. Nobody was ever told. Destroying a
-- customer's irreplaceable photos with no warning is not a defensible default
-- at any scale, and "we sent the retention policy in the T&Cs" is not notice.
--
-- This app has no mailer — no nodemailer, no provider SDK, nothing. So notice
-- cannot be sent today, which means enforcement cannot responsibly be switched
-- on today either. That was already true; it was just recorded as prose in
-- OPEN_ITEMS.md D1, where a flipped environment variable would sail straight
-- past it.
--
-- So it becomes a column instead. `sweepExpiredAlbums` now refuses to delete an
-- album whose `retention_notified_at` is null or too recent. Nothing sets this
-- column yet, so RETENTION_ENFORCED=true currently deletes **nothing** — the
-- guard is what makes enabling it safe by construction rather than by
-- remembering. When a mailer is added, the thing that sends the warning stamps
-- this column, and deletion starts working on its own.
ALTER TABLE events ADD COLUMN IF NOT EXISTS retention_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN events.retention_notified_at IS
  'When the host was warned this album is due for deletion. The retention sweep will not delete an album until this is set and has aged past the notice period. Set it only when a warning was genuinely sent.';

-- The sweep asks "expired, past grace, and notified?" — a partial index keeps
-- that cheap without carrying every row that has never been notified.
CREATE INDEX IF NOT EXISTS idx_events_retention_notified
    ON events(retention_notified_at)
    WHERE retention_notified_at IS NOT NULL;

-- ============================================================
-- D2: deleting an event, and keeping a record that it happened
-- ============================================================
--
-- There was no way to delete an event at all — no DELETE handler anywhere — so
-- there was no erasure path, which is a GDPR Article 17 problem for a service
-- holding photographs of identifiable people alongside their names and table
-- numbers.
--
-- The audit row deliberately outlives the event. It records that a deletion
-- happened and who asked for it, without keeping the content that was deleted:
-- no photos, no guest names, no host email. `host_user_id` is ON DELETE SET
-- NULL so closing an account later does not erase the fact that this deletion
-- occurred, while still detaching it from the person.
CREATE TABLE IF NOT EXISTS event_deletions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       UUID NOT NULL,
    slug           VARCHAR(160) NOT NULL,
    host_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    photos_deleted INT NOT NULL DEFAULT 0,
    bytes_freed    BIGINT NOT NULL DEFAULT 0,
    deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE event_deletions IS
  'One row per deleted event. Deliberately holds no personal content — enough to answer "was this album deleted, when, and at whose request", and nothing more.';

CREATE INDEX IF NOT EXISTS idx_event_deletions_host ON event_deletions(host_user_id, deleted_at DESC);
