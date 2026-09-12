import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';

/**
 * Per-photo emoji reactions — a guest can toggle several different emoji
 * kinds independently on the same photo (unlike the single boolean `like`),
 * mirroring the vocabulary the ambient live-reaction bar already uses
 * (heart/clap/cheers/laugh/party). This checks the toggle route end to end:
 * a reaction actually appears in the feed response, toggling the same kind
 * again removes it, and two different kinds coexist on one photo for one
 * guest.
 */

const TEST_PORT = 6622;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';

interface Session {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `react-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Reactions Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function uploadPhoto(eventId: string): Promise<{ photoId: string; guestId: string; guestToken: string }> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Reaction Spec Guest',
      deviceFingerprint: `react-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  const body = await res.json();
  return { photoId: body.id, guestId: body.guestId, guestToken: body.guestToken };
}

async function react(photoId: string, reaction: string, guestId: string, guestToken: string) {
  const res = await fetch(`${BASE_URL}/api/photos/${photoId}/reactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction, guestId, guestToken }),
  });
  return { status: res.status, body: await res.json() };
}

async function getPhoto(eventId: string, photoId: string) {
  const res = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}`);
  const photos = await res.json();
  return photos.find((p: { id: string }) => p.id === photoId);
}

const createdEvents: string[] = [];

describe('Per-photo emoji reactions', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 180, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  it('adds a reaction and it appears in the feed response', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    const result = await react(photoId, 'heart', guestId, guestToken);
    expect(result.status).toBe(200);
    expect(result.body.isActive).toBe(true);

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.reactions).toEqual(expect.arrayContaining([{ reaction: 'heart', guestId }]));
  });

  it('toggles the same reaction off on a second call', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    await react(photoId, 'clap', guestId, guestToken);
    const second = await react(photoId, 'clap', guestId, guestToken);
    expect(second.body.isActive).toBe(false);

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.reactions).toEqual([]);
  });

  it('lets one guest hold several different reaction kinds on the same photo at once', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    await react(photoId, 'heart', guestId, guestToken);
    await react(photoId, 'party', guestId, guestToken);

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.reactions).toHaveLength(2);
    expect(photo.reactions).toEqual(
      expect.arrayContaining([
        { reaction: 'heart', guestId },
        { reaction: 'party', guestId },
      ])
    );
  });

  it('rejects a reaction from a guest identity that cannot be proven', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId } = await uploadPhoto(host.eventId);

    const result = await react(photoId, 'heart', guestId, 'not-a-real-token');
    expect(result.status).toBe(401);

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.reactions).toEqual([]);
  });

  it('rejects an unknown reaction kind', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    const result = await react(photoId, 'not-a-real-emoji', guestId, guestToken);
    expect(result.status).toBe(400);
  });
});
