-- ====================================================================
-- Migration: 012_guest_cascade_indexes.sql
-- Project: WedMoments
--
-- DB-10 — photo_likes.guest_id, photo_comments.guest_id and
-- audio_guestbook.guest_id all reference guests(id) ON DELETE CASCADE, but
-- none of them were indexed on that column. A guest-row delete (currently
-- unreachable directly, but cascades from a host/event delete, and from
-- guests.ts's own upsert path) would table-scan all three to find the rows
-- to cascade into. photo_likes' existing (photo_id, guest_id) composite
-- index doesn't help a plain guest_id lookup, since guest_id isn't its
-- leading column.
-- ====================================================================

CREATE INDEX IF NOT EXISTS idx_photo_likes_guest ON photo_likes(guest_id);
CREATE INDEX IF NOT EXISTS idx_photo_comments_guest ON photo_comments(guest_id);
CREATE INDEX IF NOT EXISTS idx_audio_guestbook_guest ON audio_guestbook(guest_id);
