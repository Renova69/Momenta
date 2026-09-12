-- ====================================================================
-- Migration: 011_host_delete_cascade.sql
-- Project: WedMoments
--
-- SEC-D7 — events.host_user_id was ON DELETE SET NULL. Deleting a host
-- account did not delete their events; it just orphaned them, host_user_id
-- going NULL while the event (and every guest/photo/quest/audio row under
-- it, all of which already cascade from `events`) stayed live and public
-- forever with nobody able to manage it.
--
-- No account-deletion feature exists in this app yet, so this FK was never
-- actually reachable — but the policy itself was wrong and would silently
-- create zombie events the moment one gets built. Switching to CASCADE
-- means deleting a user cleanly removes everything under their events too,
-- consistent with how every child table under `events` already behaves.
--
-- DROP CONSTRAINT IF EXISTS is valid Postgres syntax (unlike
-- ADD CONSTRAINT IF NOT EXISTS), so this migration is naturally idempotent
-- without the DO-block workaround migrations 003/010 needed for ADD-only
-- changes.
-- ====================================================================

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_host_user_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_host_user_id_fkey
    FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE;
