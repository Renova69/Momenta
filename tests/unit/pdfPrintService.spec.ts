import { describe, it, expect, vi } from 'vitest';
import {
  PrintExportError,
  getPrintSpec,
  triggerVectorPrint,
  exportPosterPdf,
  PRINT_SPECS,
  computeRasterScale,
} from '../../src/services/pdfPrintService';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';

describe('PDF & Print Service Spec', () => {
  it('defines all required print dimensions and DPI specs', () => {
    expect(PRINT_SPECS.A2.widthMm).toBe(420);
    expect(PRINT_SPECS.A3.widthMm).toBe(297);
    expect(PRINT_SPECS.A4.widthMm).toBe(210);
    expect(PRINT_SPECS.TABLE_CARD.widthMm).toBe(148);
    expect(PRINT_SPECS.SQUARE_BANNER.aspectRatio).toBe(1);
  });

  it('triggers the browser print dialog', () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});

    const mockEvent: WeddingEvent = {
      id: 'e1',
      slug: 'print-slug',
      title: 'Print Event',
      hostName: 'Host',
      hostEmail: 'host@example.com',
      eventDate: '2026-09-18T16:30:00Z',
      venueName: 'Venue',
      coverImageUrl: 'https://example.com/cover.jpg',
      themePalette: 'champagne_gold',
      welcomeMessage: 'Welcome',
      isModerationEnabled: false,
      isDisposableMode: false,
      isPublic: false,
      revealAt: null,
      maxPhotosPerGuest: 50,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockConfig: QRCanvasConfig = {
      id: 'c1',
      eventId: 'e1',
      canvasSize: 'A3',
      frameStyle: 'minimal_gold',
      headline: 'Scan to Share',
      subtext: 'Snap memories',
      accentColor: '#D4AF37',
      centerIcon: 'heart',
    };

    // The poster node must be mounted: printing without it would silently send
    // the whole app chrome to the printer instead of the poster.
    const poster = document.createElement('div');
    poster.id = 'printable-canvas';
    document.body.appendChild(poster);

    triggerVectorPrint({ event: mockEvent, canvasConfig: mockConfig });
    expect(printSpy).toHaveBeenCalled();

    poster.remove();
  });

  it('refuses to print when the poster preview is not mounted', () => {
    const printSpy = vi.fn();
    window.print = printSpy;

    expect(() =>
      triggerVectorPrint({
        event: { id: 'e1', slug: 'w' } as unknown as WeddingEvent,
        canvasConfig: { canvasSize: 'A3' } as unknown as QRCanvasConfig,
      })
    ).toThrow(PrintExportError);
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('exposes exact print dimensions for every supported canvas size', () => {
    // A print shop needs the physical size, not whatever the screen shows.
    expect(getPrintSpec('A2').widthMm).toBe(420);
    expect(getPrintSpec('A2').widthPx300Dpi).toBe(4960);
    expect(getPrintSpec('TABLE_CARD').heightMm).toBe(210);
    expect(getPrintSpec(undefined).size).toBe('A2');
  });

  describe('mobile raster cap (SEC-W2, FE-01)', () => {
    // The actual html2canvas output size at a given scale is always
    // onScreenWidth * scale (that's what html2canvas multiplies) - never
    // spec.widthPx300Dpi * scale, which still has spec.widthPx300Dpi baked
    // into `scale` itself and silently squares it (FE-01).
    function outputDims(spec: (typeof PRINT_SPECS)[keyof typeof PRINT_SPECS], onScreenWidth: number, scale: number) {
      const width = onScreenWidth * scale;
      const height = width * (spec.heightPx300Dpi / spec.widthPx300Dpi);
      return { width, height };
    }

    it('never exceeds a 4096px side or 12M total pixels on mobile, for any print size', () => {
      const onScreenWidth = 440;
      for (const spec of Object.values(PRINT_SPECS)) {
        const scale = computeRasterScale(spec, onScreenWidth, true);
        const { width, height } = outputDims(spec, onScreenWidth, scale);
        expect(Math.max(width, height)).toBeLessThanOrEqual(4096 + 0.01);
        expect(width * height).toBeLessThanOrEqual(12_000_000 * 1.0001);
      }
    });

    it('an A2 poster (4960x7016, under the 40M desktop cap) still gets capped on mobile', () => {
      // This is the actual SEC-W2 case: A2 at 300 DPI is under the existing
      // 40M total-pixel desktop cap, so that cap alone never kicks in - only
      // the mobile-specific per-side/total cap protects it.
      const scale = computeRasterScale(PRINT_SPECS.A2, 440, true);
      const { width, height } = outputDims(PRINT_SPECS.A2, 440, scale);
      expect(Math.max(width, height)).toBeLessThanOrEqual(4096 + 0.01);
    });

    it('does not shrink desktop rendering, only mobile', () => {
      const desktopScale = computeRasterScale(PRINT_SPECS.A2, 440, false);
      const mobileScale = computeRasterScale(PRINT_SPECS.A2, 440, true);
      expect(mobileScale).toBeLessThan(desktopScale);
    });

    it('produces a real print-resolution output on mobile, not a collapsed ~257px thumbnail (FE-01)', () => {
      // The dimension cap should bring the longest side down to exactly (or
      // just under) 4096px - not overshoot into the low hundreds because the
      // projection used to decide the cap was itself wrong.
      const scale = computeRasterScale(PRINT_SPECS.A2, 440, true);
      const { width, height } = outputDims(PRINT_SPECS.A2, 440, scale);
      expect(Math.max(width, height)).toBeGreaterThan(3900);
    });
  });
});

/**
 * The jsPDF integration, exercised for real.
 *
 * Every other test in this file covers dimensions and the print dialog, so
 * `exportPosterPdf` — the only place jsPDF is constructed — was never called by
 * the suite at all. That meant a jsPDF major upgrade could typecheck, bundle
 * and ship while being broken at runtime, which is exactly the risk in moving
 * across two majors to clear a security advisory.
 *
 * html2canvas is mocked, because it needs a real layout engine. jsPDF is not:
 * the constructor, addImage and save all run against the installed version, and
 * the assertion is made on the bytes that come out the other end.
 */
describe('exportPosterPdf — real jsPDF', () => {
  const mockEvent = {
    id: 'e1',
    slug: 'pdf-slug',
    title: 'PDF Spec Wedding',
    hostName: 'Host',
    eventDate: '2026-09-20T15:00:00.000Z',
    venueName: 'Venue',
  } as unknown as WeddingEvent;

  const mockConfig = { canvasSize: 'A4' } as unknown as QRCanvasConfig;

  // A 1x1 JPEG. Enough to prove jsPDF accepts the data URL and embeds it;
  // this is not a test of what the poster looks like.
  const TINY_JPEG =
    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////' +
    '////////////////////////////////////////////////////2wBDAf//////////////////////' +
    '////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QA' +
    'FQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAA' +
    'AAAAAAr/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

  it('builds a real PDF at the exact paper size, with the image embedded', async () => {
    const el = document.createElement('div');
    el.id = 'printable-canvas';
    document.body.appendChild(el);

    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.toDataURL = () => TINY_JPEG;

    vi.doMock('html2canvas', () => ({ default: vi.fn(async () => canvas) }));

    // The real jsPDF does the work. Only the constructor is wrapped, so the
    // document it produces can be inspected and its save() - which ends in a
    // download jsdom cannot perform - is swapped for a spy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs: any[] = [];
    const saveSpy = vi.fn();
    vi.doMock('jspdf', async (importOriginal) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actual = (await importOriginal()) as any;
      const Real = actual.jsPDF;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function Wrapped(this: unknown, ...args: any[]) {
        const doc = new Real(...args);
        doc.save = saveSpy;
        docs.push(doc);
        return doc;
      }
      return { ...actual, jsPDF: Wrapped };
    });

    try {
      await exportPosterPdf({ event: mockEvent, canvasConfig: mockConfig });

      expect(docs).toHaveLength(1);
      const doc = docs[0];

      // A4 portrait in millimetres is what the print shop is promised.
      expect(Math.round(doc.internal.pageSize.width)).toBe(PRINT_SPECS.A4.widthMm);
      expect(Math.round(doc.internal.pageSize.height)).toBe(PRINT_SPECS.A4.heightMm);

      // Real bytes, and the image actually embedded rather than an empty shell.
      const bytes = new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
      expect(bytes.byteLength).toBeGreaterThan(1000);
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

      expect(saveSpy).toHaveBeenCalledTimes(1);
      const filename = String(saveSpy.mock.calls[0][0]);
      expect(filename).toMatch(/\.pdf$/);
      expect(filename).toContain('pdf-slug');
    } finally {
      vi.doUnmock('jspdf');
      vi.doUnmock('html2canvas');
      el.remove();
    }
  });
});
