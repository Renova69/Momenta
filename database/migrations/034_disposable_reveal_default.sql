-- 034 — A disposable album with no reveal time hid nothing (N-109)
--
-- The host's disposable-camera toggle set is_disposable_mode and never
-- reveal_at. Every check that hides a locked photo asks whether reveal_at is
-- still ahead, so with it NULL the album counted as already revealed: each
-- "locked" photo was published to every guest, the TV wall and the public
-- showcase, while the guest who took it was told it would be revealed the
-- morning after.
--
-- The toggle now sets the reveal it promises, 09:00 in Sofia the morning
-- after the wedding (server/routes/events/shared.ts, morningAfterSql). This
-- gives albums already in that state the same reveal. For a wedding already
-- past it is in the past, and nothing changes; for one still to come, the
-- photos taken so far are hidden from guests until then.
UPDATE events
   SET reveal_at = ((date_trunc('day', event_date AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day 9 hours') AT TIME ZONE 'Europe/Sofia')
 WHERE is_disposable_mode
   AND reveal_at IS NULL;
