import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  return { body: Buffer.concat(parts) as unknown as BodyInit, contentType: `multipart/form-data; boundary=${boundary}` };
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

/** Give broadcasts a moment to arrive before asserting they did not. */
const settle = () => new Promise((r) => setTimeout(r, 350));

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
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(
      () => undefined
    );
    if (server) server.close();
  });

  describe('photo moderation', () => {
    it('keeps a pending photo away from guests but shows it to the host, over both channels', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      // Moderation is a Celebration Pass feature and is enforced server-side.
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [
        host.userId,
      ]);
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

      await settle();

      // This is the regression: the pending photo used to reach every guest.
      expect(guest.of('PHOTO_ADDED')).toHaveLength(0);
      expect(hostClient.of('PHOTO_ADDED')).toHaveLength(1);

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
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [
        host.userId,
      ]);
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

      await settle();

      // Guests are told about the approval, and the photo now lists for them.
      expect(guest.of('PHOTO_STATUS_UPDATED')).toHaveLength(1);
      const guestList = await listPhotos(host.eventId);
      expect(guestList.map((p: { caption: string }) => p.caption)).toContain('to be approved');

      guest.close();
    });

    it('broadcasts normally to guests when moderation is off', async () => {
      const host = await registerHost();
      createdEvents.push(host.eventId);

      const guest = await RoomClient.join(host.eventId);
      await uploadPhoto(host.eventId, 'straight to the feed');
      await settle();

      // The host-only path must not swallow ordinary uploads.
      expect(guest.of('PHOTO_ADDED')).toHaveLength(1);
      expect(guest.of('PHOTO_ADDED')[0].payload.caption).toBe('straight to the feed');

      guest.close();
    });
  });

  describe('disposable camera reveal', () => {
    async function enableDisposable(host: Session, revealAt: Date) {
      // Disposable mode is a Deluxe Keepsake feature.
      await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
        host.userId,
      ]);
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

      await settle();

      // Guests learn a photo exists, but not what it looks like.
      const seen = guest.of('PHOTO_ADDED');
      expect(seen).toHaveLength(1);
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
      expect(
        (await listPhotos(host.eventId)).map((p: { caption: string }) => p.caption)
      ).not.toContain('the morning after');

      // Move the reveal into the past, as the morning would.
      await query('UPDATE events SET reveal_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [
        host.eventId,
      ]);

      const revealed = await listPhotos(host.eventId);
      expect(revealed.map((p: { caption: string }) => p.caption)).toContain('the morning after');

      // And the image is actually there once revealed.
      const photo = revealed.find((p: { caption: string }) => p.caption === 'the morning after');
      expect(photo.fullUrl).toBeTruthy();
      expect(photo.thumbnailUrl).toBeTruthy();
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
      const { rows } = await query(
        'SELECT storage_bytes FROM events WHERE id = $1',
        [host.eventId]
      );
      expect(Number(rows[0].storage_bytes)).toBeGreaterThan(jpeg.length);
    });
  });
});
