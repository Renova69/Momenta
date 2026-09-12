-- 020 — let a bulk purge skip per-row storage accounting without DDL.
--
-- H5. purgeEventMedia() (server/lib/retention.ts) deletes every photo and
-- audio row for one event. The FOR EACH ROW trigger below then fires once per
-- row, each firing an UPDATE against the same `events` row — thousands of
-- sequential updates to one tuple for a large album, which is WAL bloat and
-- row-lock contention for a total that is known in advance to end at zero.
--
-- The previous workaround was:
--
--   ALTER TABLE photos DISABLE TRIGGER trg_photos_storage_bytes
--
-- which is correct in its effect and badly wrong in its cost. ALTER TABLE
-- takes an ACCESS EXCLUSIVE lock on the WHOLE table — every event's rows, not
-- just the one being purged — held for the length of the transaction and
-- queued behind any in-flight query. The nightly sweep loops over expired
-- albums, so every live wedding's uploads and feed reads stall once per
-- purged album. It also requires table ownership, so it fails outright under
-- a least-privilege application role.
--
-- Moving the skip inside the trigger function keeps the optimization and
-- drops the lock entirely. `SET LOCAL wedmoments.bulk_purge = 'on'` is
-- transaction-scoped, needs no privilege, takes no lock, and cannot outlive
-- its COMMIT/ROLLBACK — so unlike DISABLE TRIGGER there is no failure mode
-- where accounting is left switched off for every other event.
--
-- current_setting(..., true) returns NULL rather than raising when the
-- setting has never been set, which is the normal case for every ordinary
-- insert, update and delete.

CREATE OR REPLACE FUNCTION update_event_storage_bytes()
RETURNS TRIGGER AS $$
BEGIN
    -- Bulk purge in progress: the caller is removing every row for this event
    -- and sets events.storage_bytes itself, in one statement.
    IF COALESCE(current_setting('wedmoments.bulk_purge', true), 'off') = 'on' THEN
        RETURN NULL;
    END IF;

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

-- Repair state left behind by an older purge that crashed between DISABLE and
-- ENABLE. Both are no-ops when the triggers are already enabled, and this is
-- the last migration that will ever need to touch them this way.
DO $$
BEGIN
    ALTER TABLE photos ENABLE TRIGGER trg_photos_storage_bytes;
    ALTER TABLE audio_guestbook ENABLE TRIGGER trg_audio_storage_bytes;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipping trigger re-enable: not the table owner. This is only needed to repair a crashed pre-020 purge.';
END $$;
