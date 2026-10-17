import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { eventsRouter } from '../../server/routes/events';
import { checkUploadAllowance, type UploadContext } from '../../server/middleware/tierGate';
import { pool } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-159 — an album whose time is up stops taking new things.
 *
 * Every plan sells a period of "active access" (seven days after the wedding
 * on the free plan), but nothing read `expires_at`: an album stayed fully open
 * until the retention sweep deleted it, and that sweep is switched off (U-4).
 * From `expires_at` an album is read-only for guests: looking and downloading
 * stay, new photos, voice messages, comments and reactions stop. A plan that
 * moves `expires_at` forward opens it again.
 */

const TEST_PORT = 6683;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];
let jpegDataUrl = '';

let eventId = '';
let photoId = '';
let guestId = '';
let guestToken = '';
let hostToken = '';

function post(path: string, body: Record<string, unknown>, fingerprint = `closed-${Math.random().toString(36).slice(2, 9)}`) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': fingerprint },
    body: JSON.stringify(body),
  });
}

function uploadPhoto() {
  return post('/api/photos', { eventId, guestName: 'Ana', fullUrl: jpegDataUrl, deviceFingerprint: `closed-${Date.now()}-${Math.random()}` });
}

async function setExpiry(when: 'past' | 'future' | null): Promise<void> {
  const value = when === null ? null : new Date(Date.now() + (when === 'past' ? -3600_000 : 7 * 86400_000));
  await pool.query('UPDATE events SET expires_at = $2 WHERE id = $1', [eventId, value]);
}

/** A refusal's status and code, to compare in one assertion. */
async function refusal(res: Response): Promise<{ status: number; code: string | undefined }> {
  return { status: res.status, code: (await res.json()).code };
}

const CLOSED = { status: 403, code: 'ALBUM_CLOSED' };

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 160, b: 200 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  const reg = await post('/api/auth/register', {
    email: `closed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
    fullName: 'Closed Spec Host',
    password: 'Password123!',
  });
  const data = await reg.json();
  eventId = data.event.id;
  hostToken = data.token;
  createdEvents.push(eventId);

  // A photo taken while the album was open, to engage with once it is not.
  const first = await uploadPhoto();
  const photo = await first.json();
  photoId = photo.id;
  guestId = photo.guestId;
  guestToken = photo.guestToken;
}, 30_000);

afterAll(async () => {
  if (server) server.close();
  await deleteEventFixtures(createdEvents);
});

describe('an album past its expires_at (N-159)', () => {
  it('takes no new photo', async () => {
    await setExpiry('past');
    expect(await refusal(await uploadPhoto())).toEqual(CLOSED);
  });

  it('takes no like, reaction or comment', async () => {
    await setExpiry('past');

    expect(await refusal(await post(`/api/photos/${photoId}/like`, { guestId, guestToken }))).toEqual(CLOSED);
    expect(await refusal(await post(`/api/photos/${photoId}/reactions`, { guestId, guestToken, reaction: 'heart' }))).toEqual(CLOSED);
    expect(await refusal(await post(`/api/photos/${photoId}/comments`, { guestId, guestToken, commentText: 'Честито!' }))).toEqual(CLOSED);
  });

  it('takes no live reaction for the screen', async () => {
    await setExpiry('past');
    expect(await refusal(await post(`/api/events/${eventId}/reactions`, { reaction: 'heart' }))).toEqual(CLOSED);
  });

  it('can still be looked at', async () => {
    await setExpiry('past');

    const feed = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}&limit=50`);
    const album = await fetch(`${BASE_URL}/api/events/slug/${(await (await fetch(`${BASE_URL}/api/events/${eventId}`)).json()).slug}`);

    expect(feed.status).toBe(200);
    expect((await feed.json()).map((p: { id: string }) => p.id)).toContain(photoId);
    expect(album.status).toBe(200);
  });

  it('tells a guest when it closed', async () => {
    await setExpiry('past');
    const event = await (await fetch(`${BASE_URL}/api/events/${eventId}`)).json();
    const album = await (await fetch(`${BASE_URL}/api/events/slug/${event.slug}`)).json();

    expect(album.expires_at).toBeTruthy();
  });

  it('opens again when the deadline moves forward, as a plan bought later does', async () => {
    await setExpiry('future');
    expect((await uploadPhoto()).status).toBe(201);
  });

  // The deadline is counted from the wedding. Moving the wedding later used
  // to leave it where it was, which once it closes the album would shut it
  // before the new date.
  it('moves the deadline with the wedding date', async () => {
    await setExpiry('past');
    const newDate = new Date(Date.now() + 60 * 86400_000).toISOString();

    const res = await fetch(`${BASE_URL}/api/events/${eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventDate: newDate }),
    });
    const saved = await res.json();

    expect(res.status).toBe(200);
    expect(new Date(saved.expires_at).getTime()).toBeGreaterThan(new Date(newDate).getTime());
    expect((await uploadPhoto()).status).toBe(201);
  });

  it('never closes an album with no deadline, such as a Pro Planner one', async () => {
    await setExpiry(null);
    expect((await uploadPhoto()).status).toBe(201);
  });
});

describe('the allowance every upload path checks (photos, voice messages, the photographer)', () => {
  const context = (expiresAt: Date | null): UploadContext => ({
    eventId: 'e',
    hostUserId: 'h',
    tier: 'free',
    usedBytes: 0,
    limitBytes: 1_000_000,
    pooled: false,
    photoCount: 0,
    maxPhotos: 50,
    devicePhotoCount: 0,
    isModerationEnabled: false,
    isDisposableMode: false,
    revealAt: null,
    maxPhotosPerGuest: null,
    expiresAt,
  });

  it('refuses once the album has closed', () => {
    const verdict = checkUploadAllowance(context(new Date(Date.now() - 1000)));
    expect(verdict).toMatchObject({ allowed: false, code: 'ALBUM_CLOSED' });
  });

  it('allows while the album is open, or has no deadline', () => {
    expect(checkUploadAllowance(context(new Date(Date.now() + 60_000))).allowed).toBe(true);
    expect(checkUploadAllowance(context(null)).allowed).toBe(true);
  });
});
