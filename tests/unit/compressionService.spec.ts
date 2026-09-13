import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compressAndFilterImage } from '../../src/services/compressionService';

/**
 * Image compression before upload.
 *
 * This is what stands between a 12-108MP phone photo and venue Wi-Fi, and it
 * carries two decisions that are easy to regress silently:
 *
 *   The File path decodes through `createImageBitmap` rather than a base64
 *   data URL + `<img>`, because the old route held the inflated base64 string,
 *   the decoded bitmap and the output canvas at once and could OOM a tab during
 *   a bulk gallery upload. The bitmap is closed deterministically once drawn.
 *
 *   When that path fails — iOS HEIC, a decode error, an older browser — it must
 *   fall back rather than throw, or the guest simply gets nothing.
 *
 * jsdom has no real canvas encoder, so `toDataURL` and the decode entry points
 * are stubbed. What is asserted is the resizing arithmetic, which decode route
 * was taken, and that the bitmap is released.
 */

const ENCODED = 'data:image/jpeg;base64,ENCODED';

let createdCanvases: { width: number; height: number; quality?: number }[] = [];

function stubCanvas() {
  createdCanvases = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = realCreate(tag);
    if (tag === 'canvas') {
      const canvas = el as HTMLCanvasElement;
      const record = { width: 0, height: 0 as number, quality: undefined as number | undefined };
      Object.defineProperty(canvas, 'width', {
        get: () => record.width,
        set: (v: number) => { record.width = v; },
        configurable: true,
      });
      Object.defineProperty(canvas, 'height', {
        get: () => record.height,
        set: (v: number) => { record.height = v; },
        configurable: true,
      });
      canvas.getContext = (() => ({
        drawImage: vi.fn(),
        filter: '',
        fillStyle: '',
        fillRect: vi.fn(),
        globalCompositeOperation: 'source-over',
        globalAlpha: 1,
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
        createRadialGradient: () => ({ addColorStop: vi.fn() }),
        save: vi.fn(),
        restore: vi.fn(),
      })) as unknown as HTMLCanvasElement['getContext'];
      canvas.toDataURL = ((_type?: string, q?: number) => {
        record.quality = q;
        return ENCODED;
      }) as HTMLCanvasElement['toDataURL'];
      createdCanvases.push(record);
    }
    return el;
  });
}

/** A bitmap of the given intrinsic size, recording whether it was released. */
function fakeBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

function stubImageElement(width: number, height: number, fail = false) {
  class FakeImage {
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = width;
    height = height;
    set src(_v: string) {
      queueMicrotask(() => (fail ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image);
}

beforeEach(() => stubCanvas());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resizing', () => {
  it('leaves an image already inside the box untouched', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(800, 600)));

    const out = await compressAndFilterImage(new File([], 'a.jpg'));

    expect(out).toMatchObject({ width: 800, height: 600, dataUrl: ENCODED });
  });

  it('scales a landscape photo down by its width, preserving aspect ratio', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(4000, 3000)));

    const out = await compressAndFilterImage(new File([], 'a.jpg'));

    expect(out.width).toBe(1920);
    expect(out.height).toBe(1440); // 3000 * 1920 / 4000
  });

  it('scales a portrait photo down by its height', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(3000, 4000)));

    const out = await compressAndFilterImage(new File([], 'a.jpg'));

    expect(out.height).toBe(1920);
    expect(out.width).toBe(1440);
  });

  it('honours a caller-supplied box', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(4000, 2000)));

    const out = await compressAndFilterImage(new File([], 'a.jpg'), { maxWidth: 400, maxHeight: 400 });

    expect(out).toMatchObject({ width: 400, height: 200 });
  });

  it('sizes the canvas to the computed output, not the source', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(4000, 3000)));

    await compressAndFilterImage(new File([], 'a.jpg'));

    expect(createdCanvases[0]).toMatchObject({ width: 1920, height: 1440 });
  });

  it('passes the quality through to the encoder, defaulting to 0.85', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    await compressAndFilterImage(new File([], 'a.jpg'));
    expect(createdCanvases[0].quality).toBe(0.85);

    await compressAndFilterImage(new File([], 'b.jpg'), { quality: 0.5 });
    expect(createdCanvases[1].quality).toBe(0.5);
  });
});

describe('decode route', () => {
  it('uses createImageBitmap for a File and releases it once drawn', async () => {
    const bitmap = fakeBitmap(1000, 1000);
    const create = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', create);

    await compressAndFilterImage(new File([], 'a.jpg'));

    expect(create).toHaveBeenCalledTimes(1);
    // Deterministic release: the whole point of this path over <img>.
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('still releases the bitmap when drawing throws', async () => {
    const bitmap = fakeBitmap(1000, 1000);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    // No 2d context available - makeCanvas throws.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    (document.createElement as unknown as { mockRestore: () => void }).mockRestore();
    stubImageElement(1000, 1000);

    await compressAndFilterImage(new File([], 'a.jpg')).catch(() => undefined);

    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('uses the <img> path for a data URL, without touching createImageBitmap', async () => {
    const create = vi.fn(async () => fakeBitmap(100, 100));
    vi.stubGlobal('createImageBitmap', create);
    stubImageElement(2400, 1200);

    const out = await compressAndFilterImage('data:image/jpeg;base64,AAAA');

    expect(create).not.toHaveBeenCalled();
    expect(out).toMatchObject({ width: 1920, height: 960 });
  });

  it('falls back to the <img> path when createImageBitmap fails, rather than throwing', async () => {
    // iOS HEIC, a decode failure, or an older browser. The guest must still
    // get a photo out of this.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      throw new Error('unsupported format');
    }));
    stubImageElement(1000, 500);

    const fileReaderRead = vi
      .spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation(function (this: FileReader) {
        queueMicrotask(() =>
          this.onload?.({ target: { result: 'data:image/jpeg;base64,AAAA' } } as unknown as ProgressEvent<FileReader>)
        );
      });

    const out = await compressAndFilterImage(new File([], 'photo.heic'));

    expect(out).toMatchObject({ width: 1000, height: 500 });
    expect(warn).toHaveBeenCalled();
    expect(fileReaderRead).toHaveBeenCalled();
  });

  it('falls back when createImageBitmap is not implemented at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    stubImageElement(640, 480);
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      queueMicrotask(() =>
        this.onload?.({ target: { result: 'data:image/jpeg;base64,AAAA' } } as unknown as ProgressEvent<FileReader>)
      );
    });

    await expect(compressAndFilterImage(new File([], 'a.jpg'))).resolves.toMatchObject({
      width: 640,
      height: 480,
    });
  });
});

describe('failure reporting', () => {
  it('rejects with a clear message when the image cannot be decoded', async () => {
    stubImageElement(0, 0, true);

    await expect(compressAndFilterImage('data:image/jpeg;base64,BROKEN')).rejects.toThrow(
      'Failed to load image for compression'
    );
  });

  it('rejects when the file cannot be read', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.({} as ProgressEvent<FileReader>));
    });

    await expect(compressAndFilterImage(new File([], 'a.jpg'))).rejects.toThrow(
      'Failed to read file for compression'
    );
  });
});
