-- 021 — make "is this photo still quarantined?" an indexed question.
--
-- H4. A disposable-mode reveal is a passive deadline: `events.reveal_at`
-- simply passes and nothing fires. Promotion out of quarantine therefore
-- happens lazily on the read path, in GET /api/photos — the right trigger,
-- but it was asking the question the most expensive way possible:
--
--   WHERE storage_path      LIKE '%quarantine%'
--      OR original_storage_path LIKE '%quarantine%'
--      OR thumbnail_url     LIKE '%quarantine%'
--
-- A leading wildcard cannot use an index, so this sequentially scanned
-- `photos` on every feed load, by every guest, for every event, forever —
-- not only around a reveal.
--
-- At the reveal itself it got worse: every guest refreshes at once, each
-- request matched the same few hundred rows, and each fanned them out through
-- an unbounded Promise.all of storage copy/delete round trips. The pool is 40
-- connections; it empties, and every HTTP endpoint times out with it. Two
-- callers promoting the same object also race — the loser finds the file
-- already moved and throws.
--
-- A boolean column carries the same fact, is maintained at the two points
-- that actually change it (insert and promotion), and answers in an index
-- scan. The partial index holds only quarantined rows, which is a tiny
-- fraction of the table and empty for most events.

ALTER TABLE photos ADD COLUMN IF NOT EXISTS is_quarantined BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN photos.is_quarantined IS
  'True while this photo''s files live under the quarantine root instead of the publicly-served one (MED-03/SEC-M5). Set at insert for pending/disposable-locked photos, cleared by promotePhotoFromQuarantine.';

-- Backfill from the predicate this replaces, so rows written before this
-- migration are found by the new query. Runs once; the LIKE cost is paid here
-- rather than on every feed load.
UPDATE photos
   SET is_quarantined = true
 WHERE is_quarantined = false
   AND (
         storage_path LIKE '%quarantine%'
      OR original_storage_path LIKE '%quarantine%'
      OR thumbnail_url LIKE '%quarantine%'
   );

-- Partial: only quarantined rows are ever looked up this way, and keeping the
-- index to just those rows makes it small enough to stay cached, while the
-- common "nothing is quarantined" case answers without touching the heap.
CREATE INDEX IF NOT EXISTS idx_photos_quarantined
    ON photos(event_id)
    WHERE is_quarantined;
