-- 030 — Public demo logins cannot put anything on the landing page (N-40)
--
-- Migration 022 made the seeded demo wedding the one album on the public
-- showcase, "owned by the operator". It is owned by the demo couple login,
-- whose password ships in the client bundle (src/services/authService.ts), and
-- it takes unmoderated anonymous uploads. So anyone could upload anything to
-- the landing page, or sign in as its host and change its title, cover and
-- welcome text.
--
-- The demo logins are now marked, and the showcase leaves out every album a
-- demo account owns (server/routes/events/crud.ts). Unpublishing the seed
-- alone would not hold: anyone signed in as the demo host can switch it back
-- on. The landing page shows its static sample weddings when the feed is
-- empty, so it does not go blank.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_demo IS
  'A demo login whose credentials are public. Nothing such an account owns may appear on the public showcase.';

-- The two demo logins seeded by migration 007.
UPDATE users
   SET is_demo = true
 WHERE id IN ('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02');

UPDATE events
   SET is_public = false
 WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
