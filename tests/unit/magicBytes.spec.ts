import { describe, it, expect } from 'vitest';
import { detectAudioFormat, isImageMagicBytes, isValidUuid } from '../../server/lib/validation';

/**
 * What the audio guestbook will accept.
 *
 * This is `/api/audio`'s only content check — the MIME type on the multipart
 * part is a client-supplied string, and the route no longer reads it at all.
 * Until M-3 the check was a validator shared with the image paths, so a JPEG,
 * a PNG, a GIF, a WebP or any `ftyp` container at all was admitted: stored,
 * counted against the event's media quota, and broadcast over the WebSocket to
 * every connected guest as an audio message no player can play.
 *
 * The two directions are not equally risky. Rejecting a real recording loses a
 * guest's message with a message that says the recording was invalid, so the
 * accept cases below enumerate what `MediaRecorder` actually emits on each
 * browser — the client's own codec negotiation in AudioGuestbook.tsx is the
 * reference list.
 */

/** `....ftyp<brand>` — the ISO-BMFF header, with the size field left as 0x18. */
function ftyp(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from(brand, 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
}

describe('recordings the guestbook must accept', () => {
  it('accepts WebM, which Chrome and Firefox record', () => {
    // audio/webm;codecs=opus — the first branch of the client's negotiation.
    const webm = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86]);

    expect(detectAudioFormat(webm)).toEqual({
      container: 'webm',
      mimeType: 'audio/webm',
      extension: '.webm',
    });
  });

  it('accepts Ogg', () => {
    const ogg = Buffer.from('OggS\x00\x02\x00\x00\x00\x00');

    expect(detectAudioFormat(ogg)?.container).toBe('ogg');
    expect(detectAudioFormat(ogg)?.mimeType).toBe('audio/ogg');
  });

  it('accepts every MP4 brand a recorder or encoder produces', () => {
    // Safari falls back to audio/mp4, and its fragmented output does not
    // necessarily carry the plain `M4A ` brand a file-based encoder writes.
    for (const brand of ['M4A ', 'mp42', 'isom', 'iso5', 'dash', 'mp41', '3gp4']) {
      const format = detectAudioFormat(ftyp(brand));
      expect(format, `brand ${brand} was rejected`).not.toBeNull();
      expect(format?.container).toBe('mp4');
    }
  });

  it('accepts MP3, which nothing records but an old offline queue may still hold', () => {
    expect(detectAudioFormat(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'))?.container).toBe('mp3');
    expect(detectAudioFormat(Buffer.from([0xFF, 0xFB, 0x90, 0x64]))?.container).toBe('mp3');
  });
});

describe('payloads the guestbook must refuse', () => {
  it('refuses images — the whole of M-3', () => {
    // Each of these was accepted before. They are still accepted by
    // isImageMagicBytes, which is the point: the image paths want them and
    // the audio path never did.
    const images: Array<[string, Buffer]> = [
      ['JPEG', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])],
      ['PNG', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
      ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00')],
      ['WebP', Buffer.from('RIFF1234WEBPVP8 ')],
    ];

    for (const [label, bytes] of images) {
      expect(detectAudioFormat(bytes), `${label} was admitted as audio`).toBeNull();
      expect(isImageMagicBytes(bytes), `${label} stopped being an image`).toBe(true);
    }
  });

  it('refuses an iPhone photo, which is an ftyp container like an MP4 is', () => {
    // The reason `ftyp` is brand-checked rather than accepted wholesale:
    // HEIC and AVIF share the container with MP4.
    for (const brand of ['heic', 'heix', 'mif1', 'avif', 'avis']) {
      expect(detectAudioFormat(ftyp(brand)), `${brand} was admitted as audio`).toBeNull();
      expect(isImageMagicBytes(ftyp(brand))).toBe(true);
    }
  });

  it('refuses an unknown ftyp brand rather than guessing', () => {
    expect(detectAudioFormat(ftyp('zzzz'))).toBeNull();
    expect(detectAudioFormat(Buffer.from('....ftyp'))).toBeNull();
  });

  it('refuses executables, markup and truncated buffers', () => {
    expect(detectAudioFormat(Buffer.from([0x4D, 0x5A, 0x90, 0x00]))).toBeNull();
    expect(detectAudioFormat(Buffer.from([0x7F, 0x45, 0x4C, 0x46]))).toBeNull();
    expect(detectAudioFormat(Buffer.from('<!DOCTYPE html><html>'))).toBeNull();
    expect(detectAudioFormat(Buffer.from([0xFF, 0xD8]))).toBeNull();
    expect(detectAudioFormat(null as unknown as Buffer)).toBeNull();
  });

  it('refuses a byte pair that only looks like an MP3 frame sync', () => {
    // The old check was `buf[1] & 0xE0 === 0xE0` alone, which matches a great
    // deal of arbitrary binary. A frame header also has a version field where
    // 01 is reserved and a layer field where 00 is reserved.
    expect(detectAudioFormat(Buffer.from([0xFF, 0xE8, 0x00, 0x00]))).toBeNull(); // reserved version
    expect(detectAudioFormat(Buffer.from([0xFF, 0xF9, 0x00, 0x00]))).toBeNull(); // reserved layer
  });
});

describe('the format decides what gets stored', () => {
  it('names a type and an extension for every format it admits', () => {
    // The route writes both onto the stored object instead of echoing the
    // client's MIME type, so neither may ever come back undefined.
    const samples = [
      Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
      Buffer.from('OggS\x00\x02\x00\x00'),
      ftyp('M4A '),
      Buffer.from('ID3\x04\x00\x00\x00'),
    ];

    for (const bytes of samples) {
      const format = detectAudioFormat(bytes);
      expect(format).not.toBeNull();
      expect(format?.mimeType).toMatch(/^audio\//);
      expect(format?.extension).toMatch(/^\.[a-z0-9]+$/);
    }
  });
});

describe('UUID validation', () => {
  it('validates UUID format strictly', () => {
    expect(isValidUuid('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01')).toBe(true);
    expect(isValidUuid('10EEBC99-9C0B-4EF8-BB6D-6BB9BD380A01')).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01; DROP TABLE users;--')).toBe(false);
  });
});
