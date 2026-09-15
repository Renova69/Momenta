import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { CONFIG } from '../../server/lib/config';
import { storageAdapter } from '../../server/lib/storage';
import { purgeEventMedia } from '../../server/lib/retention';
import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { query, pool } from '../../server/lib/db';

/**
 * Live Cloudflare R2 integration — run with `npm run test:storage:r2`, never
 * as part of the default unit suite (see vitest.r2.config.ts for why).
 *
 * What this covers that nothing else does: that the account id, access key,
 * bucket name and PUBLIC hostname in .env actually work together against the
 * real service. storageAdapter.spec.ts mocks the S3 client, so it proves the
 * adapter's logic and nothing about the credentials.
 *
 * The public-URL assertions matter most. R2_PUBLIC_URL is a different
 * hostname from the S3 API endpoint, and getting it wrong (or forgetting to
 * enable public access on the bucket) means every upload succeeds and is then
 * permanently unloadable in a browser — silent breakage discovered only when a
 * guest reports a blank gallery.
 */

const TEST_PORT = 6640;
const BASE_URL = `http://localhost:${TEST_PORT}`;

/** Namespaces every key this suite writes, so cleanup is unambiguous. */
const scratchEventId = `itest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const writtenPaths: string[] = [];
const createdEvents: string[] = [];

let server: ReturnType<typeof createServer>;
let jpeg: Buffer;

async function save(name: string, bytes: Buffer = jpeg) {
  const saved = await storageAdapter.save(bytes, name, 'image/jpeg', scratchEventId);
  writtenPaths.push(saved.storagePath);
  return saved;
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  // A misconfigured run should say so immediately, rather than failing later
  // as a confusing pile of network errors.
  if (CONFIG.STORAGE_PROVIDER !== 'r2') {
    throw new Error(`This lane requires STORAGE_PROVIDER=r2, got "${CONFIG.STORAGE_PROVIDER}"`);
  }
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL'] as const) {
    if (!CONFIG[key]) throw new Error(`This lane requires real credentials — ${key} is empty in .env`);
  }

  jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 190, g: 120, b: 70 } } })
    .jpeg()
    .toBuffer();

  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  // Leave the live bucket as we found it, even if assertions failed.
  //
  // Order matters, and getting it wrong is this repository's most-repeated
  // bug. `writtenPaths` only holds objects this file saved directly; the
  // upload test posts through the API, so the server writes those variants and
  // the `photos` rows are the only record of where they went. Deleting the
  // event first cascades those rows away and strands the objects in a live
  // bucket with nothing left that could ever find them — which is what was
  // happening: a run left a photo and its thumbnail behind every time, and
  // scheduling this lane nightly would have made that a standing leak.
  //
  // purgeEventMedia is the same function the retention sweep uses. Called
  // before the rows go, not after.
  for (const eventId of createdEvents) {
    await purgeEventMedia(eventId).catch(() => undefined);
  }
  await Promise.allSettled(writtenPaths.map((p) => storageAdapter.delete(p)));
  if (createdEvents.length > 0) {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
  }
  if (server) server.close();
  await pool.end().catch(() => undefined);
});

describe('R2 adapter against the live bucket', () => {
  it('saves an object and serves it from the public hostname', async () => {
    const saved = await save('live-roundtrip.jpg');

    expect(saved.publicUrl.startsWith(CONFIG.R2_PUBLIC_URL)).toBe(true);

    const res = await fetch(saved.publicUrl);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(jpeg.length);
  });

  it('reads the object back through getStream, byte for byte', async () => {
    const saved = await save('live-getstream.jpg');

    const stream = await storageAdapter.getStream(saved.storagePath);
    expect(stream).not.toBeNull();
    expect(Buffer.compare(await drain(stream!), jpeg)).toBe(0);
  });

  it('returns null for a key that does not exist, rather than throwing', async () => {
    // The distinction a purge depends on: missing is not an error.
    expect(await storageAdapter.getStream(`events/${scratchEventId}/definitely-not-here.jpg`)).toBeNull();
  });

  it('delete really removes the object from the bucket', async () => {
    const saved = await storageAdapter.save(jpeg, 'live-delete.jpg', 'image/jpeg', scratchEventId);

    expect((await fetch(saved.publicUrl)).status).toBe(200);
    await storageAdapter.delete(saved.storagePath);

    // R2 is strongly consistent for deletes, so no polling needed.
    expect((await fetch(saved.publicUrl)).ok).toBe(false);
    expect(await storageAdapter.getStream(saved.storagePath)).toBeNull();
  });

  it('handles a concurrent upload burst without dropping or corrupting any object', async () => {
    // The case a wedding actually produces: everyone photographs the first
    // dance at once. Previous load work only ever exercised local disk.
    const BURST = 10;
    const bodies = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        sharp({ create: { width: 200 + i, height: 150, channels: 3, background: { r: i * 20, g: 90, b: 140 } } })
          .jpeg()
          .toBuffer()
      )
    );

    const saved = await Promise.all(bodies.map((bytes, i) => save(`live-burst-${i}.jpg`, bytes)));

    expect(new Set(saved.map((s) => s.storagePath)).size).toBe(BURST);

    const fetched = await Promise.all(saved.map((s) => fetch(s.publicUrl)));
    expect(fetched.every((r) => r.status === 200)).toBe(true);

    // Each URL must return ITS OWN bytes — a collision would still 200.
    const lengths = await Promise.all(fetched.map(async (r) => (await r.arrayBuffer()).byteLength));
    expect(lengths).toEqual(bodies.map((b) => b.length));
  });
});

describe('the app pipeline against live R2', () => {
  it('stores an uploaded photo and both derivatives in R2, publicly readable', async () => {
    const reg = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `r2-itest-${Date.now()}@test.com`,
        fullName: 'R2 Integration Host',
        password: 'Password123!',
      }),
    });
    const { event } = await reg.json();
    createdEvents.push(event.id);

    const up = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        guestName: 'R2 Integration Guest',
        deviceFingerprint: `r2-itest-${Date.now()}`,
        fullUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      }),
    });
    expect(up.status).toBe(201);
    const photo = await up.json();

    // Not just "an upload succeeded" — the URLs handed to the browser have to
    // be the public R2 host, and they have to actually load.
    for (const url of [photo.fullUrl, photo.thumbnailUrl] as string[]) {
      expect(url.startsWith(CONFIG.R2_PUBLIC_URL)).toBe(true);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).length).toBeGreaterThan(0);
    }

    const row = await query('SELECT storage_path FROM photos WHERE id = $1', [photo.id]);
    expect(row.rows[0].storage_path).toContain(CONFIG.R2_PUBLIC_URL);
  });
});
