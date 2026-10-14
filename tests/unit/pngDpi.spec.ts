import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { withPngDpi } from '../../src/utils/pngDpi';
import { printPixelSize, PRINT_SPECS, exportPosterPng } from '../../src/services/pdfPrintService';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';

/**
 * N-130 — the poster PNG sold as "300 dpi" carried a 72 dpi tag (canvas output
 * has none, which readers take as 72), so print software opened the A2 poster
 * at about 1.75 m wide. Its height also followed the on-screen preview's
 * rounded aspect ratio: 4960 x 7022 where A2 at 300 dpi is 4961 x 7016.
 */

async function png(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  return Uint8Array.from(
    await sharp({ create: { width, height, channels: 3, background: { r: 250, g: 248, b: 240 } } })
      .png()
      .toBuffer()
  );
}

describe('the poster PNG\'s resolution tag (N-130)', () => {
  it('says the resolution it was made at', async () => {
    const tagged = withPngDpi(await png(20, 30), 300);
    const meta = await sharp(Buffer.from(tagged)).metadata();
    expect(meta.density).toBe(300);
    expect(meta.width).toBe(20);
  });

  it('replaces a tag already there rather than adding a second', async () => {
    const twice = withPngDpi(withPngDpi(await png(10, 10), 72), 300);
    const meta = await sharp(Buffer.from(twice)).metadata();
    expect(meta.density).toBe(300);
    expect(Buffer.from(twice).toString('latin1').split('pHYs').length - 1).toBe(1);
  });
});

describe('the poster PNG\'s size (N-130)', () => {
  it('is A2 at 300 dpi when rendered at full width', () => {
    expect(printPixelSize(PRINT_SPECS.A2, 4961)).toEqual({ width: 4961, height: 7016, dpi: 300 });
  });

  it('keeps the paper\'s shape, and says its real resolution, when rendered smaller', () => {
    // A phone renders under its canvas limit, so the poster is smaller than
    // 300 dpi; its tag has to say what it is, or it prints at the wrong size.
    const size = printPixelSize(PRINT_SPECS.A2, 2896);
    expect(size.dpi).toBeCloseTo(175.1, 0);
    expect(size.height / size.width).toBeCloseTo(594 / 420, 3);
  });
});

describe('the exported poster PNG (N-130)', () => {
  it('is saved tagged with the resolution it was rendered at', async () => {
    const el = document.createElement('div');
    el.id = 'printable-canvas';
    document.body.appendChild(el);
    // An A4 rendered 248 px wide is 30 dpi, and 351 px tall at A4's shape.
    const encoded = await png(248, 351);
    const canvas = document.createElement('canvas');
    canvas.width = 248;
    canvas.height = 351;
    canvas.toBlob = (callback: BlobCallback) => callback(new Blob([encoded], { type: 'image/png' }));
    vi.doMock('html2canvas', () => ({ default: vi.fn(async () => canvas) }));
    let saved: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      saved = blob as Blob;
      return 'blob:poster';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    try {
      await exportPosterPng({
        event: { slug: 'png-slug' } as unknown as WeddingEvent,
        canvasConfig: { canvasSize: 'A4' } as unknown as QRCanvasConfig,
      });

      const meta = await sharp(Buffer.from(await saved!.arrayBuffer())).metadata();
      expect(meta.density).toBe(30);
    } finally {
      vi.doUnmock('html2canvas');
      vi.restoreAllMocks();
      el.remove();
    }
  });
});
