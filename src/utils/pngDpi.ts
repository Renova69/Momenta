/**
 * Tag a PNG with the resolution it was made at (N-130).
 *
 * A canvas encodes PNGs with no resolution, which every reader takes as 72 dpi:
 * the poster sold as "300 dpi" opened in print software at about 1.75 m wide.
 * This writes a `pHYs` chunk — pixels per metre on both axes — straight after
 * the header, replacing any already there.
 */

const SIGNATURE_LENGTH = 8;
const INCHES_PER_METRE = 39.3700787;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [png.subarray(0, SIGNATURE_LENGTH)];

  const pixelsPerMetre = Math.round(dpi * INCHES_PER_METRE);
  const physData = new Uint8Array(9);
  const physView = new DataView(physData.buffer);
  physView.setUint32(0, pixelsPerMetre);
  physView.setUint32(4, pixelsPerMetre);
  physData[8] = 1; // unit: metre

  let offset = SIGNATURE_LENGTH;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (type !== 'pHYs') parts.push(png.subarray(offset, end));
    if (type === 'IHDR') parts.push(chunk('pHYs', physData));
    offset = end;
  }

  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
