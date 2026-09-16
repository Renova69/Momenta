import { Buffer } from 'buffer';

export function isValidUuid(id?: string): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ISO-BMFF container brands covering HEIC/HEIF (default photo format on
// modern iPhones) and AVIF (increasingly common on Android). The guest
// upload path always re-encodes the *display*/thumbnail copies to JPEG via
// canvas client-side regardless of source format — sharp only ever decodes
// those — but the *original* is archived as the untouched raw file bytes
// for later high-resolution export, so without recognizing these brands
// here a phone photo saved as HEIC/AVIF had its entire upload rejected at
// this gate before anything else ran.
const ISO_BMFF_IMAGE_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis',
]);

// Image-only magic byte check (JPEG / PNG / GIF / WebP / HEIC-HEIF / AVIF). Used
// by the photographer ingest pipeline, which must reject non-image payloads
// even if the MIME type lies.
export function isImageMagicBytes(buf: Buffer): boolean {
  if (!buf || buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  // HEIC/HEIF/AVIF: ....ftyp<brand>
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    ISO_BMFF_IMAGE_BRANDS.has(buf.toString('ascii', 8, 12))
  ) {
    return true;
  }
  return false;
}

/**
 * ISO-BMFF brands that carry audio or video, as opposed to the still-image
 * brands above. MediaRecorder's MP4 output is the reason this list exists:
 * Safari produces `audio/mp4`, and fragmented output can carry any of the
 * `iso*`/`dash` brands rather than the plain `M4A ` a file-based encoder
 * writes.
 *
 * It is an allowlist rather than "any ftyp" on purpose. HEIC and AVIF are
 * also ftyp containers, so accepting every brand is what let an iPhone photo
 * through the audio guestbook's only content check.
 */
const ISO_BMFF_AV_BRANDS = new Set([
  'M4A ', 'M4B ', 'M4P ', 'M4V ',
  'mp41', 'mp42', 'mmp4',
  'isom', 'iso2', 'iso4', 'iso5', 'iso6',
  'avc1', 'dash', 'msdh', 'msix',
  '3gp4', '3gp5', '3g2a',
  'qt  ',
]);

export interface AudioFormat {
  /** The container as identified from the bytes. */
  container: 'webm' | 'ogg' | 'mp4' | 'mp3';
  /** The type the object is stored and served with. */
  mimeType: string;
  /** The extension the stored filename gets, including the dot. */
  extension: string;
}

/**
 * Which audio container these bytes are, or null if they are not one.
 *
 * The audio guestbook's only content check used to be a shared
 * `validateMagicBytes` that accepted JPEG, PNG, GIF, WebP and *any* ISO-BMFF
 * `ftyp` container — so an image posted to `/api/audio` was admitted, stored
 * against the event's quota, and broadcast to every connected guest as an
 * audio message that no player can play. The four image branches are gone and
 * `ftyp` is now brand-checked (M-3).
 *
 * It returns the format rather than a boolean because the route needs all
 * three answers from one source. The stored object's Content-Type and
 * extension used to come from `req.file.mimetype` — a client-supplied string
 * written verbatim onto the R2 object, which is served from a public URL. A
 * guest could upload genuine Ogg bytes declared as `text/html` and have the
 * bucket serve them back as a document. Deriving both from the bytes that
 * were actually validated removes the disagreement rather than detecting it,
 * and costs nothing: every value below is one of four known-good constants.
 */
export function detectAudioFormat(buf: Buffer): AudioFormat | null {
  if (!buf || buf.length < 4) return null;

  // WebM / Matroska (EBML): 1A 45 DF A3 — Chrome and Firefox.
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
    return { container: 'webm', mimeType: 'audio/webm', extension: '.webm' };
  }

  // Ogg: 'OggS'.
  if (buf.toString('ascii', 0, 4) === 'OggS') {
    return { container: 'ogg', mimeType: 'audio/ogg', extension: '.ogg' };
  }

  // ISO-BMFF: ....ftyp<brand> — Safari's audio/mp4, and .m4a generally.
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    ISO_BMFF_AV_BRANDS.has(buf.toString('ascii', 8, 12))
  ) {
    return { container: 'mp4', mimeType: 'audio/mp4', extension: '.m4a' };
  }

  // MP3: an ID3 tag, or a bare frame header. No browser recorder emits this,
  // but a file queued offline by an older client might, so it stays admitted.
  if (buf.toString('ascii', 0, 3) === 'ID3') {
    return { container: 'mp3', mimeType: 'audio/mpeg', extension: '.mp3' };
  }
  // Frame sync is 11 set bits, then a 2-bit version where 01 is reserved and
  // a 2-bit layer where 00 is reserved. Checking only the sync bits — as this
  // did — matches a great deal of arbitrary binary data.
  if (
    buf[0] === 0xFF &&
    (buf[1] & 0xE0) === 0xE0 &&
    (buf[1] & 0x18) !== 0x08 &&
    (buf[1] & 0x06) !== 0x00
  ) {
    return { container: 'mp3', mimeType: 'audio/mpeg', extension: '.mp3' };
  }

  return null;
}
