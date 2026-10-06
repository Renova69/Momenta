import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { drainHttpServer } from '../../server/lib/httpDrain';

/**
 * N-66 — a WebSocket is an upgraded HTTP connection, and `server.close()`
 * waits for every connection the listener accepted, upgraded ones included.
 * The shutdown sequence closed the realtime sockets only *after* awaiting
 * `server.close()`, so with a single guest watching a feed the wait never
 * ended: every deploy ran out its 8-second budget and exited hard, skipping
 * the FTP stop and `pool.end()` the sequence exists to reach.
 */

let server: Server | undefined;
let wss: WebSocketServer | undefined;
const clients: WebSocket[] = [];

afterEach(async () => {
  clients.splice(0).forEach((c) => c.terminate());
  wss?.clients.forEach((c) => c.terminate());
  wss?.close();
  wss = undefined;
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

async function startServerWithRealtime(slowMs = 300): Promise<string> {
  const app = express();
  app.get('/slow', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, slowMs));
    res.json({ finished: true });
  });
  server = createServer(app);
  wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server!.listen(0, () => resolve()));
  return `localhost:${(server.address() as AddressInfo).port}`;
}

async function openSocket(host: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://${host}`);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

function closeRealtime(): void {
  wss?.clients.forEach((c) => c.terminate());
  wss?.close();
}

/** Resolves to 'timeout' if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

describe('draining while guests hold realtime sockets (N-66)', () => {
  it('a plain close() does not finish while a socket is open', async () => {
    // The failure, pinned: this is what the old sequence awaited.
    const host = await startServerWithRealtime();
    await openSocket(host);

    const closed = new Promise<void>((resolve) => server!.close(() => resolve()));

    expect(await within(closed, 1000)).toBe('timeout');
  }, 10_000);

  it('finishes promptly once the realtime sockets are closed as part of it', async () => {
    const host = await startServerWithRealtime();
    await openSocket(host);
    await openSocket(host);

    const outcome = await within(drainHttpServer(server!, closeRealtime), 1000);

    expect(outcome).not.toBe('timeout');
  }, 10_000);

  it('still lets an HTTP request already in flight finish', async () => {
    const host = await startServerWithRealtime(300);
    await openSocket(host);
    const inFlight = fetch(`http://${host}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const drained = drainHttpServer(server!, closeRealtime);
    const response = await inFlight;

    expect(await response.json()).toEqual({ finished: true });
    expect(await within(drained, 1000)).not.toBe('timeout');
  }, 10_000);
});

describe('the shutdown sequence in server/index.ts', () => {
  // index.ts boots the application at import, so it is read, not imported
  // (see gracefulShutdown.spec.ts).
  const src = fs.readFileSync(path.resolve(__dirname, '../../server/index.ts'), 'utf8');

  it('closes the realtime sockets as part of the HTTP drain, not after it', () => {
    expect(src).toMatch(/await drainHttpServer\(server, \(\) => wsManager\.shutdown\(\)\)/);
  });
});
