import type { Request, Response } from 'express';
import { pool } from './db';
import { errorLabel } from './errors';
import { CONFIG } from './config';
import { wsManager } from '../ws/wsServer';

/**
 * How long the database has to answer before it counts as unreachable.
 *
 * Deliberately shorter than the Dockerfile's `--timeout 5s`: a probe that
 * outlives the health check it serves is reported as a timeout with no reason
 * attached, which is the same unhelpful answer this endpoint used to give.
 */
export const HEALTH_DB_TIMEOUT_MS = 2000;

export interface HealthBody {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unreachable';
  connectedSockets: number;
  storageProvider: string;
  timestamp: string;
}

/**
 * Is this instance able to serve a request?
 *
 * It used to answer `status: 'ok'` unconditionally — the payload was built from
 * a socket count and two constants, and nothing was consulted. With Postgres
 * down, every real request returned 500 while this endpoint, which the
 * container's HEALTHCHECK curls, kept saying the instance was fine. An
 * orchestrator reading it would have gone on routing traffic to a process that
 * could not answer any of it.
 *
 * So it now asks the one question that decides whether work can be done, and
 * names the dependency when the answer is no. `SELECT 1` is chosen for being
 * uninteresting: it proves a connection can be acquired from the pool and the
 * server is responding, without touching a table whose contents could make a
 * healthy instance look unhealthy.
 *
 * **Readiness, not liveness.** Failing here says "do not send me work", not
 * "restart me" — restarting will not repair someone else's database. That
 * distinction costs nothing in this deployment: plain Docker and Compose do not
 * act on a failing HEALTHCHECK beyond marking the container unhealthy, and
 * nothing in docker-compose.yml gates on the app's health. On an orchestrator
 * that *does* restart unhealthy containers, split this into a liveness endpoint
 * that stays 200 and point the probe there instead.
 *
 * Lives in its own module so the tests exercise this handler rather than a
 * copy of it: importing `server/index.ts` calls `start()` at module load and
 * would boot the whole application — real port, FTP listener, migrations —
 * inside a test worker.
 *
 * [FIX M-15] No internal paths exposed — the failure reason names the
 * dependency, never the connection string or the driver's error text.
 */
export function healthHandler(timeoutMs: number = HEALTH_DB_TIMEOUT_MS) {
  return async (_req: Request, res: Response): Promise<void> => {
    const body: HealthBody = {
      status: 'ok',
      database: 'ok',
      connectedSockets: wsManager.getConnectedClientsCount(),
      storageProvider: CONFIG.STORAGE_PROVIDER,
      timestamp: new Date().toISOString(),
    };

    // Held outside the try so the deadline can be cleared whichever way the
    // race settles. Leaving it pending is the leak that cost a CI run once
    // already (N-2): the loser of a race is not cancelled, so a probe that
    // answered in 5ms still left a 2s timer armed, on an endpoint an
    // orchestrator calls every few seconds forever.
    let deadline: NodeJS.Timeout | undefined;

    try {
      // Promise.race rather than a statement_timeout: the failure this is most
      // likely to catch is pool exhaustion, where the query never starts
      // because no connection is free, and a statement timeout would never
      // fire.
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch (err) {
      body.status = 'degraded';
      body.database = 'unreachable';
      // Logged in full here, reported by name only to the caller.
      console.error('[Health] database probe failed:', errorLabel(err));
      res.status(503).json(body);
      return;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }

    res.json(body);
  };
}
