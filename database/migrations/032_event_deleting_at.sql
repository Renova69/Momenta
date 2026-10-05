-- 032 — An album being deleted accepts no new media (N-47)
--
-- DELETE /api/events takes a snapshot of an album's media, deletes the files
-- one by one, then deletes the rows. Nothing stopped an upload, an FTP ingest
-- or a reveal promotion from writing new media in between. Such a photo lost
-- its row to the purge or the cascade but kept its file: publicly reachable on
-- R2, and left under the served /uploads directory locally.
--
-- The route now stamps this column, under the album's upload lock, before it
-- takes the snapshot. Every upload re-checks the album under that same lock
-- and refuses one being deleted, cleaning up the files it saved; the reveal
-- promotion skips it. NULL on every album not being deleted. If the purge
-- fails, the route clears it again, because the album is still there.
ALTER TABLE events ADD COLUMN IF NOT EXISTS deleting_at TIMESTAMPTZ;

COMMENT ON COLUMN events.deleting_at IS
  'Set when the host has asked for this album to be deleted and its media is being purged. No upload, ingest or promotion writes media for it. NULL otherwise.';
