import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';
import { purgeEventMedia } from '../../server/lib/retention';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-139 — nothing set an album's cover. The album's top section is designed
 * around one and `PUT /api/events/:id` took any URL for it, but no screen wrote
 * one, and since N-131 no album had a stock cover either.
 *
 * `POST /api/events/:id/cover` now sets it, from a photo the host uploads (an
 * engagement photo, weeks before there is an album to pick from) or from one
 * of the album's own photos a guest can already see. Either way the server
 * keeps its own copy, sized for the page: deleting or rejecting the photo later
 * cannot break the cover, and a photo still waiting for moderation or for the
 * disposable reveal cannot be shown through it. The cover is set only here;
 * the general album update no longer takes a URL for it.
 */

const TEST_PORT = 6680;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let bigJpeg = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  eventId: string;
  slug: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `cover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Cover Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, eventId: data.event.id, slug: data.event.slug };
}

function setCover(host: Host, body: Record<string, unknown>, eventId = host.eventId) {
  return fetch(`${BASE_URL}/api/events/${eventId}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify(body),
  });
}

function removeCover(host: Host) {
  return fetch(`${BASE_URL}/api/events/${host.eventId}/cover`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${host.token}` },
  });
}

/** A guest's photo, published straight away (moderation is off by default). */
async function guestPhoto(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Cover Spec Guest',
      deviceFingerprint: `cover-fp-${Math.random().toString(36).slice(2, 10)}`,
      fullUrl: bigJpeg,
    }),
  });
  const photo = await res.json();
  if (res.status !== 201) throw new Error(`photo upload failed: ${res.status} ${JSON.stringify(photo)}`);
  return photo.id as string;
}

async function storedCover(eventId: string): Promise<string | null> {
  const { rows } = await query<{ cover_image_url: string | null }>('SELECT cover_image_url FROM events WHERE id = $1', [eventId]);
  return rows[0]?.cover_image_url ?? null;
}

/** The file on local disk a stored URL points at. */
function fileFor(url: string): string {
  const marker = url.indexOf('/uploads/');
  return path.join(CONFIG.UPLOADS_DIR, url.substring(marker + '/uploads/'.length));
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/photos', photosRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  const jpeg = await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: { r: 180, g: 140, b: 110 } },
  })
    .jpeg()
    .toBuffer();
  bigJpeg = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('setting an album cover from an upload (N-139)', () => {
  it('stores its own copy under the album, sized for the page', async () => {
    const host = await registerHost();

    const res = await setCover(host, { image: bigJpeg });

    expect(res.status).toBe(200);
    const { coverImageUrl } = await res.json();
    expect(coverImageUrl).toMatch(new RegExp(`/events/${host.eventId}/cover-\\d+-[a-z0-9]+\\.jpg$`));
    expect(await storedCover(host.eventId)).toBe(coverImageUrl);
    const { width, height } = await sharp(fileFor(coverImageUrl)).metadata();
    expect(Math.max(width ?? 0, height ?? 0)).toBeLessThanOrEqual(1600);
  });

  it('shows it to guests', async () => {
    const host = await registerHost();
    const { coverImageUrl } = await (await setCover(host, { image: bigJpeg })).json();

    const album = await (await fetch(`${BASE_URL}/api/events/slug/${host.slug}`)).json();

    expect(album.cover_image_url).toBe(coverImageUrl);
  });

  it('removes the cover it replaces', async () => {
    const host = await registerHost();
    const first = (await (await setCover(host, { image: bigJpeg })).json()).coverImageUrl;

    await setCover(host, { image: bigJpeg });

    expect(fs.existsSync(fileFor(first))).toBe(false);
  });

  it('refuses a file that is not an image', async () => {
    const host = await registerHost();

    const res = await setCover(host, { image: `data:image/jpeg;base64,${Buffer.from('not a picture').toString('base64')}` });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NOT_AN_IMAGE');
  });

  it("refuses another host's album, and anyone signed out", async () => {
    const host = await registerHost();
    const other = await registerHost();

    expect((await setCover(other, { image: bigJpeg }, host.eventId)).status).toBe(403);
    const signedOut = await fetch(`${BASE_URL}/api/events/${host.eventId}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: bigJpeg }),
    });
    expect(signedOut.status).toBe(401);
    expect(await storedCover(host.eventId)).toBeNull();
  });

  it('refuses while the album is being deleted', async () => {
    const host = await registerHost();
    await query('UPDATE events SET deleting_at = NOW() WHERE id = $1', [host.eventId]);

    const res = await setCover(host, { image: bigJpeg });

    expect(res.status).toBe(409);
    expect(await storedCover(host.eventId)).toBeNull();
    await query('UPDATE events SET deleting_at = NULL WHERE id = $1', [host.eventId]);
  });
});

describe('setting an album cover from one of its photos (N-139)', () => {
  it('copies a photo guests can see', async () => {
    const host = await registerHost();
    const photoId = await guestPhoto(host.eventId);

    const res = await setCover(host, { photoId });

    expect(res.status).toBe(200);
    const { coverImageUrl } = await res.json();
    expect(coverImageUrl).toMatch(/\/cover-\d+-[a-z0-9]+\.jpg$/);
    expect(fs.existsSync(fileFor(coverImageUrl))).toBe(true);
  });

  it('keeps the cover when that photo is deleted afterwards', async () => {
    const host = await registerHost();
    const photoId = await guestPhoto(host.eventId);
    const { coverImageUrl } = await (await setCover(host, { photoId })).json();

    const del = await fetch(`${BASE_URL}/api/photos/${photoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${host.token}` },
    });

    expect(del.status).toBe(200);
    expect(fs.existsSync(fileFor(coverImageUrl))).toBe(true);
  });

  it.each([
    ['waiting for moderation', "status = 'pending'"],
    ['rejected', "status = 'rejected'"],
    ['still quarantined', 'is_quarantined = true'],
  ])('refuses a photo %s', async (_label, change) => {
    const host = await registerHost();
    const photoId = await guestPhoto(host.eventId);
    await query(`UPDATE photos SET ${change} WHERE id = $1`, [photoId]);

    const res = await setCover(host, { photoId });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PHOTO_NOT_PUBLIC');
    expect(await storedCover(host.eventId)).toBeNull();
  });

  it('refuses a photo locked until the disposable reveal', async () => {
    const host = await registerHost();
    const photoId = await guestPhoto(host.eventId);
    await query(
      "UPDATE events SET is_disposable_mode = true, reveal_at = NOW() + INTERVAL '1 day' WHERE id = $1",
      [host.eventId]
    );
    await query('UPDATE photos SET is_locked = true WHERE id = $1', [photoId]);

    const res = await setCover(host, { photoId });

    expect(res.status).toBe(409);
  });

  it("refuses another album's photo", async () => {
    const host = await registerHost();
    const other = await registerHost();
    const theirs = await guestPhoto(other.eventId);

    const res = await setCover(host, { photoId: theirs });

    expect(res.status).toBe(404);
  });
});

describe('removing and keeping covers (N-139)', () => {
  it('removes the cover and its file', async () => {
    const host = await registerHost();
    const { coverImageUrl } = await (await setCover(host, { image: bigJpeg })).json();

    const res = await removeCover(host);

    expect(res.status).toBe(200);
    expect(await storedCover(host.eventId)).toBeNull();
    expect(fs.existsSync(fileFor(coverImageUrl))).toBe(false);
  });

  it('is not set through the general album update', async () => {
    const host = await registerHost();

    const res = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ coverImageUrl: 'https://tracker.example/pixel.jpg', title: 'Still saved' }),
    });

    expect(res.status).toBe(200);
    expect(await storedCover(host.eventId)).toBeNull();
  });

  it('goes with the album', async () => {
    const host = await registerHost();
    const { coverImageUrl } = await (await setCover(host, { image: bigJpeg })).json();

    await purgeEventMedia(host.eventId);

    expect(fs.existsSync(fileFor(coverImageUrl))).toBe(false);
  });
});
