import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { Client } from 'basic-ftp';
import { query } from '../../server/lib/db';
import { generateIngestKey, hashIngestKey } from '../../server/lib/ingest';

/**
 * The FTP server, end to end, against a real client.
 *
 * Every other test in ftpServer.spec.ts drives `handleLogin` and
 * `handleStoredFile` directly with a mock connection, which is the right way to
 * test the throttle and the listener-dedup rules. The consequence is that
 * `startFtpServer` — the only place the FTP library is actually constructed —
 * was never called by the suite at all.
 *
 * That mattered when ftp-srv was replaced with @electerm/ftp-srv to drop the
 * unmaintained `ip` dependency: fifteen passing tests said nothing about
 * whether the new library could accept a login or receive a file. So this
 * starts the real server on an ephemeral port, connects with a real FTP client,
 * uploads a real JPEG, and asserts the photo arrived in the database through
 * the normal ingest pipeline.
 *
 * It is a slow test by the standards of this suite, and worth it: it is the
 * only thing standing between a library swap and a silently broken
 * photographer ingest at a wedding.
 */

// The smallest valid JPEG that sharp will decode, so the ingest pipeline's
// buildDerivatives step does real work rather than rejecting it as corrupt.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

const FTP_PORT = 2137;

describe('FTP ingest, end to end', () => {
  let eventId = '';
  let eventSlug = '';
  let validKey = '';
  let stagingRoot = '';
  let stopServer: (() => void) | null = null;

  beforeAll(async () => {
    stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wedmoments-ftp-e2e-'));

    const userIns = await query(
      `INSERT INTO users (email, full_name, password_hash, role)
       VALUES ($1, 'FTP E2E Host', 'x', 'couple') RETURNING id`,
      [`ftp-e2e-${Date.now()}@test.com`]
    );
    const userId = userIns.rows[0].id;
    await query(
      `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency)
       VALUES ($1, 'celebration_pass', 'active', 'one_time', 4900, 'EUR')`,
      [userId]
    );

    eventSlug = `ftp-e2e-${Date.now()}`;
    const eventIns = await query(
      `INSERT INTO events (title, slug, host_name, host_email, host_user_id, plan_tier, event_date, venue_name, welcome_message)
       VALUES ('FTP E2E Wedding', $1, 'FTP E2E Host', 'ftp-e2e@test.com', $2, 'free', NOW(), 'Venue', 'Welcome')
       RETURNING id`,
      [eventSlug, userId]
    );
    eventId = eventIns.rows[0].id;

    validKey = generateIngestKey();
    await query(
      `INSERT INTO photographer_ingest_keys (event_id, label, key_hash) VALUES ($1, 'E2E Key', $2)`,
      [eventId, hashIngestKey(validKey)]
    );

    // CONFIG is read once at import, so the environment has to be in place
    // before the module graph is built. resetModules gives a fresh CONFIG and
    // a fresh ftpServer module bound to it.
    vi.stubEnv('FTP_ENABLED', 'true');
    vi.stubEnv('FTP_PORT', String(FTP_PORT));
    vi.stubEnv('FTP_STAGING_DIR', stagingRoot);
    vi.resetModules();

    const mod = await import('../../server/ftp/ftpServer');
    mod.startFtpServer();
    stopServer = mod.stopFtpServer;

    // listen() resolves asynchronously inside startFtpServer, which returns
    // void. Poll the port rather than sleeping a fixed amount.
    await waitForPort(FTP_PORT, 5000);
  }, 30_000);

  afterAll(async () => {
    stopServer?.();
    vi.unstubAllEnvs();
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  });

  it('accepts a login and ingests an uploaded frame', async () => {
    const client = new Client(15_000);
    try {
      await client.access({
        host: '127.0.0.1',
        port: FTP_PORT,
        // The credentials a photographer's camera is given: the event's slug
        // and its ingest key.
        user: eventSlug,
        password: validKey,
        secure: false,
      });

      await client.uploadFrom(Readable.from(JPEG_1X1), 'DSC_0001.jpg');
    } finally {
      client.close();
    }

    const row = await waitForPhoto(eventId, 10_000);
    expect(row).not.toBeNull();
    // The pipeline's photographer markers, not a guest upload.
    expect(row.source).toBe('photographer');
    expect(Number(row.priority)).toBe(10);
    expect(Number(row.storage_bytes)).toBeGreaterThan(0);
  }, 30_000);

  it('refuses a login with the wrong ingest key', async () => {
    const client = new Client(10_000);
    let failed = false;
    try {
      await client.access({
        host: '127.0.0.1',
        port: FTP_PORT,
        user: eventSlug,
        password: 'not-the-key',
        secure: false,
      });
    } catch {
      failed = true;
    } finally {
      client.close();
    }

    expect(failed).toBe(true);
  }, 20_000);
});

/** Resolve once something is listening, or reject after `timeoutMs`. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const net = await import('net');
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`FTP server did not listen on ${port} in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The STOR handler runs after the transfer completes, so the row appears a
 * moment after the client call returns. Poll rather than sleep.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForPhoto(eventId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await query(
      'SELECT source, priority, storage_bytes FROM photos WHERE event_id = $1 LIMIT 1',
      [eventId]
    );
    if (res.rows.length > 0) return res.rows[0];
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}
