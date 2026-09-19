-- 028 — Quest leaderboard on the TV wall, by the host's choice
--
-- The TV wall is a photo album first. The quest leaderboard appears there, in
-- a narrow column beside the photos, only when the host switches it on, so it
-- defaults to off and every existing event keeps a wall of photos alone.
--
-- Public on purpose: the wall is an unauthenticated screen at the venue, so
-- the flag reaches it through PUBLIC_EVENT_COLUMNS, and a change reaches a
-- wall already running through the EVENT_UPDATED broadcast.

ALTER TABLE events ADD COLUMN IF NOT EXISTS show_tv_leaderboard BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN events.show_tv_leaderboard IS
  'Host choice: show the quest leaderboard in a side column on the TV wall. Off by default; the wall is a photo album first.';
