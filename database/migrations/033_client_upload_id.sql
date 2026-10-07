-- 033 — A replayed upload is stored once (N-78)
--
-- A guest's phone queues a photo or voice message it could not send, and
-- sends it again later. When the server had stored the first attempt but its
-- answer never reached the phone (the venue Wi-Fi dropped mid-response), the
-- replay arrived as a new upload and was stored a second time: the same
-- photo twice in the album, on the wall, and against the plan's allowance.
--
-- The phone names each upload with an id of its own (`localId`). It is kept
-- here, and a second upload carrying the same id from the same guest returns
-- the row already stored. The unique index is what settles two copies
-- arriving at once. NULL for uploads that carried no id, which the index
-- leaves alone.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS client_upload_id TEXT;
ALTER TABLE audio_guestbook ADD COLUMN IF NOT EXISTS client_upload_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_client_upload
  ON photos (event_id, guest_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_client_upload
  ON audio_guestbook (event_id, guest_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

COMMENT ON COLUMN photos.client_upload_id IS
  'The id the uploading device gave this upload, so a replay of it returns this row instead of storing a duplicate. NULL if the device sent none.';
COMMENT ON COLUMN audio_guestbook.client_upload_id IS
  'The id the uploading device gave this recording, so a replay of it returns this row instead of storing a duplicate. NULL if the device sent none.';
