import { describe, it, expect } from 'vitest';
import { centerIconDataUri } from '../../src/utils/qrCenterIcon';

/**
 * The icon in the middle of a QR code.
 *
 * It must be inline. Hotlinked from a CDN it broke the printed poster —
 * html2canvas cannot read pixels from a cross-origin image, so the excavated
 * hole came out empty — and on the projector wall it is an external request
 * held open all evening on the venue's Wi-Fi.
 */
describe('centerIconDataUri', () => {
  it.each(['heart', 'rings', 'camera', 'sparkle'] as const)('gives %s as an inline SVG', (icon) => {
    const uri = centerIconDataUri(icon);
    expect(uri?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('gives nothing for the no-icon choice, which leaves the code unbroken', () => {
    expect(centerIconDataUri('none')).toBeUndefined();
  });

  it('never returns a URL that would be fetched', () => {
    for (const icon of ['heart', 'rings', 'camera', 'sparkle'] as const) {
      expect(centerIconDataUri(icon)).not.toMatch(/^https?:/);
    }
  });
});
