import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import fs from 'fs';
import path from 'path';
import express from 'express';

const TEST_PORT = 6650;
const BASE_URL = `http://localhost:${TEST_PORT}`;

/**
 * Shutdown has to finish what it started.
 *
 * Until this existed the process was killed outright on every deploy, and the
 * cost is specific rather than theoretical: an upload writes its display,
 * thumbnail and original to storage *before* the row pointing at them can be
 * committed. `photoWrite.savePhotoVariants` cleans that up when a request
 * fails — but a kill mid-request skips the cleanup and the transaction alike,
 * leaving objects no row references, no quota counts, and nothing will ever
 * find again. This repository has recorded three instances of that class.
 *
 * What is asserted here is the contract `server/index.ts`'s `shutdown()`
 * depends on, exercised against a real HTTP server rather than the app's own
 * bootstrap: a request already being served must finish, and no new connection
 * may be accepted once the drain begins. The full sequence — WebSocket
 * teardown, FTP listener, pool drain — is verified by booting the container,
 * because those are process-global and a unit test that tore down the shared
 * pool would break every sibling spec running in the same worker.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

/** A server with one deliberately slow route, so a request can be caught mid-flight. */
function startSlowServer(delayMs: number): Promise<void> {
  const app = express();
  app.get('/slow', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.json({ finished: true });
  });
  app.get('/fast', (_req, res) => res.json({ ok: true }));
  server = createServer(app);
  return new Promise((resolve) => server!.listen(TEST_PORT, () => resolve()));
}

/** The drain step from index.ts's shutdown(), in isolation. */
function drain(): Promise<void> {
  return new Promise((resolve) => {
    server!.close(() => resolve());
    server!.closeIdleConnections?.();
  });
}

describe('draining in-flight work', () => {
  it('lets a request that is already being served finish', async () => {
    // The whole point. Cutting here is what strands a half-written upload.
    await startSlowServer(300);

    const inFlight = fetch(`${BASE_URL}/slow`);
    // Give the request time to reach the handler before closing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const drained = drain();
    const response = await inFlight;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ finished: true });
    await drained;
  }, 20_000);

  it('refuses a new connection once the drain has begun', async () => {
    await startSlowServer(300);

    const inFlight = fetch(`${BASE_URL}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const drained = drain();

    // A connection opened after close() must not be accepted, or the drain
    // never ends and the orchestrator's SIGKILL arrives instead.
    await expect(fetch(`${BASE_URL}/fast`)).rejects.toThrow();

    await inFlight;
    await drained;
  }, 20_000);

  it('resolves only after the last request is done, not immediately', async () => {
    // close() resolving early would mean the pool is torn down underneath a
    // request still using it.
    await startSlowServer(250);

    const started = Date.now();
    const inFlight = fetch(`${BASE_URL}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await drain();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(200);
    await inFlight;
  }, 20_000);

  it('closes promptly when nothing is in flight', async () => {
    // The common case: an idle instance being scaled down should not sit out
    // its whole budget.
    await startSlowServer(300);

    const started = Date.now();
    await drain();

    expect(Date.now() - started).toBeLessThan(1000);
  }, 20_000);
});

describe('the shutdown budget', () => {
  /**
   * Read out of the source rather than imported.
   *
   * `server/index.ts` calls `start()` at module load, so importing it to reach
   * the constant boots the whole application — binding the real port, starting
   * the FTP listener and running migrations — inside a unit test worker. It
   * appears to get away with it only because the worker tears down before
   * `listen` completes, which is luck rather than safety and would collide
   * with a dev server on a slower run. `testPortAllocation.spec.ts` scans
   * source for the same reason.
   */
  function shutdownBudgetFromSource(): number {
    const src = fs.readFileSync(path.resolve(__dirname, '../../server/index.ts'), 'utf8');
    const match = src.match(/SHUTDOWN_BUDGET_MS\s*=\s*Number\(\s*process\.env\.SHUTDOWN_BUDGET_MS\s*\|\|\s*(\d+)\s*\)/);
    if (!match) throw new Error('SHUTDOWN_BUDGET_MS default not found in server/index.ts');
    return Number(match[1]);
  }

  it('is shorter than an orchestrator would wait before SIGKILL', () => {
    // Docker's default grace between SIGTERM and SIGKILL is 10s. A budget at
    // or above that is not a graceful shutdown — it is the same abrupt kill
    // with extra logging, because the kill lands first.
    const budget = shutdownBudgetFromSource();

    expect(budget).toBeLessThan(10_000);
    expect(budget).toBeGreaterThan(1_000);
  });

  it('installs handlers for both signals an operator or orchestrator sends', () => {
    // SIGTERM from an orchestrator, SIGINT from Ctrl+C. Handling one and not
    // the other means half the ways this process stops are still abrupt.
    const src = fs.readFileSync(path.resolve(__dirname, '../../server/index.ts'), 'utf8');

    expect(src).toMatch(/process\.on\('SIGTERM'/);
    expect(src).toMatch(/process\.on\('SIGINT'/);
  });
});
