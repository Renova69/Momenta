-- 027 — Quest Grand Prize Announcement
--
-- Lets the host write the prize the scavenger-hunt winner receives, shown to
-- guests above the quest list.
--
-- NULL means "use the default", which lives in the client translations under
-- `quests.default_prize` and therefore exists in both languages. The default
-- is deliberately not duplicated here: a copy in a SQL comment cannot be kept
-- in step with the translation tables, and this file has already been through
-- one encoding round-trip that destroyed the Bulgarian text and its emoji.
--
-- Host-authored text, rendered to every guest. It reaches the client through
-- PUBLIC_EVENT_COLUMNS and is escaped by React on the way out; the length cap
-- is enforced by UpdateEventSchema (500 characters) rather than by the column,
-- so an existing row can never become invalid by tightening it.

ALTER TABLE events ADD COLUMN IF NOT EXISTS quest_prize TEXT;

COMMENT ON COLUMN events.quest_prize IS
  'Host-authored grand prize announcement for the scavenger quests. NULL means the client renders its own localized default (quests.default_prize).';
