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

export function validateMagicBytes(buf: Buffer): boolean {
  if (!buf || buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  // WebM / Matroska: 1A 45 DF A3
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return true;
  // OGG: 4F 67 67 53
  if (buf.toString('ascii', 0, 4) === 'OggS') return true;
  // MP4 / M4A: ....ftyp
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return true;
  // MP3: ID3 or FF FB/F3/F2
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return true;
  return false;
}
