import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';

/**
 * POST /api/photos/:id/comments had no dedicated test of its own — only e2e
 * coverage of the happy path.
 *
 * This endpoint is deliberately softer than /like and /reactions: a guest who
 * never finished onboarding can still leave a wish, so an unverified identity
 * degrades to a fresh guest rather than a 401. H8 narrowed that to the case
 * where it was actually meant to apply — the caller has to identify its
 * *device*, which bounds row creation to one per device per event. Minting a
 * new identity on every unproven request, with no rate limit beyond the global
 * API ceiling, was an unbounded write primitive for anyone holding a public
 * event slug.
 *
 * The anti-impersonation rule is unchanged throughout: an unverified token
 * never speaks as the guest it names.
 */

const TEST_PORT = 6624;
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
      email: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Comments Spec Host',
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
      guestName: 'Comment Spec Guest',
      deviceFingerprint: `comment-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  const body = await res.json();
  return { photoId: body.id, guestId: body.guestId, guestToken: body.guestToken };
}

async function postComment(photoId: string, payload: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function getPhoto(eventId: string, photoId: string) {
  const res = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}`);
  const photos = await res.json();
  return photos.find((p: { id: string }) => p.id === photoId);
}

const createdEvents: string[] = [];

describe('Photo comments', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 160, g: 190, b: 210 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  it('adds a comment with a verified guest identity and it appears in the feed', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    const result = await postComment(photoId, {
      guestId,
      guestName: 'Comment Spec Guest',
      commentText: 'What a beautiful moment!',
      guestToken,
    });
    expect(result.status).toBe(201);
    expect(result.body.guestId).toBe(guestId);
    expect(result.body.commentText).toBe('What a beautiful moment!');

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.comments).toHaveLength(1);
    expect(photo.comments[0]).toMatchObject({ guestId, commentText: 'What a beautiful moment!' });
  });

  it('never posts as the claimed guest when the token cannot be verified', async () => {
    // The property under test is the anti-impersonation one, and it holds in
    // both shapes below: an unverified token never speaks as the guest it
    // names. What changed with H8 is only what happens instead — a caller
    // that also identifies its device degrades gracefully, while one that
    // identifies nothing at all is asked to join rather than being handed a
    // brand-new identity for the asking.
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId } = await uploadPhoto(host.eventId);

    const withDevice = await postComment(photoId, {
      guestId,
      guestName: 'Someone Else',
      commentText: 'Congratulations!',
      guestToken: 'not-a-real-token',
      deviceFingerprint: 'comment-degrade-device',
    });
    expect(withDevice.status).toBe(201);
    expect(withDevice.body.guestId).not.toBe(guestId);

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.comments).toHaveLength(1);
    expect(photo.comments[0].commentText).toBe('Congratulations!');
  });

  it('refuses a comment that identifies neither a token nor a device (H8)', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId } = await uploadPhoto(host.eventId);

    const result = await postComment(photoId, {
      guestId,
      guestName: 'Someone Else',
      commentText: 'Congratulations!',
      guestToken: 'not-a-real-token',
    });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('GUEST_IDENTITY_REQUIRED');

    const photo = await getPhoto(host.eventId, photoId);
    expect(photo.comments).toHaveLength(0);
  });

  it('rejects an empty comment', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    const result = await postComment(photoId, { guestId, commentText: '   ', guestToken });
    expect(result.status).toBe(400);
  });

  it('rejects commenting on a photo pending moderation (SEC-W4 parity with like/react)', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    const { photoId, guestId, guestToken } = await uploadPhoto(host.eventId);

    const result = await postComment(photoId, { guestId, commentText: 'sneaking in early', guestToken });
    expect(result.status).toBe(403);
  });

  it('returns 404 for a photo that does not exist', async () => {
    const result = await postComment('00000000-0000-0000-0000-000000000000', {
      guestId: '00000000-0000-0000-0000-000000000001',
      commentText: 'hello?',
    });
    expect(result.status).toBe(404);
  });
});
