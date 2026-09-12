-- 022 — the public showcase becomes opt-in.
--
-- H6. GET /api/events/showcase/feed returned the six newest events to anyone,
-- carrying host name, venue, date and four preview photos each. There was no
-- `is_public` column anywhere in the schema, so there was nothing a couple
-- could set and nothing the query could filter on: registering an account was
-- consent to being advertised on the landing page, and a paying couple's
-- wedding photos appeared there without anyone ever being asked.
--
-- Default FALSE, and deliberately FALSE for every event that already exists
-- rather than grandfathering them in. Those couples were never asked either,
-- and defaulting them to public would carry the original problem forward under
-- a new column name. The landing page is repopulated below from the seeded
-- demo wedding instead — data the operator owns and can show freely.

ALTER TABLE events ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN events.is_public IS
  'Host opt-in to appearing on the public showcase feed. Defaults false; never set it on a host''s behalf.';

-- Partial index: only public events are ever selected this way, and there are
-- few of them, so this stays small and the common case never touches the heap.
CREATE INDEX IF NOT EXISTS idx_events_public_showcase
    ON events(created_at DESC)
    WHERE is_public;

-- The seeded demo wedding (migration 002) is fictional data owned by the
-- operator and attached to the public demo login, so it is the one album that
-- can be shown without asking anyone. This is what keeps the landing page
-- populated now that real weddings are private by default.
UPDATE events
   SET is_public = true
 WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
