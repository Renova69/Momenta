import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { guestsRouter } from '../../server/routes/guests';
import { wsManager } from '../../server/ws/wsServer';
import { query } from '../../server/lib/db';

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

function joinAndAwait(
  ws: WebSocket,
  eventId: string,
  authToken?: string
): Promise<{ isHost: boolean }> {
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
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
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
