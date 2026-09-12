import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { query } from '../../server/lib/db';
import { CONFIG } from '../../server/lib/config';
import {
  shouldRefusePlaintextStart,
  handleLogin,
  handleStoredFile,
  isLoginBlocked,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
  resolveStoredPath,
  LOGIN_THROTTLE,
  type FtpConnectionLike,
} from '../../server/ftp/ftpServer';
import { generateIngestKey, hashIngestKey } from '../../server/lib/ingest';

/**
 * Regressions for OPEN_ITEMS.md's FTP hardening cluster:
 *
 *   SEC-F1/P4 — plain FTP in production is refused rather than only warned
 *   about after the fact.
 *   SEC-F2 — a connection re-authenticating no longer stacks duplicate
 *   'STOR' listeners.
 *   SEC-F3 — an aborted transfer's staged file is still cleaned up.
 *   SEC-F4 — the staged file read is async (covered implicitly by the
 *   success-path test still working; a sync read would have blocked but
 *   not failed, so this is mostly documented via the source change itself).
 *   SEC-F5 — repeated failed logins from one IP get throttled.
 */

function mockConnection(ip: string): FtpConnectionLike & EventEmitter {
  const emitter = new EventEmitter() as EventEmitter & { ip: string };
  emitter.ip = ip;
  return emitter as FtpConnectionLike & EventEmitter;
}

describe('shouldRefusePlaintextStart (SEC-F1/P4)', () => {
  it('refuses plain FTP in production with no TLS and no override', () => {
    expect(shouldRefusePlaintextStart(false, true, false)).toBe(true);
  });

  it('allows it in production when TLS is configured', () => {
    expect(shouldRefusePlaintextStart(true, true, false)).toBe(false);
  });

  it('allows it in production with the explicit override', () => {
    expect(shouldRefusePlaintextStart(false, true, true)).toBe(false);
  });

  it('allows it outside production regardless of TLS', () => {
    expect(shouldRefusePlaintextStart(false, false, false)).toBe(false);
  });
});

describe('Login throttle (SEC-F5)', () => {
  beforeEach(() => resetLoginThrottle());

  it('blocks an IP after the failure threshold and not before', () => {
    const ip = '203.0.113.5';
    for (let i = 0; i < LOGIN_THROTTLE.MAX_LOGIN_FAILURES - 1; i++) {
      recordLoginFailure(ip);
      expect(isLoginBlocked(ip)).toBe(false);
    }
    recordLoginFailure(ip);
    expect(isLoginBlocked(ip)).toBe(true);
  });

  it('does not block an unrelated IP', () => {
    for (let i = 0; i < LOGIN_THROTTLE.MAX_LOGIN_FAILURES; i++) {
      recordLoginFailure('203.0.113.5');
    }
    expect(isLoginBlocked('203.0.113.6')).toBe(false);
  });

  it('a success clears the failure count for that IP', () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < LOGIN_THROTTLE.MAX_LOGIN_FAILURES - 1; i++) {
      recordLoginFailure(ip);
    }
    recordLoginSuccess(ip);
    recordLoginFailure(ip);
    expect(isLoginBlocked(ip)).toBe(false);
  });
});

describe('handleLogin (SEC-F2, SEC-F5 wired together)', () => {
  let eventId = '';
  let validKey = '';
  let stagingRoot = '';

  beforeAll(async () => {
    stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wedmoments-ftp-spec-'));

    // Build a real event + ingest key directly against the DB — this module
    // works below the HTTP layer, and its only real dependency is the DB.
    const userIns = await query(
      `INSERT INTO users (email, full_name, password_hash, role)
       VALUES ($1, 'FTP Spec Host', 'x', 'couple') RETURNING id`,
      [`ftp-spec-${Date.now()}@test.com`]
    );
    const userId = userIns.rows[0].id;
    await query(
      `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency)
       VALUES ($1, 'free', 'active', 'one_time', 0, 'EUR')`,
      [userId]
    );
    const eventIns = await query(
      `INSERT INTO events (title, slug, host_name, host_email, host_user_id, plan_tier, event_date, venue_name, welcome_message)
       VALUES ('FTP Spec Wedding', $1, 'FTP Spec Host', 'ftp-spec@test.com', $2, 'free', NOW(), 'Venue', 'Welcome')
       RETURNING id`,
      [`ftp-spec-${Date.now()}`, userId]
    );
    eventId = eventIns.rows[0].id;

    validKey = generateIngestKey();
    await query(
      `INSERT INTO photographer_ingest_keys (event_id, label, key_hash) VALUES ($1, 'Spec Key', $2)`,
      [eventId, hashIngestKey(validKey)]
    );
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  });

  beforeEach(() => resetLoginThrottle());

  it('rejects an unknown event and records a failure', async () => {
    const connection = mockConnection('198.51.100.10');
    let rejected: Error | null = null;
    await handleLogin(
      stagingRoot,
      { connection, username: 'not-a-real-event', password: validKey },
      () => {},
      (err) => {
        rejected = err;
      }
    );
    expect(rejected).not.toBeNull();
  });

  it('rejects an invalid key and records a failure', async () => {
    const connection = mockConnection('198.51.100.11');
    let rejected: Error | null = null;
    await handleLogin(
      stagingRoot,
      { connection, username: eventId, password: 'wmi_not-the-real-key' },
      () => {},
      (err) => {
        rejected = err;
      }
    );
    expect(rejected).not.toBeNull();
  });

  it('blocks further attempts from an IP after enough failures, even with the right key', async () => {
    const ip = '198.51.100.12';
    const connection = mockConnection(ip);
    for (let i = 0; i < LOGIN_THROTTLE.MAX_LOGIN_FAILURES; i++) {
      await handleLogin(stagingRoot, { connection, username: eventId, password: 'wrong' }, () => {}, () => {});
    }

    let rejected: Error | null = null;
    await handleLogin(
      stagingRoot,
      { connection, username: eventId, password: validKey }, // correct key, IP still throttled
      () => {},
      (err) => {
        rejected = err;
      }
    );
    expect(rejected).not.toBeNull();
    expect(rejected!.message).toMatch(/too many/i);
  });

  it('resolves on a valid login and attaches exactly one STOR listener', async () => {
    const connection = mockConnection('198.51.100.13');
    let resolved: { root: string; cwd: string } | null = null;
    await handleLogin(
      stagingRoot,
      { connection, username: eventId, password: validKey },
      (config) => {
        resolved = config;
      },
      () => {}
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.root).toBe(path.join(stagingRoot, eventId));
    expect(connection.listenerCount('STOR')).toBe(1);
  });

  it('re-authenticating on the same connection still leaves exactly one STOR listener (SEC-F2)', async () => {
    const connection = mockConnection('198.51.100.14');

    for (let i = 0; i < 3; i++) {
      await handleLogin(stagingRoot, { connection, username: eventId, password: validKey }, () => {}, () => {});
    }

    // Before the fix, this would be 3 — one accumulated per re-login.
    expect(connection.listenerCount('STOR')).toBe(1);
  });
});

describe('handleStoredFile (SEC-F3, SEC-F4)', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedmoments-ftp-stor-'));
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cleans up the staged file even when the transfer errored (SEC-F3)', async () => {
    const staged = path.join(tmpDir, 'aborted.jpg');
    fs.writeFileSync(staged, Buffer.from([0xff, 0xd8, 0xff]));
    expect(fs.existsSync(staged)).toBe(true);

    await handleStoredFile('00000000-0000-0000-0000-000000000000', new Error('connection reset'), staged);

    // fs.unlink's callback is async — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('does nothing and does not throw when no serverPath is given', async () => {
    await expect(handleStoredFile('00000000-0000-0000-0000-000000000000', null, undefined)).resolves.toBeUndefined();
  });

  it('rejects a staged file over the upload cap and never reads it into memory (MED-05)', async () => {
    const staged = path.join(tmpDir, 'huge.jpg');
    const oversizedBytes = CONFIG.MAX_UPLOAD_SIZE_MB * 1024 * 1024 + 1024;
    fs.writeFileSync(staged, Buffer.alloc(oversizedBytes));

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    try {
      await handleStoredFile('00000000-0000-0000-0000-000000000000', null, staged);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }

    // fs.unlink's callback is async — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(staged)).toBe(false);
  });
});

describe('resolveStoredPath (STOR path is client-controlled)', () => {
  const eventDir = path.join(os.tmpdir(), 'wedmoments-stor-spec', 'event-1');

  it('resolves the virtual FTP path to a file inside the event directory', () => {
    expect(resolveStoredPath(eventDir, '/DSC_0001.jpg')).toBe(path.join(eventDir, 'DSC_0001.jpg'));
    // No leading slash, and a nested folder the camera created.
    expect(resolveStoredPath(eventDir, 'sub/DSC_0002.jpg')).toBe(
      path.join(eventDir, 'sub', 'DSC_0002.jpg')
    );
  });

  it('refuses a path that climbs out of the event directory', () => {
    // The library reports the path the client asked for. One photographer's
    // frames must not be writable into another event's staging folder, and
    // `../` is the whole distance between those two things.
    expect(resolveStoredPath(eventDir, '../event-2/stolen.jpg')).toBeNull();
    expect(resolveStoredPath(eventDir, '/../../etc/passwd')).toBeNull();
  });

  it('refuses an empty path rather than resolving to the directory itself', () => {
    expect(resolveStoredPath(eventDir, '')).toBeNull();
  });
});
