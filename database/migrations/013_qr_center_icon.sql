-- The QR poster's center icon used to be a single hardcoded image hotlinked
-- from an external CDN (flaticon.com). That CDN doesn't send permissive CORS
-- headers, so the live on-screen preview showed it fine (a plain <img>/<image>
-- render never enforces CORS) but the PNG/PDF export — which rasterizes the
-- poster into a <canvas> via html2canvas — silently dropped it, leaving a
-- clean excavated hole in the QR code with nothing drawn inside it. Storing a
-- selectable, locally-bundled icon key instead of a hotlinked URL fixes the
-- export and lets a host pick which icon they want.
ALTER TABLE qr_canvas_configs
  ADD COLUMN IF NOT EXISTS center_icon TEXT NOT NULL DEFAULT 'heart';
