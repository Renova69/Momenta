import { CanvasSize, WeddingEvent, QRCanvasConfig } from '../types';

export interface PrintDimensions {
  size: CanvasSize;
  widthMm: number;
  heightMm: number;
  widthPx300Dpi: number;
  heightPx300Dpi: number;
  aspectRatio: number;
}

export const PRINT_SPECS: Record<CanvasSize, PrintDimensions> = {
  A2: {
    size: 'A2',
    widthMm: 420,
    heightMm: 594,
    widthPx300Dpi: 4960,
    heightPx300Dpi: 7016,
    aspectRatio: 1 / 1.414,
  },
  A3: {
    size: 'A3',
    widthMm: 297,
    heightMm: 420,
    widthPx300Dpi: 3508,
    heightPx300Dpi: 4960,
    aspectRatio: 1 / 1.414,
  },
  A4: {
    size: 'A4',
    widthMm: 210,
    heightMm: 297,
    widthPx300Dpi: 2480,
    heightPx300Dpi: 3508,
    aspectRatio: 1 / 1.414,
  },
  TABLE_CARD: {
    size: 'TABLE_CARD',
    widthMm: 148,
    heightMm: 210,
    widthPx300Dpi: 1748,
    heightPx300Dpi: 2480,
    aspectRatio: 1 / 1.418,
  },
  SQUARE_BANNER: {
    size: 'SQUARE_BANNER',
    widthMm: 300,
    heightMm: 300,
    widthPx300Dpi: 3543,
    heightPx300Dpi: 3543,
    aspectRatio: 1,
  },
};

const PRINTABLE_ELEMENT_ID = 'printable-canvas';

/** Cap the rasterisation scale so an A2 poster cannot exhaust canvas memory. */
const MAX_RASTER_PIXELS = 40_000_000;

// SEC-W2: mobile Safari refuses to allocate a canvas past ~4096px on any one
// side (and gets flaky well before that on total memory), independent of the
// MAX_RASTER_PIXELS budget above - an A2 poster at 300 DPI is 4960x7016,
// under the 40M total-pixel cap but over Safari's per-side limit, so it
// crashed the tab outright instead of just rendering slower.
const MAX_MOBILE_DIMENSION_PX = 4096;
const MAX_MOBILE_RASTER_PIXELS = 12_000_000;

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/**
 * Pure scale calculation, split out from renderPosterToCanvas so the mobile
 * cap (SEC-W2) is testable without a live DOM element or html2canvas.
 */
export function computeRasterScale(spec: PrintDimensions, onScreenWidth: number, isMobile: boolean): number {
  // naturalScale is the scale that makes html2canvas's actual output
  // (onScreenWidth * scale) hit spec.widthPx300Dpi exactly.
  const naturalScale = spec.widthPx300Dpi / onScreenWidth;
  let scale = naturalScale;

  const projectedPixels = spec.widthPx300Dpi * spec.heightPx300Dpi;
  if (projectedPixels > MAX_RASTER_PIXELS) {
    scale *= Math.sqrt(MAX_RASTER_PIXELS / projectedPixels);
  }

  if (isMobile) {
    // FE-01: projectedWidth must track the real output size
    // (onScreenWidth * scale), not spec.widthPx300Dpi * scale - the latter
    // still has spec.widthPx300Dpi baked into `scale` itself (scale starts
    // as spec.widthPx300Dpi / onScreenWidth), so it silently squares the
    // DPI width into the projection and produced a ~257px output instead of
    // a print-resolution one. `factor` is how much of the full DPI target
    // the current scale still reaches, after any desktop-cap shrink.
    const factor = scale / naturalScale;
    const projectedWidth = spec.widthPx300Dpi * factor;
    const projectedHeight = spec.heightPx300Dpi * factor;
    const dimensionScale = Math.min(1, MAX_MOBILE_DIMENSION_PX / Math.max(projectedWidth, projectedHeight));
    const pixelScale = Math.sqrt(Math.min(1, MAX_MOBILE_RASTER_PIXELS / (projectedWidth * projectedHeight)));
    scale *= Math.min(dimensionScale, pixelScale);
  }

  return scale;
}

export class PrintExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintExportError';
  }
}

function getPrintableElement(): HTMLElement {
  const element = document.getElementById(PRINTABLE_ELEMENT_ID);
  if (!element) {
    throw new PrintExportError(
      'The poster preview is not on screen. Open the QR Print Studio and try again.'
    );
  }
  return element;
}

export function getPrintSpec(size: CanvasSize | undefined): PrintDimensions {
  return PRINT_SPECS[size as CanvasSize] || PRINT_SPECS.A2;
}

function buildFileName(event: WeddingEvent, spec: PrintDimensions, extension: string): string {
  const slug = event.slug || 'wedding';
  return `${slug}-qr-${spec.size.toLowerCase()}.${extension}`;
}

function triggerDownload(blobOrUrl: Blob | string, filename: string): void {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
}

/**
 * Rasterise the live poster preview at print resolution.
 *
 * The scale is derived from the target 300-DPI pixel width so the exported file
 * matches the physical paper size a print shop expects, rather than whatever
 * happens to be on screen. Rendering the on-screen node (instead of redrawing the
 * poster separately) guarantees the export always matches the preview.
 */
export async function renderPosterToCanvas(size: CanvasSize | undefined): Promise<HTMLCanvasElement> {
  const element = getPrintableElement();
  const spec = getPrintSpec(size);

  const onScreenWidth = element.offsetWidth || 440;
  const scale = computeRasterScale(spec, onScreenWidth, isMobileDevice());

  const { default: html2canvas } = await import('html2canvas');

  return html2canvas(element, {
    scale,
    backgroundColor: '#FDFBF7',
    useCORS: true,
    logging: false,
  });
}

/** Export the poster as a print-resolution PNG. */
export async function exportPosterPng(config: {
  event: WeddingEvent;
  canvasConfig: QRCanvasConfig;
}): Promise<void> {
  const spec = getPrintSpec(config.canvasConfig.canvasSize);
  const canvas = await renderPosterToCanvas(config.canvasConfig.canvasSize);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  if (!blob) throw new PrintExportError('The poster image could not be encoded.');

  triggerDownload(blob, buildFileName(config.event, spec, 'png'));
}

/**
 * Export the poster as a PDF sized to the exact paper dimensions in millimetres,
 * so the print shop receives a correctly scaled page rather than a screenshot.
 */
export async function exportPosterPdf(config: {
  event: WeddingEvent;
  canvasConfig: QRCanvasConfig;
}): Promise<void> {
  const spec = getPrintSpec(config.canvasConfig.canvasSize);
  const canvas = await renderPosterToCanvas(config.canvasConfig.canvasSize);

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({
    orientation: spec.widthMm >= spec.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [spec.widthMm, spec.heightMm],
    compress: true,
  });

  pdf.addImage(
    canvas.toDataURL('image/jpeg', 0.95),
    'JPEG',
    0,
    0,
    spec.widthMm,
    spec.heightMm,
    undefined,
    'FAST'
  );

  pdf.save(buildFileName(config.event, spec, 'pdf'));
}

/**
 * Open the browser print dialog for the QR poster.
 *
 * The `@media print` rules in index.css isolate `#printable-canvas` so the poster
 * prints without app chrome. For a print shop, prefer {@link exportPosterPdf} —
 * it produces a correctly sized page instead of relying on the browser's scaling.
 */
export function triggerVectorPrint(_config?: {
  event: WeddingEvent;
  canvasConfig: QRCanvasConfig;
}) {
  if (typeof window === 'undefined') return;
  // Throws if the poster is not mounted, so we never print the app chrome.
  getPrintableElement();
  window.print();
}
