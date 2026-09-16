import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { pool } from '../../server/lib/db';
import { healthHandler } from '../../server/lib/health';

const TEST_PORT = 6652;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

/**
 * The health check has to be able to say no.
 *
 * It used to answer `status: 'ok'` unconditionally — the payload was a socket
 * count and two constants, and nothing was consulted. The container's
 * HEALTHCHECK curls this endpoint, so with Postgres down every real request
 * returned 500 while this one kept reporting the instance fine: an
 * orchestrator would have gone on routing traffic to a process that could not
 * answer any of it, and nobody would have been paged.
 *
 * The handler under test is the real one. It lives in `server/lib/health.ts`
 * rather than inline in `server/index.ts` precisely so these tests can mount
 * it: importing `server/index.ts` calls `start()` at module load and would
 * boot the whole application — real port, FTP listener, migrations — inside a
 * test worker. Mounting a copy of the route body here would have tested the
 * copy.
 */

function mountHealth(app: express.Express, timeoutMs?: number): void {
  app.get('/api/health', healthHandler(timeoutMs));
}

beforeAll(async () => {
  const app = express();
  mountHealth(app);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
}, 30_000);

afterAll(() => {
  if (server) server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('when the database is reachable', () => {
  it('reports the instance healthy', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
  }, 20_000);

  it('still reports the operational detail it always did', async () => {
    // The payload is read by whoever is debugging at 2am; the probe was added
    // to it, not substituted for it.
    const body = await (await fetch(`${BASE_URL}/api/health`)).json();

    expect(body).toHaveProperty('connectedSockets');
    expect(body).toHaveProperty('storageProvider');
    expect(body).toHaveProperty('timestamp');
  }, 20_000);
});

describe('when the database is unreachable', () => {
  it('answers 503 rather than claiming to be fine', async () => {
    // The whole finding. A 200 here is how a dead instance keeps receiving
    // traffic.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await fetch(`${BASE_URL}/api/health`);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('unreachable');
  }, 20_000);

  it('names the dependency without leaking the connection string', async () => {
    // [FIX M-15] The response says which dependency failed. It must not carry
    // the driver's error text, which can include host, port and user.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(pool, 'query').mockRejectedValue(
      new Error('connect ECONNREFUSED postgresql://postgres:hunter2@10.0.0.4:5432/wedmoments')
    );

    const res = await fetch(`${BASE_URL}/api/health`);
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toContain('unreachable');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('10.0.0.4');
    expect(text).not.toContain('postgresql://');
  }, 20_000);

  it('gives up rather than hanging when the pool never answers', async () => {
    // The likeliest real failure is pool exhaustion: the query never starts
    // because no connection is free. A probe that waits forever is reported by
    // the HEALTHCHECK as a timeout with no reason attached — the same
    // unhelpful answer this endpoint used to give.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(pool, 'query').mockImplementation(() => new Promise(() => {}) as never);

    const app = express();
    mountHealth(app, 300);
    const quick = createServer(app);
    await new Promise<void>((resolve) => quick.listen(TEST_PORT + 1, () => resolve()));

    try {
      const started = Date.now();
      const res = await fetch(`http://localhost:${TEST_PORT + 1}/api/health`);

      expect(res.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await res.json()).database).toBe('unreachable');
    } finally {
      quick.close();
    }
  }, 20_000);
});
