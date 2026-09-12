import { PhotoFilter } from '../types';

export interface CompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  filter?: PhotoFilter;
}

interface ResolvedOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  filter: PhotoFilter;
}

function fitWithinBox(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  let width = sourceWidth;
  let height = sourceHeight;
  if (width > height) {
    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }
  } else {
    if (height > maxHeight) {
      width = Math.round((width * maxHeight) / height);
      height = maxHeight;
    }
  }
  return { width, height };
}

function paintFilteredImage(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  filter: PhotoFilter
): void {
  switch (filter) {
    case 'vintage_warmth':
      ctx.filter = 'sepia(40%) brightness(110%) contrast(105%) saturate(120%)';
      break;
    case 'golden_glow':
      ctx.filter = 'sepia(50%) brightness(115%) contrast(110%) saturate(130%)';
      break;
    case 'black_white':
      ctx.filter = 'grayscale(100%) contrast(120%) brightness(105%)';
      break;
    case 'film_grain':
      ctx.filter = 'sepia(20%) contrast(90%) brightness(110%) saturate(80%)';
      break;
    default:
      ctx.filter = 'none';
      break;
  }

  ctx.drawImage(source, 0, 0, width, height);

  // Subtle vignette for vintage warmth
  if (filter === 'vintage_warmth' || filter === 'golden_glow') {
    const gradient = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.4,
      width / 2, height / 2, Math.max(width, height) * 0.75
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(30,15,5,0.28)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context could not be created');
  }
  return { canvas, ctx };
}

/**
 * File/Blob path — decodes via `createImageBitmap` instead of a data: URL +
 * `<img>`. A phone gallery photo can be 12-108MP; the old path (FileReader to
 * base64, then `img.src = dataUrl`) held the ~1.37x-inflated base64 string,
 * the `<img>`'s own decoded bitmap, and the output canvas all at once, with
 * the `<img>`'s memory only released whenever the GC got to it - fine for one
 * photo, but a sequential bulk-upload loop over several gallery originals
 * could pile these up faster than they were reclaimed and OOM the tab.
 * `createImageBitmap` skips the base64 round-trip entirely and `.close()`
 * releases its decoded memory immediately once drawn, deterministically.
 */
async function compressFileViaImageBitmap(file: File | Blob, options: ResolvedOptions): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithinBox(bitmap.width, bitmap.height, options.maxWidth, options.maxHeight);
    const { canvas, ctx } = makeCanvas(width, height);
    paintFilteredImage(ctx, bitmap, width, height, options.filter);
    return { dataUrl: canvas.toDataURL('image/jpeg', options.quality), width, height };
  } finally {
    bitmap.close();
  }
}

/** data: URL / remote URL path — used for the live camera capture frame, which is already bounded to the getUserMedia request size (max 4096x3072). */
function compressDataUrlViaImageElement(dataUrl: string, options: ResolvedOptions): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const { width, height } = fitWithinBox(img.width, img.height, options.maxWidth, options.maxHeight);
        const { canvas, ctx } = makeCanvas(width, height);
        paintFilteredImage(ctx, img, width, height, options.filter);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', options.quality), width, height });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) resolve(e.target.result as string);
      else reject(new Error('Failed to read file for compression'));
    };
    reader.onerror = () => reject(new Error('Failed to read file for compression'));
    reader.readAsDataURL(file);
  });
}

/**
 * Compresses an image and optionally applies aesthetic photo filters in the browser.
 * Reduces 10MB raw photos to lightweight ~300KB-1.2MB WebP/JPEG for instant uploading on venue Wi-Fi.
 */
export async function compressAndFilterImage(
  fileOrDataUrl: File | string,
  options: CompressOptions = {}
): Promise<{ dataUrl: string; width: number; height: number }> {
  const resolved: ResolvedOptions = {
    maxWidth: options.maxWidth ?? 1920,
    maxHeight: options.maxHeight ?? 1920,
    quality: options.quality ?? 0.85,
    filter: options.filter ?? 'original',
  };

  if (typeof fileOrDataUrl === 'string') {
    return compressDataUrlViaImageElement(fileOrDataUrl, resolved);
  }

  if (typeof createImageBitmap === 'function') {
    try {
      return await compressFileViaImageBitmap(fileOrDataUrl, resolved);
    } catch (err) {
      // A phone's default photo format (HEIC/HEIF on iOS, some RAW-adjacent
      // JPEGs), a decode failure, or a test/older-browser environment
      // without full createImageBitmap support must not leave the caller
      // with nothing — fall through to the slower but more broadly
      // compatible <img>-based path below instead of throwing.
      console.warn('[Compression] createImageBitmap path failed, falling back to <img> decode:', err);
    }
  }

  const dataUrl = await readFileAsDataUrl(fileOrDataUrl);
  return compressDataUrlViaImageElement(dataUrl, resolved);
}
