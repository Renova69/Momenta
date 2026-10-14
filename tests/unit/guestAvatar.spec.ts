import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { guestsRouter } from '../../server/routes/guests';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';
import { purgeEventMedia } from '../../server/lib/retention';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-107 — a guest who added the optional selfie could not use the album.
 *
 * The onboarding modal sent the selfie as a `data:` URL in `avatarUrl`, which
 * `POST /api/guests` caps at 1,000 characters and every image exceeds. The
 * guest was never registered, so every like was refused, and every photo was
 * refused too, because the upload carried the same `data:` URL as
 * `guestAvatar` against a 500-character cap.
 *
 * A selfie is a file, so it is now stored as one: `POST /api/guests/:id/avatar`
 * takes the image from a guest who proves the identity with their token, stores
 * a small square JPEG under the album, and records its URL. Registration and
 * uploads only ever carry that URL, and an old client still sending a `data:`
 * URL is answered as if it had sent no picture rather than refused outright.
 */

const TEST_PORT = 6673;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

async function registerHost(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `avatar-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Avatar Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return data.event.id as string;
}

function join(eventId: string, extra: Record<string, unknown> = {}) {
  return fetch(`${BASE_URL}/api/guests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      name: 'Avatar Spec Guest',
      deviceFingerprint: `avatar-fp-${Math.random().toString(36).slice(2, 10)}`,
      ...extra,
    }),
  });
}

async function joinWithToken(eventId: string): Promise<{ id: string; guestToken: string }> {
  const res = await join(eventId);
  return res.json();
}

function setAvatar(guestId: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/guests/${guestId}/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The file on local disk a stored avatar URL points at. */
function fileFor(avatarUrl: string): string {
  const marker = avatarUrl.indexOf('/uploads/');
  return path.join(CONFIG.UPLOADS_DIR, avatarUrl.substring(marker + '/uploads/'.length));
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  app.use('/api/guests', guestsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  const jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('a guest who adds a selfie can still use the album (N-107)', () => {
  it('registers a guest whose old client still sends the selfie inline, without the picture', async () => {
    const eventId = await registerHost();

    const res = await join(eventId, { avatarUrl: jpegDataUrl });

    expect(res.status).toBe(201);
    const guest = await res.json();
    expect(guest.guestToken).toBeTruthy();
    expect(guest.avatarUrl).toBeNull();
  });

  it('accepts a photo whose old client still sends the selfie inline', async () => {
    const eventId = await registerHost();

    const res = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestName: 'Avatar Spec Guest',
        guestAvatar: jpegDataUrl,
        deviceFingerprint: `avatar-photo-${Math.random().toString(36).slice(2, 10)}`,
        fullUrl: jpegDataUrl,
      }),
    });

    expect(res.status).toBe(201);
  });

  it('stores the selfie as a small square file under the album and records its URL', async () => {
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);

    const res = await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl });

    expect(res.status).toBe(200);
    const { avatarUrl } = await res.json();
    expect(avatarUrl).toContain(`/events/${eventId}/`);
    expect(avatarUrl.length).toBeLessThanOrEqual(500);

    const meta = await sharp(fileFor(avatarUrl)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);

    const { rows } = await query('SELECT avatar_url FROM guests WHERE id = $1', [guest.id]);
    expect(rows[0].avatar_url).toBe(avatarUrl);
  });

  it('shows the stored selfie on the photos the guest uploads', async () => {
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);
    const { avatarUrl } = await (await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl })).json();

    const upload = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestId: guest.id,
        guestToken: guest.guestToken,
        guestName: 'Avatar Spec Guest',
        guestAvatar: avatarUrl,
        fullUrl: jpegDataUrl,
      }),
    });
    expect(upload.status).toBe(201);

    const feed = await (await fetch(`${BASE_URL}/api/photos?eventId=${eventId}`)).json();
    expect(feed[0].guestAvatar).toBe(avatarUrl);
  });

  it('answers and broadcasts the picture on record, not the one the upload carried', async () => {
    // The upload's answer is also the PHOTO_ADDED broadcast every guest in the
    // room receives, and it echoed whatever the client sent as guestAvatar —
    // an address on another host, fetched by every phone at the wedding.
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);
    const { avatarUrl } = await (await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl })).json();

    const upload = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestId: guest.id,
        guestToken: guest.guestToken,
        guestName: 'Avatar Spec Guest',
        guestAvatar: 'https://tracker.example/pixel.gif',
        fullUrl: jpegDataUrl,
      }),
    });

    expect((await upload.json()).guestAvatar).toBe(avatarUrl);
  });

  it('removes the previous selfie when the guest replaces it', async () => {
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);
    const first = (await (await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl })).json()).avatarUrl;

    const second = await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl });

    expect(second.status).toBe(200);
    expect(fs.existsSync(fileFor(first))).toBe(false);
    expect(fs.existsSync(fileFor((await second.json()).avatarUrl))).toBe(true);
  });

  it('refuses a caller who cannot prove the guest is theirs', async () => {
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);
    const other = await joinWithToken(eventId);

    const noToken = await setAvatar(guest.id, { eventId, image: jpegDataUrl });
    const wrongToken = await setAvatar(guest.id, { eventId, guestToken: other.guestToken, image: jpegDataUrl });

    expect(noToken.status).toBe(401);
    expect(wrongToken.status).toBe(401);
    const { rows } = await query('SELECT avatar_url FROM guests WHERE id = $1', [guest.id]);
    expect(rows[0].avatar_url).toBeNull();
  });

  it('refuses something that is not an image', async () => {
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);

    const res = await setAvatar(guest.id, {
      eventId,
      guestToken: guest.guestToken,
      image: `data:image/jpeg;base64,${Buffer.from('not a picture at all').toString('base64')}`,
    });

    expect(res.status).toBe(400);
  });

  it("cannot be pointed at another guest's photo to have that photo deleted", async () => {
    // Found by the security review of 677fb6f. Registration accepted any URL
    // this server stored for the album as the guest's avatar, and replacing an
    // avatar deletes the previous file — so a guest could name someone else's
    // photo as their avatar, then set a selfie, and the photo's file was gone.
    const eventId = await registerHost();
    const photoRes = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestName: 'Photo Owner',
        deviceFingerprint: `owner-${Math.random().toString(36).slice(2, 10)}`,
        fullUrl: jpegDataUrl,
      }),
    });
    const photo = await photoRes.json();
    const photoFile = fileFor(photo.fullUrl);
    expect(fs.existsSync(photoFile)).toBe(true);

    const attacker = await (await join(eventId, { avatarUrl: photo.fullUrl })).json();
    expect(attacker.avatarUrl).toBeNull();
    await setAvatar(attacker.id, { eventId, guestToken: attacker.guestToken, image: jpegDataUrl });

    expect(fs.existsSync(photoFile)).toBe(true);
  });

  it("leaves another file alone even when an older row already points at it", async () => {
    // A row written before this change could hold any value. Only a file the
    // avatar route itself wrote is ever removed.
    const eventId = await registerHost();
    const photoRes = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestName: 'Photo Owner',
        deviceFingerprint: `owner-${Math.random().toString(36).slice(2, 10)}`,
        fullUrl: jpegDataUrl,
      }),
    });
    const photo = await photoRes.json();
    const guest = await joinWithToken(eventId);
    await query('UPDATE guests SET avatar_url = $1 WHERE id = $2', [photo.fullUrl, guest.id]);

    const res = await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl });

    expect(res.status).toBe(200);
    expect(fs.existsSync(fileFor(photo.fullUrl))).toBe(true);
  });

  it('ignores an avatar sent with the registration, so only the avatar route sets one', async () => {
    const eventId = await registerHost();
    const stored = `${CONFIG.PUBLIC_BASE_URL}/uploads/events/${eventId}/avatar-1-abcdef.jpg`;

    const guest = await (await join(eventId, { avatarUrl: stored })).json();

    expect(guest.avatarUrl).toBeNull();
  });

  it('deletes stored selfies when the album is purged', async () => {
    const eventId = await registerHost();
    const guest = await joinWithToken(eventId);
    const { avatarUrl } = await (await setAvatar(guest.id, { eventId, guestToken: guest.guestToken, image: jpegDataUrl })).json();
    expect(fs.existsSync(fileFor(avatarUrl))).toBe(true);

    await purgeEventMedia(eventId);

    expect(fs.existsSync(fileFor(avatarUrl))).toBe(false);
  });
});
