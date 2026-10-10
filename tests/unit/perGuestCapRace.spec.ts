import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import sharp from 'sharp';

import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-84 — the host's per-guest photo cap was checked once, before the photo
 * was decoded and saved, and never again under the album's upload lock. A
 * phone sending several photos at once had every one of them pass the check
 * against the same count, and all of them stored.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/photos', photosRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 60, g: 30, b: 90 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function albumWithCap(cap: number): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, max_photos_per_guest)
     VALUES ($1, 'Cap Spec', 'Spec Host', 'cap@test.local', CURRENT_DATE, $2) RETURNING id`,
    [`cap-${tag}`, cap]
  );
  createdEvents.push(event.rows[0].id);
  return event.rows[0].id;
}

function upload(eventId: string, device: string, caption: string) {
  return fetch(`${baseUrl}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, guestName: 'Cap Guest', deviceFingerprint: device, fullUrl: jpegDataUrl, caption }),
  });
}

async function photoCount(eventId: string): Promise<number> {
  const { rows } = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1', [eventId]);
  return rows[0].n;
}

describe('the per-guest photo cap under parallel uploads (N-84)', () => {
  it('stores no more than the cap when one phone sends several at once', async () => {
    const eventId = await albumWithCap(2);
    const device = `cap-fp-${Math.random().toString(36).slice(2, 10)}`;
    // The guest row exists first, as it would after the guest's first photo.
    await query(`INSERT INTO guests (event_id, name, device_fingerprint) VALUES ($1, 'Cap Guest', $2)`, [
      eventId,
      device,
    ]);

    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => upload(eventId, device, `burst ${i}`)));

    expect(await photoCount(eventId)).toBe(2);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(3);
  });

  it('refuses at the cap with the same answer as before, so the phone does not retry', async () => {
    const eventId = await albumWithCap(1);
    const device = `cap-fp-${Math.random().toString(36).slice(2, 10)}`;
    expect((await upload(eventId, device, 'first')).status).toBe(201);

    const second = await upload(eventId, device, 'second');

    expect(second.status).toBe(429);
    expect((await second.json()).error).toMatch(/Photo limit reached/);
  });

  it('counts each phone on its own', async () => {
    const eventId = await albumWithCap(1);

    const responses = await Promise.all(
      Array.from({ length: 3 }, (_, i) => upload(eventId, `cap-fp-own-${i}-${Date.now()}`, `phone ${i}`))
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(await photoCount(eventId)).toBe(3);
  });
});
