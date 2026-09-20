import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { audioRouter } from '../../server/routes/audio';
import { wsManager } from '../../server/ws/wsServer';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

function buildMultipartAudio(bytes: Buffer, fields: Record<string, string>): { body: BodyInit; contentType: string } {
  const boundary = `----ModAudio${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
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
  return {
    body: Buffer.concat(parts) as unknown as BodyInit,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Two paid features whose enforcement lives on the server and had no regression
 * test of their own:
 *
 *   Moderation — a photo awaiting approval must not reach guests. It previously
 *   did: the REST list filtered correctly but the WebSocket broadcast went to
 *   the whole room, so a pending photo appeared in every guest's feed and only
 *   vanished on refresh.
 *
 *   Disposable camera — photos stay hidden until the morning after. The reveal
 *   is enforced server-side in two places (the broadcast redacts URLs, the list
 *   hides locked rows from non-hosts) and both need to hold.
 *
 * Both use real WebSocket clients, because the bug this guards against was
 * invisible to anything that only exercised REST.
 */

const TEST_PORT = 6593;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

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
      email: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Moderation Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

/** A WebSocket client that has joined an event room and records what it receives. */
class RoomClient {
  readonly received: { type: string; payload: Record<string, unknown> }[] = [];
  private ws!: WebSocket;
  isHost = false;

  static async join(eventId: string, hostToken?: string): Promise<RoomClient> {
    const client = new RoomClient();
    client.ws = new WebSocket(WS_URL);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket join timed out')), 5000);

      client.ws.on('open', () => {
        // Authenticated via a post-handshake message, not a ?token= query
        // parameter (SEC-A5) — see wsServer.ts's 'AUTH' case.
        if (hostToken) {
          client.ws.send(JSON.stringify({ type: 'AUTH', token: hostToken }));
        }
        client.ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
      });

      client.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ROOM_JOINED') {
          client.isHost = !!msg.isHost;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (msg.type !== 'CONNECTED') {
          client.received.push({ type: msg.type, payload: msg.payload || {} });
        }
      });

      client.ws.on('error', reject);
    });

    return client;
  }

  /** Messages of one type received so far. */
  of(type: string) {
    return this.received.filter((m) => m.type === type);
  }

  close() {
    this.ws.close();
  }
}

/**
 * Wait until the assertion holds, rather than for a fixed time.
 *
 * This replaced a `settle()` that slept 350ms before asserting a broadcast had
 * arrived. Waiting a fixed period for something to turn up is a race the
 * machine wins whenever it is busy: on a quiet run these land well inside
 * 350ms, and under load they do not — one of the causes of this suite's
 * unreproducible failures.
 *
 * Where a test asserts a broadcast did *not* arrive, it waits for one that
 * should have first; the arrival of the expected frame is what makes the
 * absence of the other meaningful rather than merely early.
 */
const arrives = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 });

async function uploadPhoto(eventId: string, caption: string) {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Spec Guest',
      deviceFingerprint: `mod-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
      caption,
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function listPhotos(eventId: string, asHostToken?: string) {
  const res = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}`, {
    headers: asHostToken ? { Authorization: `Bearer ${asHostToken}` } : {},
  });
  return res.json();
}

describe('Moderation and disposable-camera reveal', () => {
  const createdEvents: string[] = [];

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    wsManager.init(server);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/audio', audioRouter);

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 170, b: 130 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await deleteEventFixtures(createdEvents);
    if (server) server.close();
  });

  describe('photo moderation', () => {
    it('keeps a pending photo away from guests but shows it to the host, over both channels', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      // Moderation is a Celebration Pass feature and is enforced server-side.
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
      const enable = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ isModerationEnabled: true }),
      });
      expect(enable.status).toBe(200);

      const guest = await RoomClient.join(host.eventId);
      const hostClient = await RoomClient.join(host.eventId, host.token);
      expect(guest.isHost).toBe(false);
      expect(hostClient.isHost).toBe(true);

      const uploaded = await uploadPhoto(host.eventId, 'awaiting approval');
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.status).toBe('pending');

      // Wait for the frame that should arrive; its arrival is what makes the
      // guest's empty list meaningful rather than merely early.
      await arrives(() => expect(hostClient.of('PHOTO_ADDED')).toHaveLength(1));

      // This is the regression: the pending photo used to reach every guest.
      expect(guest.of('PHOTO_ADDED')).toHaveLength(0);

      // And the REST list agrees with the socket.
      const guestList = await listPhotos(host.eventId);
      expect(guestList.map((p: { caption: string }) => p.caption)).not.toContain('awaiting approval');

      const hostList = await listPhotos(host.eventId, host.token);
      expect(hostList.map((p: { caption: string }) => p.caption)).toContain('awaiting approval');

      guest.close();
      hostClient.close();
    });

    it('refuses to like or comment on a pending photo (SEC-W4)', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
      await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ isModerationEnabled: true }),
      });

      const uploaded = await uploadPhoto(host.eventId, 'not yet moderated');
      const photoId = uploaded.body.id;
      const guestId = uploaded.body.guestId;
      const guestToken = uploaded.body.guestToken;

      const likeRes = await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, guestToken }),
      });
      expect(likeRes.status).toBe(403);

      const commentRes = await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, guestToken, commentText: 'sneaking a comment in' }),
      });
      expect(commentRes.status).toBe(403);
    });

    it('releases the photo to guests once the host approves it', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
      await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ isModerationEnabled: true }),
      });

      const uploaded = await uploadPhoto(host.eventId, 'to be approved');
      const photoId = uploaded.body.id;

      const guest = await RoomClient.join(host.eventId);

      const approve = await fetch(`${BASE_URL}/api/photos/${photoId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(approve.status).toBe(200);

      // Guests are told about the approval, and the photo now lists for them.
      await arrives(() => expect(guest.of('PHOTO_STATUS_UPDATED')).toHaveLength(1));
      const guestList = await listPhotos(host.eventId);
      expect(guestList.map((p: { caption: string }) => p.caption)).toContain('to be approved');

      guest.close();
    });

    /**
     * What a status change does to the photo's *storage*, as opposed to its row.
     *
     * Approving is the one discrete action that makes a quarantined photo safe
     * to be public, so it promotes the objects out of `quarantine/` and onto
     * the served path. Mutation testing found this whole decision unasserted:
     * `moderation.ts` scored 4 of 10, the weakest module of the sweep.
     */
    async function moderatedHost(): Promise<Session> {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
      await query('UPDATE events SET is_moderation_enabled = true WHERE id = $1', [host.eventId]);
      return host;
    }

    async function setStatus(host: Session, photoId: string, status: string) {
      const res = await fetch(`${BASE_URL}/api/photos/${photoId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ status }),
      });
      return res.status;
    }

    async function storageOf(photoId: string): Promise<string> {
      const { rows } = await query<{ storage_path: string }>('SELECT storage_path FROM photos WHERE id = $1', [
        photoId,
      ]);
      return rows[0].storage_path;
    }

    it('does not publish a photo the host just rejected', async () => {
      // The serious one. Promotion is gated on the status being approved or
      // featured; with `||` instead of `&&` that gate is satisfied by the
      // UPDATE having matched a row, which it always has by this point — so
      // rejecting a photo would move it out of quarantine and onto the public
      // path. A host rejects a photo precisely because it must not be seen.
      const host = await moderatedHost();
      const { body } = await uploadPhoto(host.eventId, 'rejected, not published');
      const photoId = body.id as string;

      expect(await storageOf(photoId)).toContain('/quarantine/');
      expect(await setStatus(host, photoId, 'rejected')).toBe(200);

      expect(await storageOf(photoId)).toContain('/quarantine/');
    });

    it('publishes a photo the host approves', async () => {
      // The other direction, so the refusal above cannot be satisfied by a
      // rule that simply never promotes anything.
      const host = await moderatedHost();
      const { body } = await uploadPhoto(host.eventId, 'approved and published');
      const photoId = body.id as string;

      expect(await setStatus(host, photoId, 'approved')).toBe(200);

      expect(await storageOf(photoId)).not.toContain('/quarantine/');
    });

    it('holds an approved photo back while it is still locked before its reveal', async () => {
      // Approval alone is not enough for a disposable-locked photo: the read
      // path promotes it lazily once the reveal passes.
      const host = await moderatedHost();
      await query("UPDATE events SET is_disposable_mode = true, reveal_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [
        host.eventId,
      ]);
      const { body } = await uploadPhoto(host.eventId, 'approved but still locked');
      const photoId = body.id as string;
      await query('UPDATE photos SET is_locked = true WHERE id = $1', [photoId]);

      expect(await setStatus(host, photoId, 'approved')).toBe(200);

      expect(await storageOf(photoId)).toContain('/quarantine/');
    });

    it('publishes an approved photo that was never locked, reveal time or not', async () => {
      // `stillLocked` is `is_locked && reveal_at && reveal_at > now`. Loosen
      // any of those to `||` and a photo that was never locked counts as
      // locked merely because the album has a reveal time — so every ordinary
      // approval in a disposable-mode album silently stops publishing.
      const host = await moderatedHost();
      await query("UPDATE events SET is_disposable_mode = true, reveal_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [
        host.eventId,
      ]);
      const { body } = await uploadPhoto(host.eventId, 'unlocked in a disposable album');
      const photoId = body.id as string;
      await query('UPDATE photos SET is_locked = false WHERE id = $1', [photoId]);

      expect(await setStatus(host, photoId, 'approved')).toBe(200);

      expect(await storageOf(photoId)).not.toContain('/quarantine/');
    });

    it('broadcasts normally to guests when moderation is off', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      const guest = await RoomClient.join(host.eventId);
      await uploadPhoto(host.eventId, 'straight to the feed');
      // The host-only path must not swallow ordinary uploads.
      await arrives(() => expect(guest.of('PHOTO_ADDED')).toHaveLength(1));
      expect(guest.of('PHOTO_ADDED')[0].payload.caption).toBe('straight to the feed');

      guest.close();
    });
  });

  /**
   * The one broadcast no test asserted.
   *
   * Every other type this server emits — PHOTO_ADDED, COMMENT_ADDED,
   * QUEST_COMPLETED and the rest — is checked somewhere. `EVENT_DELETED` was
   * emitted and never observed, which makes it the easiest of the set to lose:
   * the REST response still returns `success`, the rows are still gone, and the
   * only people who would notice are the guests sitting in front of a live
   * screen that never tells them the album is over.
   *
   * It is also the most order-dependent. The broadcast goes out *after* the
   * event row is deleted, and reaches clients through the in-memory room map
   * rather than the database — so it works, but only because nothing clears the
   * room first. That is exactly the kind of invariant worth pinning.
   */
  describe('deleting an album', () => {
    it('tells the guests still watching', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      const uploaded = await uploadPhoto(host.eventId, 'about to be deleted');
      expect(uploaded.status).toBe(201);

      const guest = await RoomClient.join(host.eventId);

      // The route requires the slug typed back as confirmation.
      const { rows } = await query<{ slug: string }>('SELECT slug FROM events WHERE id = $1', [host.eventId]);

      const res = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ confirmSlug: rows[0].slug }),
      });
      expect(res.status).toBe(200);

      await arrives(() => expect(guest.of('EVENT_DELETED')).toHaveLength(1));
      expect(guest.of('EVENT_DELETED')[0].payload.eventId).toBe(host.eventId);

      guest.close();
    });
  });

  describe('disposable camera reveal', () => {
    async function enableDisposable(host: Session, revealAt: Date) {
      // Disposable mode is a Deluxe Keepsake feature.
      await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [host.userId]);
      const res = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ isDisposableMode: true, revealAt: revealAt.toISOString() }),
      });
      expect(res.status).toBe(200);
    }

    it('locks the photo and strips its URLs from the guest broadcast before the reveal', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      const guest = await RoomClient.join(host.eventId);
      const uploaded = await uploadPhoto(host.eventId, 'hidden until morning');

      expect(uploaded.status).toBe(201);
      expect(uploaded.body.isLocked).toBe(true);

      // Guests learn a photo exists, but not what it looks like.
      await arrives(() => expect(guest.of('PHOTO_ADDED')).toHaveLength(1));
      const seen = guest.of('PHOTO_ADDED');
      expect(seen[0].payload.fullUrl).toBe('');
      expect(seen[0].payload.thumbnailUrl).toBe('');

      guest.close();
    });

    it('refuses to like or comment on a photo still locked before its reveal (SEC-W4)', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      const uploaded = await uploadPhoto(host.eventId, 'sealed until morning');
      const photoId = uploaded.body.id;
      const guestId = uploaded.body.guestId;
      const guestToken = uploaded.body.guestToken;

      const likeRes = await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, guestToken }),
      });
      expect(likeRes.status).toBe(403);

      const commentRes = await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, guestToken, commentText: 'peeking before reveal' }),
      });
      expect(commentRes.status).toBe(403);
    });

    it('hides locked photos from the guest list but not from the host', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      await uploadPhoto(host.eventId, 'still sealed');

      const guestList = await listPhotos(host.eventId);
      expect(guestList.map((p: { caption: string }) => p.caption)).not.toContain('still sealed');

      // The couple can always see their own album.
      const hostList = await listPhotos(host.eventId, host.token);
      expect(hostList.map((p: { caption: string }) => p.caption)).toContain('still sealed');
    });

    it('reveals the photos to guests once the reveal time has passed', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      await uploadPhoto(host.eventId, 'the morning after');

      // Before the reveal, nothing.
      expect((await listPhotos(host.eventId)).map((p: { caption: string }) => p.caption)).not.toContain(
        'the morning after'
      );

      // Move the reveal into the past, as the morning would.
      await query("UPDATE events SET reveal_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [host.eventId]);

      const revealed = await listPhotos(host.eventId);
      expect(revealed.map((p: { caption: string }) => p.caption)).toContain('the morning after');

      // And the image is actually there once revealed.
      const photo = revealed.find((p: { caption: string }) => p.caption === 'the morning after');
      expect(photo.fullUrl).toBeTruthy();
      expect(photo.thumbnailUrl).toBeTruthy();

      // And it no longer says it is locked. The flag records the upload, not
      // the present: reporting the raw column left every photo in a
      // disposable album flagged for ever, and the card draws a "locked
      // until the reveal" placeholder from it — so the reveal never arrived
      // on screen, however long anyone waited.
      expect(photo.isLocked).toBe(false);
    });

    it('lets guests like a photo once it has been revealed', async () => {
      // The lock column also gates likes and comments. Left set after the
      // reveal, the photo was visible but could not be reacted to.
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      const uploaded = await uploadPhoto(host.eventId, 'likeable in the morning');
      await query("UPDATE events SET reveal_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [host.eventId]);
      // The feed load is what promotes and unlocks; a guest opening the album
      // is exactly what happens in the morning.
      await listPhotos(host.eventId);

      const likeRes = await fetch(`${BASE_URL}/api/photos/${uploaded.body.id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: uploaded.body.guestId, guestToken: uploaded.body.guestToken }),
      });

      expect(likeRes.status).toBe(200);
    });

    it('unlocks the photos when the host turns disposable mode off early', async () => {
      // The reveal time has not passed, but the album is no longer a
      // disposable one: the feed shows the photos, and likes and comments
      // must follow. They did not — the lock column was still set, and only
      // the reveal deadline could clear it, so the photos were visible but
      // inert until a time the host had just cancelled.
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));
      const uploaded = await uploadPhoto(host.eventId, 'unlocked early');

      const off = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ isDisposableMode: false }),
      });
      expect(off.status).toBe(200);

      const visible = await listPhotos(host.eventId);
      expect(visible.map((p: { caption: string }) => p.caption)).toContain('unlocked early');

      const likeRes = await fetch(`${BASE_URL}/api/photos/${uploaded.body.id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: uploaded.body.guestId, guestToken: uploaded.body.guestToken }),
      });
      expect(likeRes.status).toBe(200);
    });

    it('still reports a photo as locked to the host before the reveal', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      await uploadPhoto(host.eventId, 'sealed for now');

      const hostList = await listPhotos(host.eventId, host.token);
      const photo = hostList.find((p: { caption: string }) => p.caption === 'sealed for now');
      expect(photo.isLocked).toBe(true);
    });

    it('hides voice messages from guests before the reveal but not from the host (SEC-07)', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      await enableDisposable(host, new Date(Date.now() + 6 * 60 * 60 * 1000));

      const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
      const { body, contentType } = buildMultipartAudio(webmHeader, {
        eventId: host.eventId,
        guestName: 'Sealed Voice',
        durationSeconds: '5',
        note: 'shh, secret',
      });
      const uploadRes = await fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      expect(uploadRes.status).toBe(201);

      const guestList = await fetch(`${BASE_URL}/api/audio?eventId=${host.eventId}`);
      expect(await guestList.json()).toEqual([]);

      const hostList = await fetch(`${BASE_URL}/api/audio?eventId=${host.eventId}`, {
        headers: { Authorization: `Bearer ${host.token}` },
      });
      const hostEntries = await hostList.json();
      expect(hostEntries.length).toBe(1);
      expect(hostEntries[0].note).toBe('shh, secret');

      // Move the reveal into the past, as the morning would.
      await query("UPDATE events SET reveal_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [host.eventId]);
      const revealedList = await fetch(`${BASE_URL}/api/audio?eventId=${host.eventId}`);
      expect((await revealedList.json()).length).toBe(1);
    });

    it('does not lock anything when disposable mode is off', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      const uploaded = await uploadPhoto(host.eventId, 'ordinary photo');
      expect(uploaded.body.isLocked).toBe(false);

      const guestList = await listPhotos(host.eventId);
      expect(guestList.map((p: { caption: string }) => p.caption)).toContain('ordinary photo');
    });
  });

  describe('the upload pipeline the full-stack suite never exercised', () => {
    it('derives a thumbnail and keeps the original for a real image payload', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      const jpeg = await sharp({
        create: { width: 2400, height: 1600, channels: 3, background: { r: 90, g: 140, b: 90 } },
      })
        .jpeg()
        .toBuffer();
      const original = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: host.eventId,
          guestName: 'Pipeline Guest',
          deviceFingerprint: `pipeline-${Date.now()}`,
          fullUrl: jpegDataUrl,
          originalUrl: original,
          caption: 'pipeline check',
        }),
      });
      expect(res.status).toBe(201);

      const photo = await res.json();
      // Three distinct artefacts: the display copy, a derived thumbnail, the original.
      expect(photo.thumbnailUrl).not.toBe(photo.fullUrl);
      expect(photo.originalUrl).toBeTruthy();
      expect(photo.originalUrl).not.toBe(photo.fullUrl);

      // And the upload is charged against the plan's storage allowance.
      const { rows } = await query('SELECT storage_bytes FROM events WHERE id = $1', [host.eventId]);
      expect(Number(rows[0].storage_bytes)).toBeGreaterThan(jpeg.length);
    });
  });
});
