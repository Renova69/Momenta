-- 035 — Poster text the host did not write is not English (N-117)
--
-- qr_canvas_configs.headline and .subtext defaulted to English ("Capture the
-- Love", "Scan the QR code with your phone camera…"), the qr-config route
-- answered with the same text when nothing was saved, and a save that changed
-- only the headline stored an English instruction. The studio prefers what
-- the server sends over its own translated default, so a Bulgarian couple's
-- table cards printed English.
--
-- Text the host did not write is now NULL, and the studio fills it in the
-- language it is showing. Rows still holding one of those defaults never had
-- that text chosen; they are cleared the same way.
ALTER TABLE qr_canvas_configs ALTER COLUMN headline DROP DEFAULT;
ALTER TABLE qr_canvas_configs ALTER COLUMN subtext DROP DEFAULT;

UPDATE qr_canvas_configs SET headline = NULL WHERE headline = 'Capture the Love';
UPDATE qr_canvas_configs
   SET subtext = NULL
 WHERE subtext IN (
   'Scan the QR code with your phone camera to share your photos and messages to our live wedding gallery.',
   'Scan the QR code with your phone camera to share your photos.'
 );
