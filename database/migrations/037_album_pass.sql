-- 037 — A one-time pass belongs to one album (N-168, N-169)
--
-- A plan was recorded on the account only, and every album took its deadline
-- from the account's plan and the wedding date. Two things followed. Editing
-- the wedding date moved the deadline, so a host could reopen a closed album
-- without paying (N-168). And a pass bought after the wedding counted its days
-- from the wedding, so a pass for a wedding months gone left the album closed
-- although it had been paid for (N-169).
--
-- The owner's rule (2026-10-18): a one-time pass is for one wedding, and gives
-- its days from the wedding or from the purchase, whichever is later. These
-- columns record which album a pass was bought for and when, so the album
-- keeps what was paid for after the account's pass is used up.
ALTER TABLE events ADD COLUMN IF NOT EXISTS pass_tier VARCHAR(50);
ALTER TABLE events ADD COLUMN IF NOT EXISTS pass_started_at TIMESTAMPTZ;

COMMENT ON COLUMN events.pass_tier IS
  'The one-time pass bought for this album (celebration_pass or deluxe_keepsake), or NULL. The album keeps it after the account''s pass is used up.';
COMMENT ON COLUMN events.pass_started_at IS
  'When that pass was bought. Its days count from the wedding or from this, whichever is later. NULL keeps the wedding as the start.';

-- A pass held today belongs to the account's newest album, which with a limit
-- of one album per pass is the album it was bought for. Its start stays NULL,
-- so no deadline moves.
UPDATE events e
   SET pass_tier = s.one_time_tier
  FROM subscriptions s
 WHERE s.user_id = e.host_user_id
   AND s.status = 'active'
   AND s.one_time_tier IN ('celebration_pass', 'deluxe_keepsake')
   AND e.pass_tier IS NULL
   AND e.id = (SELECT id FROM events newest
                WHERE newest.host_user_id = e.host_user_id
                ORDER BY newest.created_at DESC LIMIT 1);
