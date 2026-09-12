import sharp from 'sharp';

/**
 * Derivative generation for uploaded photos.
 *
 * Every photo is stored three ways: the untouched original (what the couple buys
 * in the ZIP export), a display copy sized for the gallery and TV wall, and a
 * thumbnail for feed cards. Serving the display copy where a thumbnail belongs is
 * the single biggest bandwidth cost on venue Wi-Fi, so the sizes are deliberate.
 */

/**
 * One thread per sharp operation.
 *
 * sharp defaults to a thread pool the width of the machine, which is right for a
 * batch tool resizing one image at a time. This is the opposite workload: many
 * guests uploading at once, each running two resizes. At the default, forty
 * concurrent uploads asked for forty times sixteen threads on sixteen cores, and
 * the load test showed it - p50 stayed sane while p95 swung between 14 s and
 * 27 s across identical runs.
 *
 * Parallelism across requests comes from libuv (UV_THREADPOOL_SIZE), so each
 * individual operation only needs one thread.
 */
sharp.concurrency(1);

// Caps total decoded pixels (width x height) sharp will accept, so a crafted
// or absurd image (a 20000x20000 PNG is a valid file, decodes to >1.2GB
// uncompressed) is rejected before decoding rather than after (SEC-M2).
// Matches the same cap used for print rasterization in pdfPrintService.ts.
const MAX_INPUT_PIXELS = 40_000_000;

export const DISPLAY_MAX_EDGE = 1600;
export const THUMBNAIL_MAX_EDGE = 400;

const DISPLAY_QUALITY = 82;
const THUMBNAIL_QUALITY = 74;

export interface PhotoDerivatives {
  display: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
}

/**
 * Build display and thumbnail JPEGs from an original image buffer.
 *
 * `withoutEnlargement` keeps small images at their native size rather than
 * upscaling them into a larger file, and rotate() applies the EXIF orientation
 * so phone photos are not served sideways.
 */
export async function buildDerivatives(original: Buffer): Promise<PhotoDerivatives> {
  const pipeline = sharp(original, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const metadata = await pipeline.metadata();

  // MED-07 — display and thumbnail used to each open their own fresh
  // sharp(original, ...) instance, decoding the same source a third time on
  // top of the metadata() read. clone() shares the already-open input
  // instead, so the source is decoded once.
  const [display, thumbnail] = await Promise.all([
    pipeline
      .clone()
      .resize({ width: DISPLAY_MAX_EDGE, height: DISPLAY_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: DISPLAY_QUALITY, mozjpeg: true })
      .toBuffer(),
    pipeline
      .clone()
      .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true })
      .toBuffer(),
  ]);

  // MED-07 — metadata.width/height are the raw pre-rotation pixel counts
  // ("EXIF orientation is not taken into consideration", per sharp's own
  // types); autoOrient reflects what .rotate() actually produces. For a
  // portrait phone photo shot with EXIF orientation 6/8, using the raw
  // values reported the image sideways — width and height swapped relative
  // to what guests actually see.
  return {
    display,
    thumbnail,
    width: metadata.autoOrient?.width ?? metadata.width ?? 0,
    height: metadata.autoOrient?.height ?? metadata.height ?? 0,
  };
}

/** True when sharp can decode the buffer as an image. */
export async function isDecodableImage(buffer: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(buffer, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    return !!metadata.width && !!metadata.height;
  } catch {
    return false;
  }
}
