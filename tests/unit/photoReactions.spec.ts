import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

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
    await deleteEventFixtures(createdEvents);
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

  /**
   * The two guards on every engagement route, neither of which was covered.
   *
   * Found by mutation testing: `photos/engagement.ts` scored 5 of 8, the weakest
   * result of the sweep, on a file that decides who may attribute a comment or a
   * reaction to whom.
   *
   * Both guards are repeated verbatim in all three handlers — like, react and
   * comment — so a gap in one is a gap in three, and the tests below check each
   * route rather than trusting that the copies stayed identical.
   */

  let guardEvent: Session;
  let guardPhoto: { photoId: string; guestId: string; guestToken: string };

  async function engage(route: string, photoId: string, body: Record<string, unknown>) {
    const res = await fetch(`${BASE_URL}/api/photos/${photoId}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** The same call on each engagement route, with whatever extra field it needs. */
  function everyRoute(photoId: string, base: Record<string, unknown>) {
    return [
      ['like', () => engage('like', photoId, base)],
      ['reactions', () => engage('reactions', photoId, { ...base, reaction: 'heart' })],
      ['comments', () => engage('comments', photoId, { ...base, commentText: 'Lovely photo' })],
    ] as const;
  }

  /**
   * Like and reactions only.
   *
   * Comments deliberately has no `isValidUuid(guestId)` of its own: it hands the
   * value to `resolveGuestIdentity`, which checks the shape itself and simply
   * ignores anything malformed, falling through to the device fingerprint. So
   * the guard under test here does not exist on that route, and asserting it
   * would be asserting a rule the code does not have.
   */
  function idCheckedRoutes(photoId: string, base: Record<string, unknown>) {
    return everyRoute(photoId, base).filter(([route]) => route !== 'comments');
  }

  describe('engagement guards', () => {
    beforeAll(async () => {
      guardEvent = await registerHost();
      createdEvents.push(guardEvent.eventId);
      guardPhoto = await uploadPhoto(guardEvent.eventId);
    }, 30_000);

    it('answers 400, not 500, when the guestId is not a uuid', async () => {
      // `LikePhotoSchema` only requires a non-empty string of at most 100
      // characters, and `requireUuidParams` covers the photo id but not the body.
      // So `isValidUuid(guestId)` is the only thing standing between a malformed
      // id and `SELECT ... WHERE id = $1` against a uuid column, which raises
      // 22P02 and surfaces as a 500 with a stack trace.
      //
      // The mutation that survived made the guard vacuous: with `&&` it refuses
      // only when the photo id is *also* malformed, and `requireUuidParams` has
      // already guaranteed it is not.
      for (const [route, call] of idCheckedRoutes(guardPhoto.photoId, {
        guestId: 'not-a-uuid',
        guestToken: guardPhoto.guestToken,
      })) {
        const { status } = await call();
        expect(status, `${route} should refuse a malformed guestId with 400`).toBe(400);
      }
    }, 30_000);

    it('does not let a malformed guestId reach SQL on the comments route either', async () => {
      // Different mechanism, same requirement. `resolveGuestIdentity` ignores an
      // id that is not a uuid, so the caller is unidentified rather than the
      // query being handed rubbish — 401, never a 22P02 surfacing as a 500.
      const { status, body } = await engage('comments', guardPhoto.photoId, {
        guestId: 'not-a-uuid',
        commentText: 'Lovely photo',
      });

      expect(status).toBe(401);
      expect(body.code).toBe('GUEST_IDENTITY_REQUIRED');
    }, 30_000);

    it('refuses a guestId that is a uuid but belongs to no guest here', async () => {
      // The shape is fine, so the guard above passes it through; the identity
      // check behind it is what must catch this.
      for (const [route, call] of idCheckedRoutes(guardPhoto.photoId, {
        guestId: '00000000-0000-4000-8000-000000000000',
        guestToken: guardPhoto.guestToken,
      })) {
        const { status } = await call();
        expect([401, 403], `${route} should refuse an unknown guest`).toContain(status);
      }
    }, 30_000);
  });

  describe('engagement before the reveal', () => {
    /**
     * `isRevealed` is `!is_locked || !reveal_at || reveal_at <= now`, and its
     * three branches had no coverage at all on this route. Liking or commenting
     * broadcasts to every guest in the room (SEC-W4), so a photo a guest cannot
     * see yet must not be one they can react to.
     */
    async function lock(photoId: string, locked: boolean) {
      await query('UPDATE photos SET is_locked = $2 WHERE id = $1', [photoId, locked]);
    }

    async function setReveal(eventId: string, at: string | null) {
      await query('UPDATE events SET is_disposable_mode = $2, reveal_at = $3 WHERE id = $1', [
        eventId,
        at !== null,
        at,
      ]);
    }

    it('refuses a locked photo whose reveal is still ahead', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      const photo = await uploadPhoto(host.eventId);

      await lock(photo.photoId, true);
      await setReveal(host.eventId, new Date(Date.now() + 60 * 60 * 1000).toISOString());

      for (const [route, call] of everyRoute(photo.photoId, {
        guestId: photo.guestId,
        guestToken: photo.guestToken,
      })) {
        const { status } = await call();
        expect(status, `${route} should refuse a photo before its reveal`).toBe(403);
      }
    }, 30_000);

    it('allows a locked photo once its reveal has passed', async () => {
      // The `reveal_at <= now` branch. Without this the refusal above could be
      // satisfied by a rule that simply never lets anyone react to a locked
      // photo, and the disposable camera would never open.
      const host = await registerHost();
      createdEvents.push(host.eventId);
      const photo = await uploadPhoto(host.eventId);

      await lock(photo.photoId, true);
      await setReveal(host.eventId, new Date(Date.now() - 60 * 1000).toISOString());

      const { status } = await engage('like', photo.photoId, {
        guestId: photo.guestId,
        guestToken: photo.guestToken,
      });

      expect(status).toBe(200);
    }, 30_000);

    it('allows an unlocked photo even while the album has a future reveal', async () => {
      // The `!is_locked` branch, and the one a mutation silently removed: a photo
      // that was never locked is visible regardless of the album's reveal time,
      // and refusing it would break every ordinary wedding that happens to have
      // disposable mode configured.
      const host = await registerHost();
      createdEvents.push(host.eventId);
      const photo = await uploadPhoto(host.eventId);

      await lock(photo.photoId, false);
      await setReveal(host.eventId, new Date(Date.now() + 60 * 60 * 1000).toISOString());

      const { status } = await engage('like', photo.photoId, {
        guestId: photo.guestId,
        guestToken: photo.guestToken,
      });

      expect(status).toBe(200);
    }, 30_000);

    it('allows a locked photo when the album sets no reveal time at all', async () => {
      // The `!reveal_at` branch: locked with nothing to wait for is not locked
      // forever.
      const host = await registerHost();
      createdEvents.push(host.eventId);
      const photo = await uploadPhoto(host.eventId);

      await lock(photo.photoId, true);
      await setReveal(host.eventId, null);

      const { status } = await engage('like', photo.photoId, {
        guestId: photo.guestId,
        guestToken: photo.guestToken,
      });

      expect(status).toBe(200);
    }, 30_000);
  });
});
