import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { wsManager, WsEventManager } from '../../server/ws/wsServer';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';

/**
 * Regressions for the realtime slice of OPEN_ITEMS.md Phase 5:
 *
 *   SEC-D6 — a flood of JOIN_EVENT_ROOM frames on one connection each
 *   turned into a `pool.query`; nothing throttled the rate.
 *   P6 — a reaction flood broadcast one WebSocket message per tap,
 *   straight to every client in the room.
 *
 * And Phase 6:
 *
 *   SEC-A4 — with no CORS_ORIGIN configured, the origin check fell back to
 *   allowing every upgrade, letting any third-party page open a WS
 *   connection to this server (CSWSH).
 */

const TEST_PORT = 6606;
/**
 * Deliberately its own constant rather than `TEST_PORT + 1`.
 *
 * That arithmetic resolved to 6607, which authHardening.spec.ts also binds.
 * Spec files run in parallel workers, so both processes raced for the port and
 * whichever lost threw EADDRINUSE inside beforeAll — reported as a suite-level
 * failure with the tests skipped, passing in isolation, and only showing up
 * when the scheduler happened to overlap those two files. A derived port is
 * invisible to anyone scanning for duplicates, which is how it survived.
 *
 * tests/unit/testPortAllocation.spec.ts now fails fast on any repeat.
 */
const BATCH_PORT = 6630;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `wsflood-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'WS Flood Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { eventId: data.event.id };
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

describe('WebSocket message throttling (SEC-D6)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    wsManager.init(server);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const host = await registerHost();
    eventId = host.eventId;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  it('stops responding to JOIN_EVENT_ROOM once a connection floods past the per-window budget', async () => {
    const ws = await connect();
    const roomJoinedCount = { n: 0 };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ROOM_JOINED') roomJoinedCount.n += 1;
    });

    const FLOOD_SIZE = 40; // well past the 20/10s budget
    for (let i = 0; i < FLOOD_SIZE; i++) {
      ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Before the fix, every one of these was a DB query and a ROOM_JOINED
    // reply. Throttled, only the budget's worth actually gets processed.
    expect(roomJoinedCount.n).toBeLessThan(FLOOD_SIZE);
    expect(roomJoinedCount.n).toBeGreaterThan(0);

    ws.close();
  });

  it('a normal, unhurried client is never throttled', async () => {
    const ws = await connect();
    let joined = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ROOM_JOINED') joined = true;
    });

    ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(joined).toBe(true);
    ws.close();
  });
});

describe('Reaction batching (P6)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    wsManager.init(server);
    await new Promise<void>((resolve) => server.listen(BATCH_PORT, () => resolve()));

    const res = await fetch(`http://localhost:${BATCH_PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `wsflood2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
        fullName: 'Reaction Batch Spec Host',
        password: 'Password123!',
      }),
    });
    eventId = (await res.json()).event.id;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  it('coalesces a burst of reactions into few REACTIONS_BATCH messages, not one per reaction', async () => {
    const listenerPort = BATCH_PORT;
    const ws = new WebSocket(`ws://localhost:${listenerPort}`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('connect timed out')), 5000);
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on('error', reject);
    });

    let batchMessages = 0;
    let totalReactions = 0;
    let sawIndividualReactionSent = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'REACTIONS_BATCH') {
        batchMessages += 1;
        totalReactions += (msg.payload?.reactions || []).length;
      }
      if (msg.type === 'REACTION_SENT') sawIndividualReactionSent = true;
    });

    // Wait for the server to confirm the room join instead of sleeping and
    // hoping. The old fixed 150ms was a second race: a reaction broadcast
    // before this socket is actually in the room is simply never delivered,
    // so the burst would arrive short. Frame handling is also promise-chained
    // per connection now (H9), which made that window tighter still.
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ROOM_JOINED timed out')), 5000);
      ws.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type === 'ROOM_JOINED') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
    await joined;

    const BURST_SIZE = 15;
    await Promise.all(
      Array.from({ length: BURST_SIZE }, () =>
        fetch(`http://localhost:${listenerPort}/api/events/${eventId}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reaction: 'heart', guestName: 'Guest' }),
        })
      )
    );

    // The flush window is 200ms; poll up to 3s so a loaded machine cannot turn
    // a timing margin into a failure. Waiting longer never weakens the
    // assertions below — batchMessages counts messages, not elapsed time.
    const deadline = Date.now() + 3000;
    while (totalReactions < BURST_SIZE && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A final settle, so a stray extra batch would still be counted.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(sawIndividualReactionSent).toBe(false);
    expect(totalReactions).toBe(BURST_SIZE);
    // The whole point: far fewer messages than reactions.
    expect(batchMessages).toBeLessThan(BURST_SIZE);
    expect(batchMessages).toBeGreaterThan(0);

    ws.close();
  });
});

describe('WS origin allow-list fail-closed default (SEC-A4)', () => {
  const PORT = 6608;
  let originServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    originServer = createServer(express());
    new WsEventManager().init(originServer);
    await new Promise<void>((resolve) => originServer.listen(PORT, () => resolve()));
  });

  afterAll(() => {
    if (originServer) originServer.close();
  });

  function attemptConnect(origin: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: { Origin: origin } });
      const timeout = setTimeout(() => reject(new Error('connect timed out')), 5000);
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timeout);
        reject(new Error(`upgrade rejected: ${res.statusCode}`));
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  it('rejects a cross-origin upgrade when CORS_ORIGIN is unset', async () => {
    const original = CONFIG.CORS_ORIGIN;
    CONFIG.CORS_ORIGIN = false;
    try {
      await expect(attemptConnect('https://evil.example.com')).rejects.toThrow();
    } finally {
      CONFIG.CORS_ORIGIN = original;
    }
  });

  it('still allows a same-origin upgrade when CORS_ORIGIN is unset', async () => {
    const original = CONFIG.CORS_ORIGIN;
    CONFIG.CORS_ORIGIN = false;
    try {
      const ws = await attemptConnect(`http://localhost:${PORT}`);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      CONFIG.CORS_ORIGIN = original;
    }
  });
});

describe('WS AUTH rejects non-session tokens (SEC-01)', () => {
  const PORT = 6611;
  let authServer: ReturnType<typeof createServer>;
  let eventId = '';
  let userId = '';

  beforeAll(async () => {
    const app = express();
    authServer = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    new WsEventManager().init(authServer);
    await new Promise<void>((resolve) => authServer.listen(PORT, () => resolve()));

    const res = await fetch(`http://localhost:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `sec01ws-${Date.now()}@test.com`,
        fullName: 'SEC-01 WS Spec Host',
        password: 'Password123!',
      }),
    });
    const data = await res.json();
    eventId = data.event.id;
    userId = data.user.id;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (authServer) authServer.close();
  });

  function connectTo(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const timeout = setTimeout(() => reject(new Error('connect timed out')), 5000);
      ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
      ws.on('error', reject);
    });
  }

  it('a download token does not grant isHost via the WS AUTH message', async () => {
    const { issueDownloadToken } = await import('../../server/lib/downloadToken');
    const { token: downloadToken } = issueDownloadToken(eventId, userId);

    const ws = await connectTo(PORT);
    const roomJoined = new Promise<{ isHost: boolean }>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ROOM_JOINED') resolve(msg);
      });
    });

    ws.send(JSON.stringify({ type: 'AUTH', token: downloadToken }));
    ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));

    const joined = await roomJoined;
    expect(joined.isHost).toBe(false);
    ws.close();
  });
});

describe('WS shutdown clears pending reaction-flush timers (DB-15)', () => {
  const PORT = 6617;
  let shutdownServer: ReturnType<typeof createServer>;
  let manager: WsEventManager;

  beforeAll(async () => {
    shutdownServer = createServer(express());
    manager = new WsEventManager();
    manager.init(shutdownServer);
    await new Promise<void>((resolve) => shutdownServer.listen(PORT, () => resolve()));
  });

  afterAll(() => {
    if (shutdownServer) shutdownServer.close();
  });

  it('clears the pending reaction-flush timer instead of leaving it running past shutdown', async () => {
    const eventId = '00000000-0000-0000-0000-0000000000d1';

    // Queues a reaction with a 200ms flush timer. Checking message delivery
    // alone isn't a reliable signal here — shutdown() also terminates
    // connected clients, which independently suppresses any broadcast
    // regardless of whether the timer itself was actually cleared. The
    // timer map is the real thing being fixed, so assert on it directly.
    manager.queueReaction(eventId, { reactions: [{ reaction: 'heart', guestName: 'Spec Guest' }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timers = (manager as any).reactionFlushTimers as Map<string, unknown>;
    expect(timers.size).toBe(1);

    manager.shutdown();
    // wss's 'close' event (where the cleanup runs) fires asynchronously,
    // not within the same tick as close()/terminate().
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(timers.size).toBe(0);
  });
});

describe('hostCheckCache evicts expired entries (DB-07)', () => {
  it('drops an expired entry on sweep but keeps a fresh one', async () => {
    const manager = new WsEventManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyManager = manager as any;

    // A user+event pair that will never be looked up again after this -
    // exactly the case that leaked before DB-07 (nothing else ever
    // overwrites or removes it).
    await anyManager.isEventHost('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2');
    await anyManager.isEventHost('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000e4');

    const cache = anyManager.hostCheckCache as Map<string, { isHost: boolean; expiresAt: number }>;
    expect(cache.size).toBe(2);

    // Force one entry into the past without waiting out the real 60s TTL.
    const staleKey = '00000000-0000-0000-0000-0000000000e1:00000000-0000-0000-0000-0000000000e2';
    cache.set(staleKey, { ...cache.get(staleKey)!, expiresAt: Date.now() - 1 });

    anyManager.sweepHostCheckCache();

    expect(cache.has(staleKey)).toBe(false);
    expect(cache.size).toBe(1);
  });
});

describe('broadcast terminates a slow consumer past the buffered-bytes cap (DB-04)', () => {
  // A real WebSocket's bufferedAmount is derived from the live OS socket
  // send buffer and can't be set directly - a real backpressure scenario
  // isn't reliably reproducible on localhost (both ends drain near-
  // instantly). A fake client with a controllable bufferedAmount tests the
  // actual cap-checking logic in `send()` directly.
  function fakeClient(bufferedAmount: number) {
    return {
      readyState: 1, // WebSocket.OPEN
      bufferedAmount,
      sentMessages: [] as string[],
      send(msg: string) {
        this.sentMessages.push(msg);
      },
      terminate() {
        this.terminated = true;
      },
      terminated: false,
    };
  }

  it('terminates and skips a client whose backlog exceeds the cap, still sends to a healthy one', () => {
    const manager = new WsEventManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyManager = manager as any;
    anyManager.wss = {}; // send() only checks truthiness of this.wss

    const eventId = '00000000-0000-0000-0000-0000000000f1';
    const slow = fakeClient(600 * 1024); // over the 512KB cap
    const healthy = fakeClient(0);
    anyManager.eventRooms.set(eventId, new Set([slow, healthy]));
    anyManager.clientMeta.set(slow, { isAlive: true });
    anyManager.clientMeta.set(healthy, { isAlive: true });

    manager.broadcastToEvent(eventId, 'TEST_EVENT', { hello: 'world' });

    expect(slow.terminated).toBe(true);
    expect(slow.sentMessages.length).toBe(0);
    expect(healthy.terminated).toBe(false);
    expect(healthy.sentMessages.length).toBe(1);
  });
});
