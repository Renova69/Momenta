import { QRCenterIcon } from '../types';

/**
 * The little icon in the middle of a QR code.
 *
 * It used to be one image hotlinked from flaticon.com. That CDN sends no
 * permissive CORS headers, so the live preview showed it fine — a plain
 * `<img>`/`<image>` render never enforces CORS — while the PNG/PDF export,
 * which rasterizes the poster through `html2canvas`, silently dropped it: a
 * canvas cannot read pixels from a cross-origin image. The excavated hole in
 * the QR code came out empty on every printed poster.
 *
 * Inline `data:` SVGs are same-origin by construction, so there is no CORS
 * concern and nothing to fetch — which also matters on the projector wall,
 * where the venue's Wi-Fi is the only thing between the screen and an
 * external CDN for the whole reception.
 *
 * Lives here rather than in the print studio because the wall needs it too.
 */
const CENTER_ICON_SVG: Record<Exclude<QRCenterIcon, 'none'>, string> = {
  heart:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1A1817" d="M12 21s-6.7-4.35-9.3-8.28C.87 10.24 1.1 6.5 4.1 4.6 6.6 3 9.4 3.9 12 6.4c2.6-2.5 5.4-3.4 7.9-1.8 3 1.9 3.23 5.64 1.4 8.12C18.7 16.65 12 21 12 21z"/></svg>',
  rings:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="9" cy="14" r="6" fill="none" stroke="#1A1817" stroke-width="2.2"/><circle cx="15" cy="10" r="6" fill="none" stroke="#1A1817" stroke-width="2.2"/></svg>',
  camera:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2.5" fill="#1A1817"/><rect x="8" y="4" width="8" height="4" rx="1.2" fill="#1A1817"/><circle cx="12" cy="14" r="4.2" fill="#FDFBF7"/><circle cx="12" cy="14" r="2.4" fill="#1A1817"/></svg>',
  sparkle:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1A1817" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>',
};

export function centerIconDataUri(icon: QRCenterIcon): string | undefined {
  if (icon === 'none') return undefined;
  const svg = CENTER_ICON_SVG[icon];
  if (!svg) return undefined;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
