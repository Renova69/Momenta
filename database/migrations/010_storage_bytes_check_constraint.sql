-- ====================================================================
-- Migration: 010_storage_bytes_check_constraint.sql
-- Project: WedMoments
--
-- SEC-D2 — nothing stopped storage_bytes going negative. The trigger from
-- migration 008 (update_event_storage_bytes) already clamps its own writes
-- to events.storage_bytes with GREATEST(0, ...), but that only protects the
-- running total on `events`; the per-row counters on `photos` and
-- `audio_guestbook` had no floor at all, and neither had a ceiling against
-- silently going negative from a bug in some future code path (a delete
-- that fires the trigger twice, an update computing a byte count wrong).
-- A CHECK constraint makes the invariant the accounting logic already
-- assumes into one the database itself enforces.
--
-- `ADD CONSTRAINT IF NOT EXISTS` is not valid PostgreSQL syntax (unlike
-- `ADD COLUMN IF NOT EXISTS`) — idempotency here follows the same
-- DO-block-plus-exception pattern migration 003 already uses for columns.
-- ====================================================================

DO $$ BEGIN
    ALTER TABLE events ADD CONSTRAINT chk_events_storage_bytes_nonneg CHECK (storage_bytes >= 0);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE photos ADD CONSTRAINT chk_photos_storage_bytes_nonneg CHECK (storage_bytes >= 0);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE audio_guestbook ADD CONSTRAINT chk_audio_guestbook_storage_bytes_nonneg CHECK (storage_bytes >= 0);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
