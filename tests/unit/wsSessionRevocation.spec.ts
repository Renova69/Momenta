import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import { authRouter } from '../../server/routes/auth';
import { wsManager } from '../../server/ws/wsServer';
import { query } from '../../server/lib/db';

/**
 * H9 — a signed-out host session must not keep WebSocket host privileges.
 *
 * requireAuth and optionalAuth both check the token against
 * users.token_version (migration 019), so logging out kills every token
 * minted before it. The WebSocket AUTH handler verified the signature and the
 * payload shape only, and never consulted that column — so a host who signed
 * out on a shared laptop kept full `isHost` room privileges on any socket that
 * stayed open.
 *
 * That is not cosmetic: broadcastToEventHosts is the channel carrying photos
 * still awaiting moderation, with signed preview tokens embedded in them.
 * Migration 019 exists precisely for the shared-machine case this left open.
 */

const TEST_PORT = 6632;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ token: string; eventId: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `wsrevoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'WS Revocation Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, eventId: data.event.id, userId: data.user.id };
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
    if (authToken) ws.send(JSON.stringify({ type: 'AUTH', token: authToken }));
    ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
  });
}

/** Resolves with the first message of `type`, or null once `ms` elapses. */
function awaitMessage(ws: WebSocket, type: string, ms = 600): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        resolve(msg.payload);
      }
    });
  });
}

describe('WebSocket honours session revocation (H9)', () => {
  const sockets: WebSocket[] = [];
  let hostToken = '';
  let eventId = '';
  let userId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    wsManager.init(server);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const host = await registerHost();
    hostToken = host.token;
    eventId = host.eventId;
    userId = host.userId;
  });

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    if (server) server.close();
  });

  async function open(): Promise<WebSocket> {
    const ws = await connect();
    sockets.push(ws);
    return ws;
  }

  it('grants host privileges to a live session token', async () => {
    const ws = await open();
    const { isHost } = await joinAndAwait(ws, eventId, hostToken);
    expect(isHost).toBe(true);
  });

  it('refuses host privileges to a token revoked by logout', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(res.status).toBe(204);

    const ws = await open();
    const { isHost } = await joinAndAwait(ws, eventId, hostToken);
    expect(isHost).toBe(false);
  });

  it('does not deliver a hosts-only broadcast to the revoked session', async () => {
    // The token was revoked by the previous test; this connection must land in
    // the room as an ordinary guest, which is what keeps pending photos (and
    // the preview tokens inside them) away from it.
    const ws = await open();
    await joinAndAwait(ws, eventId, hostToken);

    const received = awaitMessage(ws, 'PHOTO_ADDED');
    wsManager.broadcastToEventHosts(eventId, 'PHOTO_ADDED', { id: 'pending-photo', status: 'pending' });

    expect(await received).toBeNull();
  });

  it('grants host privileges again after signing back in', async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email,
        password: 'Password123!',
      }),
    });
    const fresh = (await login.json()).token as string;

    const ws = await open();
    const { isHost } = await joinAndAwait(ws, eventId, fresh);
    expect(isHost).toBe(true);
  });
});
