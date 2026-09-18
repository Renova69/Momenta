import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { guestsRouter } from '../../server/routes/guests';
import { wsManager } from '../../server/ws/wsServer';
import { deleteEventFixture } from '../helpers/cleanup';

/**
 * Regressions for the rest of the 2026-09-04 Phase 2 security pass:
 *
 *   SEC-A2 (reserved fingerprints) — `ingestPipeline.ts` creates the official
 *   photographer's guest row with `device_fingerprint = 'photographer'`. Any
 *   endpoint that upserts a guest by fingerprint would let an unauthenticated
 *   caller overwrite that row's name/table by claiming the same fingerprint.
 *
 *   SEC-A2 (broadcast leakage) — a guestToken proves identity to the guest
 *   who holds it. If one ever appeared in a WebSocket broadcast, every other
 *   guest in the room would receive it and could impersonate the sender.
 *
 *   SEC-A5 (WebSocket auth) — a host session token used to travel in the
 *   WebSocket connection URL (?token=), which ends up in access logs, proxy
 *   logs and browser history. It now goes over an AUTH message sent after
 *   the handshake instead, and the query parameter is no longer read at all.
 */

const TEST_PORT = 6602;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
let JPEG_DATA_URL = '';

async function registerHost(): Promise<{ token: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `wsauth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'WS Auth Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, eventId: data.event.id };
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => reject(new Error('connect timed out')), 5000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function joinAndAwait(ws: WebSocket, eventId: string, authToken?: string): Promise<{ isHost: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('join timed out')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ROOM_JOINED') {
        clearTimeout(timeout);
        resolve({ isHost: !!msg.isHost });
      }
    });
    if (authToken) {
      ws.send(JSON.stringify({ type: 'AUTH', token: authToken }));
    }
    ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
  });
}

describe('Guest identity & WebSocket auth (SEC-A2, SEC-A5)', () => {
  let hostToken = '';
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/guests', guestsRouter);
    wsManager.init(server);

    JPEG_DATA_URL = `data:image/jpeg;base64,${(
      await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 100, g: 100, b: 200 } } })
        .jpeg()
        .toBuffer()
    ).toString('base64')}`;

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const host = await registerHost();
    hostToken = host.token;
    eventId = host.eventId;
  });

  afterAll(async () => {
    await deleteEventFixture(eventId);
    if (server) server.close();
  });

  describe('reserved device fingerprints', () => {
    it('rejects POST /api/guests claiming the photographer fingerprint', async () => {
      const res = await fetch(`${BASE_URL}/api/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, name: 'Impersonator', deviceFingerprint: 'photographer' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects POST /api/guests claiming the system fingerprint', async () => {
      const res = await fetch(`${BASE_URL}/api/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, name: 'Impersonator', deviceFingerprint: 'system' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects POST /api/photos claiming the photographer fingerprint', async () => {
      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          guestName: 'Impersonator',
          fullUrl: JPEG_DATA_URL,
          deviceFingerprint: 'photographer',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('still allows an ordinary, non-reserved fingerprint', async () => {
      const res = await fetch(`${BASE_URL}/api/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, name: 'Real Guest', deviceFingerprint: `device-${Date.now()}` }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).guestToken).toBeTruthy();
    });
  });

  describe('guestToken never leaks into a broadcast', () => {
    it('PHOTO_ADDED broadcast carries no guestToken', async () => {
      const listener = await connect();
      await joinAndAwait(listener, eventId);

      const received: Record<string, unknown>[] = [];
      listener.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'PHOTO_ADDED') received.push(msg.payload);
      });

      const uploaderRes = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          guestName: 'Broadcast Spec Guest',
          fullUrl: JPEG_DATA_URL,
          deviceFingerprint: `device-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      expect(uploaderRes.status).toBe(201);
      const uploaded = await uploaderRes.json();
      expect(uploaded.guestToken).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).not.toHaveProperty('guestToken');

      listener.close();
    });
  });

  describe('WebSocket authentication', () => {
    it('a ?token= query parameter no longer grants host privileges', async () => {
      const ws = new WebSocket(`${WS_URL}?token=${hostToken}`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('open timed out')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', reject);
      });

      const { isHost } = await joinAndAwait(ws, eventId);
      expect(isHost).toBe(false);
      ws.close();
    });

    it('an AUTH message grants host privileges for the room join that follows it', async () => {
      const ws = await connect();
      const { isHost } = await joinAndAwait(ws, eventId, hostToken);
      expect(isHost).toBe(true);
      ws.close();
    });

    it('a host token for one album grants nothing in another album’s room', async () => {
      // The check is `rows.length > 0 && rows[0].host_user_id === userId`.
      // Dropping the second half — which mutation testing did, with all 40
      // spec files still green — hands host privileges to anyone holding any
      // valid session token, for any album that exists. Host privileges are
      // what gate the moderation queue and the pending-photo channel.
      const intruder = await registerHost();
      const victim = await registerHost();

      const ws = await connect();
      try {
        const { isHost } = await joinAndAwait(ws, victim.eventId, intruder.token);

        expect(isHost).toBe(false);
      } finally {
        ws.close();
      }
    }, 20_000);

    it('stops delivering an album’s photos once the client joins another', async () => {
      // Switching rooms removes the client from the old one, guarded by
      // `oldMeta.eventId !== eventId`. Flip that comparison and the client
      // stays subscribed to the album it left — so a guest who opens a second
      // wedding link keeps receiving the first couple's photographs.
      const first = await registerHost();
      const second = await registerHost();

      const ws = await connect();
      try {
        await joinAndAwait(ws, first.eventId);
        await joinAndAwait(ws, second.eventId);

        const leaked: string[] = [];
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'PHOTO_ADDED') leaked.push(String(msg.payload?.id ?? ''));
        });

        wsManager.broadcastToEvent(first.eventId, 'PHOTO_ADDED', { id: 'from-the-album-we-left' });
        wsManager.broadcastToEvent(second.eventId, 'PHOTO_ADDED', { id: 'from-the-album-we-joined' });

        // Waiting for the frame that *should* arrive is what makes the absence
        // of the other one meaningful: asserting on an empty list immediately
        // would pass before either had a chance to be delivered.
        await vi.waitFor(() => {
          expect(leaked).toContain('from-the-album-we-joined');
        }, 5000);

        expect(leaked).not.toContain('from-the-album-we-left');
      } finally {
        ws.close();
      }
    }, 20_000);

    it('an invalid AUTH token leaves the connection as a guest, not an error', async () => {
      const ws = await connect();
      const { isHost } = await joinAndAwait(ws, eventId, 'not-a-real-jwt');
      expect(isHost).toBe(false);
      ws.close();
    });
  });

  describe('GET /api/guests rate limiting (SEC-06)', () => {
    it('applies a rate limiter to the fingerprint lookup, not just the global limiter', async () => {
      // Exhausting the limiter here would poison its shared, module-wide
      // state for every other test that hits an uploadLimiter-protected
      // route in this run - the standardHeaders response is the signal that
      // the middleware is actually mounted, without spending its budget.
      const res = await fetch(`${BASE_URL}/api/guests?eventId=${eventId}&deviceFingerprint=sec06-probe`);
      expect(res.headers.get('ratelimit-limit')).toBeTruthy();
    });
  });
});
