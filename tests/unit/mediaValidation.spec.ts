import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { audioRouter } from '../../server/routes/audio';
import { query } from '../../server/lib/db';
import { buildDerivatives } from '../../server/lib/images';

/**
 * A hand-built multipart body — Node's native fetch/FormData combination
 * does not reliably survive round-tripping through jsdom's globals in this
 * test environment (busboy/multer see zero parts on the other end), so
 * every multipart-uploading spec in this suite builds the wire format by
 * hand instead. Matches the existing pattern in ingestRoutes.spec.ts.
 */
function buildMultipartAudio(bytes: Buffer, fields: Record<string, string>): { body: BodyInit; contentType: string } {
  const boundary = `----AudioSpec${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.webm"\r\nContent-Type: audio/webm\r\n\r\n`
    ),
    bytes,
    Buffer.from('\r\n'),
  ];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  // Node's fetch accepts a Buffer body at runtime; DOM's BodyInit type just doesn't know about it.
  return { body: Buffer.concat(parts) as unknown as BodyInit, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Regressions for the media-validation slice of OPEN_ITEMS.md Phase 5:
 *
 *   SEC-M2 — sharp had no limitInputPixels, so an absurdly large image
 *   decoded fully into memory (two resize pipelines, concurrently) before
 *   anything rejected it.
 *   SEC-M3 — audio.ts trusted the data: URL's claimed MIME type (and even
 *   accepted an already-hosted external URL passthrough) with no check on
 *   the actual bytes.
 *   SEC-M4 — photos.ts used the combined image+audio magic-byte validator
 *   for an image-only endpoint, and silently kept a photo whose "display"
 *   copy sharp could not actually decode instead of rejecting the upload.
 */

const TEST_PORT = 6605;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ token: string; userId: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Media Validation Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

describe('Media validation (SEC-M2, SEC-M3, SEC-M4)', () => {
  let eventId = '';
  let userId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/audio', audioRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const host = await registerHost();
    eventId = host.eventId;
    userId = host.userId;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  describe('POST /api/photos (SEC-M4)', () => {
    it('rejects a header-only JPEG that passes magic bytes but is not decodable', async () => {
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          guestName: 'Spec Guest',
          deviceFingerprint: `media-fp-${Date.now()}`,
          fullUrl: `data:image/jpeg;base64,${fakeJpeg.toString('base64')}`,
        }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects audio bytes disguised as an image (image-only validator)', async () => {
      const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          guestName: 'Spec Guest',
          deviceFingerprint: `media-fp-${Date.now()}`,
          fullUrl: `data:image/jpeg;base64,${webmHeader.toString('base64')}`,
        }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts a real, decodable image', async () => {
      const realJpeg = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 100, g: 150, b: 200 } },
      })
        .jpeg()
        .toBuffer();
      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          guestName: 'Spec Guest',
          deviceFingerprint: `media-fp-${Date.now()}`,
          fullUrl: `data:image/jpeg;base64,${realJpeg.toString('base64')}`,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.thumbnailUrl).toBeTruthy();
    });
  });

  describe('POST /api/audio — multipart (SEC-M3, P7)', () => {
    beforeAll(async () => {
      await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [userId]);
    });

    const baseFields = () => ({
      eventId,
      guestId: `guest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      guestName: 'Spec Guest',
      durationSeconds: '5',
    });

    it('rejects a request with no audio file at all', async () => {
      // A real multipart body, just missing the file part.
      const boundary = `----NoFile${Date.now()}`;
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="eventId"\r\n\r\n${eventId}\r\n--${boundary}--\r\n`
      );
      const res = await fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('rejects bytes matching no known audio/image signature', async () => {
      const garbage = Buffer.from('this is not media of any kind, just text');
      const { body, contentType } = buildMultipartAudio(garbage, baseFields());
      const res = await fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('accepts a real WebM magic-byte header sent as multipart, not base64-in-JSON', async () => {
      const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
      const { body, contentType } = buildMultipartAudio(webmHeader, baseFields());
      const res = await fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      expect(res.status).toBe(201);
      const resBody = await res.json();
      expect(resBody.audioUrl).toBeTruthy();
      // The stored URL is a real path this server generated, not an echo of
      // anything the client sent (SEC-A1's audio analog).
      expect(resBody.audioUrl).toContain('/uploads/');
    });
  });

  describe('buildDerivatives pixel cap (SEC-M2)', () => {
    it('rejects an image over the input-pixel limit instead of decoding it fully', async () => {
      // 7200x6000 = 43.2M pixels, just over the 40M cap. A solid-color PNG
      // this size is cheap for sharp to synthesize and still exercises the
      // real limitInputPixels check on the encoded bytes it produces.
      const oversized = await sharp({
        create: { width: 7200, height: 6000, channels: 3, background: { r: 10, g: 10, b: 10 } },
      })
        .png()
        .toBuffer();

      await expect(buildDerivatives(oversized)).rejects.toThrow();
    }, 20000);

    it('still accepts an image comfortably under the limit', async () => {
      const normal = await sharp({
        create: { width: 1200, height: 900, channels: 3, background: { r: 50, g: 60, b: 70 } },
      })
        .jpeg()
        .toBuffer();

      const derived = await buildDerivatives(normal);
      expect(derived.width).toBeGreaterThan(0);
      expect(derived.thumbnail.length).toBeGreaterThan(0);
    });
  });

  describe('buildDerivatives EXIF orientation (MED-07)', () => {
    it('reports post-rotation dimensions for a sideways phone photo instead of the raw swapped ones', async () => {
      // A landscape-stored 400x300 buffer tagged EXIF orientation 6 (rotate
      // 90deg CW to display correctly) — exactly what a phone camera does
      // for a portrait shot. Displayed correctly, this is a 300x400 image.
      const sidewaysPortrait = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 100, b: 50 } },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();

      const derived = await buildDerivatives(sidewaysPortrait);
      expect(derived.width).toBe(300);
      expect(derived.height).toBe(400);
    });
  });
});
