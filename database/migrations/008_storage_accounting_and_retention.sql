-- ====================================================================
-- Migration: 008_storage_accounting_and_retention.sql
-- Project: WedMoments
--
-- The plans sell storage quotas (500 MB / 10 GB / 25 GB / 100 GB) and
-- retention windows (7 days / 3 months / 12 months / ongoing), but nothing
-- measured bytes or expiry. `subscriptions.storage_limit_gb` and
-- `subscriptions.expires_at` existed as columns that no code read.
--
-- This migration adds the measurements those promises depend on:
--   1. Per-object byte accounting for photos and audio.
--   2. A running per-event total, maintained by triggers (the same pattern
--      already used for likes_count and comments_count).
--   3. A retention deadline per event.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Per-object byte accounting
-- --------------------------------------------------------------------
-- storage_bytes is the total footprint of every derivative kept for this
-- row: original + display copy + thumbnail for a photo, the recording for
-- an audio entry.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS storage_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE audio_guestbook ADD COLUMN IF NOT EXISTS storage_bytes BIGINT NOT NULL DEFAULT 0;

-- Best-effort backfill. Photos created before migration 007 have no recorded
-- size at all, so an event's historical total under-reports until those rows
-- are re-measured; `npm run storage:recount` exists for that.
UPDATE photos
   SET storage_bytes = COALESCE(original_bytes, 0)
 WHERE storage_bytes = 0
   AND original_bytes IS NOT NULL;

-- --------------------------------------------------------------------
-- 2. Running per-event total
-- --------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS storage_bytes BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN events.storage_bytes IS
  'Running total of photo and audio bytes for this event, maintained by trigger. Read it instead of summing on every upload.';

CREATE OR REPLACE FUNCTION update_event_storage_bytes()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE events
           SET storage_bytes = storage_bytes + NEW.storage_bytes
         WHERE id = NEW.event_id;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE events
           SET storage_bytes = GREATEST(0, storage_bytes - OLD.storage_bytes)
         WHERE id = OLD.event_id;
    ELSIF (TG_OP = 'UPDATE' AND NEW.storage_bytes IS DISTINCT FROM OLD.storage_bytes) THEN
        UPDATE events
           SET storage_bytes = GREATEST(0, storage_bytes - OLD.storage_bytes + NEW.storage_bytes)
         WHERE id = NEW.event_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_photos_storage_bytes
    AFTER INSERT OR UPDATE OR DELETE ON photos
    FOR EACH ROW
    EXECUTE PROCEDURE update_event_storage_bytes();

CREATE OR REPLACE TRIGGER trg_audio_storage_bytes
    AFTER INSERT OR UPDATE OR DELETE ON audio_guestbook
    FOR EACH ROW
    EXECUTE PROCEDURE update_event_storage_bytes();

-- Seed the running totals from what is already stored.
UPDATE events e
   SET storage_bytes = COALESCE(p.total, 0) + COALESCE(a.total, 0)
  FROM (SELECT id FROM events) src
  LEFT JOIN (
        SELECT event_id, SUM(storage_bytes) AS total FROM photos GROUP BY event_id
      ) p ON p.event_id = src.id
  LEFT JOIN (
        SELECT event_id, SUM(storage_bytes) AS total FROM audio_guestbook GROUP BY event_id
      ) a ON a.event_id = src.id
 WHERE e.id = src.id;

-- --------------------------------------------------------------------
-- 3. Retention deadline
-- --------------------------------------------------------------------
-- The archive window starts when the celebration is over, not when the album
-- was created, so a couple who set the album up months in advance does not
-- lose time. NULL means "keep indefinitely" (Pro Planner, or not yet set).
ALTER TABLE events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS retention_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_expires_at ON events(expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN events.expires_at IS
  'When this album becomes eligible for deletion. NULL keeps it indefinitely. Deletion is opt-in via RETENTION_ENFORCED.';
