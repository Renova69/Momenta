import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import sharp from 'sharp';

import { photosRouter } from '../../server/routes/photos';
import { audioRouter } from '../../server/routes/audio';
import { query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';
import { deleteEventFixtures } from '../helpers/cleanup';
import { PLAN_LIMITS } from '../../server/lib/planLimits';

/**
 * N-78 — a phone queues a photo or voice message it could not send and sends
 * it again later. When the server had stored the first attempt but its answer
 * never reached the phone, the replay was stored a second time: the same
 * photo twice in the album, on the wall, and against the plan's allowance.
 *
 * Each upload carries an id the phone gave it (`localId`). A second upload
 * with the same id from the same guest returns the row already stored.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)]);

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/photos', photosRouter);
  app.use('/api/audio', audioRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 120, b: 90 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** An album on a plan with voice messages, created in SQL. */
async function album(): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Replay Host', 'x', 'couple') RETURNING id`,
    [`replay-${tag}@test.com`]
  );
  await query(
    `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit)
     VALUES ($1, 'deluxe_keepsake', 'active', 'one_time', 0, 'EUR', 1)`,
    [user.rows[0].id]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id)
     VALUES ($1, 'Replay Spec', 'Spec Host', 'replay@test.local', CURRENT_DATE, $2) RETURNING id`,
    [`replay-${tag}`, user.rows[0].id]
  );
  createdEvents.push(event.rows[0].id);
  return event.rows[0].id;
}

function postPhoto(eventId: string, fingerprint: string, localId: string | undefined) {
  return fetch(`${baseUrl}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Replay Guest',
      deviceFingerprint: fingerprint,
      fullUrl: jpegDataUrl,
      caption: 'sent twice',
      ...(localId ? { localId } : {}),
    }),
  });
}

/** Built by hand, as audioGuestbookRoutes.spec.ts does, so the fields are where multer reads them. */
function postAudio(eventId: string, fingerprint: string, localId: string) {
  const boundary = `----ReplaySpec${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const fields: Record<string, string> = { eventId, guestName: 'Replay Guest', localId };
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="message.webm"\r\n` +
        'Content-Type: audio/webm\r\n\r\n'
    ),
    WEBM,
    Buffer.from('\r\n'),
  ];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return fetch(`${baseUrl}/api/audio`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'x-device-fingerprint': fingerprint },
    // Node's fetch accepts a Buffer body at runtime; DOM's BodyInit type just doesn't know about it.
    body: Buffer.concat(parts) as unknown as BodyInit,
  });
}

async function count(table: 'photos' | 'audio_guestbook', eventId: string): Promise<number> {
  const { rows } = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE event_id = $1`, [eventId]);
  return rows[0].n;
}

async function storedBytes(eventId: string): Promise<number> {
  const { rows } = await query<{ b: string }>('SELECT storage_bytes AS b FROM events WHERE id = $1', [eventId]);
  return Number(rows[0].b);
}

const fp = () => `replay-fp-${Math.random().toString(36).slice(2, 10)}`;

describe('a photo sent again after its answer was lost (N-78)', () => {
  it('is stored once, and the replay is answered with the stored photo', async () => {
    const eventId = await album();
    const device = fp();
    const first = await postPhoto(eventId, device, 'photo-1700000000000-abc');
    const bytesAfterFirst = await storedBytes(eventId);

    const replay = await postPhoto(eventId, device, 'photo-1700000000000-abc');

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const [a, b] = [await first.json(), await replay.json()];
    expect(b.id).toBe(a.id);
    expect(b.localId).toBe('photo-1700000000000-abc');
    expect(await count('photos', eventId)).toBe(1);
    expect(await storedBytes(eventId)).toBe(bytesAfterFirst);
  });

  it('is stored once when both copies arrive at the same time', async () => {
    const eventId = await album();
    const device = fp();

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => postPhoto(eventId, device, 'photo-1700000000001-race'))
    );

    expect(responses.every((r) => r.ok)).toBe(true);
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
    expect(await count('photos', eventId)).toBe(1);
  });

  it('is answered with the stored photo even when that photo filled the plan', async () => {
    // Refused as over the limit, the phone would retry it and finally report
    // as lost a photo that is in the album.
    const eventId = await album();
    await query("UPDATE subscriptions SET tier = 'free' WHERE user_id = (SELECT host_user_id FROM events WHERE id = $1)", [
      eventId,
    ]);
    const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'Others') RETURNING id`, [
      eventId,
    ]);
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
       SELECT $1, $2, '/uploads/fill-' || i || '.jpg', 'http://x/fill-' || i || '.jpg', 'approved', 0
         FROM generate_series(1, 49) AS i`,
      [eventId, guest.rows[0].id]
    );
    const device = fp();
    const last = await postPhoto(eventId, device, 'photo-the-fiftieth');
    expect(last.status).toBe(201);

    const replay = await postPhoto(eventId, device, 'photo-the-fiftieth');

    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe((await last.json()).id);
  });

  it('still stores two photos that carry different ids', async () => {
    const eventId = await album();
    const device = fp();

    await postPhoto(eventId, device, 'photo-1-a');
    await postPhoto(eventId, device, 'photo-1-b');

    expect(await count('photos', eventId)).toBe(2);
  });

  it('still stores two photos that carry no id at all', async () => {
    const eventId = await album();
    const device = fp();

    await postPhoto(eventId, device, undefined);
    await postPhoto(eventId, device, undefined);

    expect(await count('photos', eventId)).toBe(2);
  });

  it('does not hand one guest another guest photo that happens to share an id', async () => {
    const eventId = await album();
    const mine = await postPhoto(eventId, fp(), 'photo-shared-id');
    // A guest already known to the album, so the replay lookup runs for them.
    const otherDevice = fp();
    expect((await postPhoto(eventId, otherDevice, 'photo-their-first')).status).toBe(201);

    const theirs = await postPhoto(eventId, otherDevice, 'photo-shared-id');

    expect(theirs.status).toBe(201);
    expect((await theirs.json()).id).not.toBe((await mine.json()).id);
    expect(await count('photos', eventId)).toBe(3);
  });
});

/**
 * N-99 — two copies of one upload arriving together, with room for only one:
 * both passed the early checks before either was stored, and the second was
 * then refused by the locked re-check at the limit the first had just
 * reached. The phone was told a stored upload had been refused and reported
 * it lost.
 */
describe('two copies of one upload arriving together at a full limit (N-99)', () => {
  /** Slow every storage write, so both copies are past the early checks before either is stored. */
  function slowStorage() {
    const real = storageAdapter.save.bind(storageAdapter);
    vi.spyOn(storageAdapter, 'save').mockImplementation(async (...args: Parameters<typeof real>) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return real(...args);
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers the second copy of a photo with the stored one, not with the cap', async () => {
    const eventId = await album();
    await query('UPDATE events SET max_photos_per_guest = 1 WHERE id = $1', [eventId]);
    const device = fp();
    await query(`INSERT INTO guests (event_id, name, device_fingerprint) VALUES ($1, 'Replay Guest', $2)`, [
      eventId,
      device,
    ]);
    slowStorage();

    const [a, b] = await Promise.all([
      postPhoto(eventId, device, 'photo-race-at-cap'),
      postPhoto(eventId, device, 'photo-race-at-cap'),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).id).toBe((await b.json()).id);
    expect(await count('photos', eventId)).toBe(1);
  });

  it('answers the second copy of a voice message with the stored one, not with the allowance', async () => {
    const eventId = await album();
    // Room for exactly one recording.
    await query('UPDATE events SET storage_bytes = $2 WHERE id = $1', [
      eventId,
      PLAN_LIMITS.deluxe_keepsake.storageBytes - WEBM.length - 10,
    ]);
    const device = fp();
    await query(`INSERT INTO guests (event_id, name, device_fingerprint) VALUES ($1, 'Replay Guest', $2)`, [
      eventId,
      device,
    ]);
    slowStorage();

    const [a, b] = await Promise.all([
      postAudio(eventId, device, 'audio-race-at-limit'),
      postAudio(eventId, device, 'audio-race-at-limit'),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await count('audio_guestbook', eventId)).toBe(1);
  });
});

describe('a voice message sent again after its answer was lost (N-78)', () => {
  it('is stored once, and the replay is answered with the stored message', async () => {
    const eventId = await album();
    const device = fp();
    const first = await postAudio(eventId, device, 'audio-1700000000000-xyz');

    const replay = await postAudio(eventId, device, 'audio-1700000000000-xyz');

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe((await first.json()).id);
    expect(await count('audio_guestbook', eventId)).toBe(1);
  });

  it('is answered with the stored message even when the album has since filled up', async () => {
    const eventId = await album();
    const device = fp();
    const first = await postAudio(eventId, device, 'audio-before-full');
    expect(first.status).toBe(201);
    await query('UPDATE events SET storage_bytes = $2 WHERE id = $1', [eventId, PLAN_LIMITS.deluxe_keepsake.storageBytes]);

    const replay = await postAudio(eventId, device, 'audio-before-full');

    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe((await first.json()).id);
  });

  it('is stored once when both copies arrive at the same time', async () => {
    const eventId = await album();
    const device = fp();

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => postAudio(eventId, device, 'audio-1700000000001-race'))
    );

    expect(responses.every((r) => r.ok)).toBe(true);
    expect(await count('audio_guestbook', eventId)).toBe(1);
  });
});
