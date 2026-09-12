import fs from 'fs';
import path from 'path';
import { FtpSrv } from '@electerm/ftp-srv';
import { CONFIG } from '../lib/config';
import { pool } from '../lib/db';
import { validateIngestKey } from '../lib/ingest';
import { ingestPhoto } from '../lib/ingestPipeline';

let ftpServer: FtpSrv | null = null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

/** Resolve an FTP username (event UUID or slug) to an event id. */
async function resolveEventId(username: string): Promise<string | null> {
  const isUuid = UUID_RE.test(username);
  const res = isUuid
    ? await pool.query('SELECT id FROM events WHERE id = $1', [username])
    : await pool.query('SELECT id FROM events WHERE slug = $1', [username]);
  return res.rows.length > 0 ? res.rows[0].id : null;
}

// --------------------------------------------------------------------
// SEC-F5 — per-IP login throttle. The FTP library has no built-in rate limiting,
// and the ingest key is a bearer credential tried over the FTP PASS
// command — nothing stopped rapid-fire guessing against it.
// --------------------------------------------------------------------
const MAX_LOGIN_FAILURES = 5;
const LOGIN_BLOCK_MS = 60_000;
const LOGIN_ATTEMPT_TTL_MS = 60 * 60 * 1000;
const LOGIN_TRACKING_SWEEP_THRESHOLD = 1000;

interface LoginAttemptRecord {
  failures: number;
  blockedUntil: number;
  lastAttempt: number;
}

const loginAttempts = new Map<string, LoginAttemptRecord>();

function sweepStaleLoginAttempts(): void {
  if (loginAttempts.size < LOGIN_TRACKING_SWEEP_THRESHOLD) return;
  const cutoff = Date.now() - LOGIN_ATTEMPT_TTL_MS;
  for (const [ip, record] of loginAttempts) {
    if (record.lastAttempt < cutoff) loginAttempts.delete(ip);
  }
}

/** True when this IP is currently locked out from too many recent failures. */
export function isLoginBlocked(ip: string): boolean {
  const record = loginAttempts.get(ip);
  return !!record && record.blockedUntil > Date.now();
}

export function recordLoginFailure(ip: string): void {
  sweepStaleLoginAttempts();
  const now = Date.now();
  const record = loginAttempts.get(ip) || { failures: 0, blockedUntil: 0, lastAttempt: now };
  record.failures += 1;
  record.lastAttempt = now;
  if (record.failures >= MAX_LOGIN_FAILURES) {
    record.blockedUntil = now + LOGIN_BLOCK_MS;
    record.failures = 0;
  }
  loginAttempts.set(ip, record);
}

export function recordLoginSuccess(ip: string): void {
  loginAttempts.delete(ip);
}

/** Test-only: clear all tracked login attempts between specs. */
export function resetLoginThrottle(): void {
  loginAttempts.clear();
}

export const LOGIN_THROTTLE = { MAX_LOGIN_FAILURES, LOGIN_BLOCK_MS };

/**
 * Resolve the path the STOR event reports into a real filesystem path.
 *
 * The library emits the *client* path — the virtual path as the camera sees it,
 * e.g. `/DSC_0001.jpg` — not the file on disk. (ftp-srv 4.x emitted the server
 * path; this is the one behavioural difference between it and
 * @electerm/ftp-srv that this module has to absorb, and it fails silently
 * rather than loudly: stat() on a client path throws, the catch logs, and the
 * photo simply never arrives.)
 *
 * The client chooses that string, so it is not trusted here even though the
 * library resolved it once already. Anything that escapes the event's own
 * staging directory returns null and is dropped: one photographer's frames must
 * not be writable into another event's folder, and `../` is all that would
 * take.
 */
export function resolveStoredPath(eventDir: string, clientPath: string): string | null {
  if (!clientPath) return null;

  // The client path is absolute in FTP's own rooted namespace, which is the
  // event directory. Strip the leading separator so it joins as relative.
  const relative = clientPath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(eventDir, relative);
  const root = path.resolve(eventDir);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.warn(`[FTP] Refused a STOR path outside the event staging directory: ${clientPath}`);
    return null;
  }
  return resolved;
}

/** Handle a completed FTP STOR: read the staged file, ingest it, then remove it. */
export async function handleStoredFile(eventId: string, err: Error | null, serverPath?: string): Promise<void> {
  try {
    if (err) {
      console.warn('[FTP] STOR error:', err instanceof Error ? err.message : String(err));
      return;
    }
    if (!serverPath) return;

    // MED-05 — the FTP server writes the incoming STOR straight to disk with no
    // size cap of its own (unlike multer's `limits.fileSize` on the HTTP
    // upload paths), so nothing stopped a multi-gigabyte transfer. Stat
    // before reading and refuse anything over the same cap HTTP enforces,
    // so an oversized file is never pulled whole into one Buffer.
    const stats = await fs.promises.stat(serverPath);
    const maxBytes = CONFIG.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
    if (stats.size > maxBytes) {
      console.warn(`[FTP] Rejected oversized upload (${stats.size} bytes > ${maxBytes}): ${serverPath}`);
      return;
    }

    // [FIX SEC-F4] Async read — a DSLR frame is tens of megabytes, and a
    // synchronous read blocks the single Node event loop for every other
    // connection (HTTP and FTP alike) while it happens.
    const buffer = await fs.promises.readFile(serverPath);
    const ext = path.extname(serverPath).toLowerCase();
    const base = path.basename(serverPath);
    const outcome = await ingestPhoto(eventId, buffer, base, mimeForExt(ext), {
      baseUrl: CONFIG.PUBLIC_BASE_URL,
    });
    if (outcome.ok) {
      console.log(`[FTP] Ingested ${base} -> ${outcome.photo.id}`);
    } else if (outcome.reason === 'tier_limit') {
      console.warn(`[FTP] Rejected ${base}: ${outcome.message}`);
    } else {
      console.warn(`[FTP] Skipped non-image file ${base}`);
    }
  } catch (e) {
    console.error('[FTP] Ingest error:', (e instanceof Error ? e.message : '') || e);
  } finally {
    // [FIX SEC-F3] Runs for every code path above, including the early
    // `err` return — an aborted transfer used to leave its partial file in
    // ftp-staging/<eventId>/ forever, since only the try block was cleaned up.
    if (serverPath) fs.unlink(serverPath, () => {});
  }
}

/**
 * SEC-F1/P4 decision, isolated as a pure function so it's testable without
 * touching real env vars, sockets, or module state.
 */
export function shouldRefusePlaintextStart(
  tlsConfigured: boolean,
  isProduction: boolean,
  allowPlaintext: boolean
): boolean {
  return !tlsConfigured && isProduction && !allowPlaintext;
}

/** The slice of the FTP library's connection object this module actually touches. */
export interface FtpConnectionLike {
  ip: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event: string): unknown;
}

export type LoginResolve = (config: { root: string; cwd: string }) => void;
export type LoginReject = (err: Error) => void;

/**
 * The 'login' handler body, extracted so SEC-F2 (listener dedup) and the
 * throttle (SEC-F5) are testable against a mock connection instead of a
 * real FTP client/socket.
 */
export async function handleLogin(
  stagingRoot: string,
  { connection, username, password }: { connection: FtpConnectionLike; username: string; password: string },
  resolve: LoginResolve,
  reject: LoginReject
): Promise<void> {
  const ip = connection.ip || 'unknown';

  if (isLoginBlocked(ip)) {
    reject(new Error('Too many failed login attempts. Try again in a minute.'));
    return;
  }

  try {
    const eventId = await resolveEventId(username.trim());
    if (!eventId) {
      recordLoginFailure(ip);
      reject(new Error('Unknown event. Use the event id or slug as the username.'));
      return;
    }

    const keyId = await validateIngestKey(eventId, password);
    if (!keyId) {
      recordLoginFailure(ip);
      reject(new Error('Invalid ingest key'));
      return;
    }

    recordLoginSuccess(ip);

    const eventDir = path.join(stagingRoot, eventId);
    fs.mkdirSync(eventDir, { recursive: true });

    // [FIX SEC-F2] A connection can re-authenticate (re-issue USER/PASS)
    // without reconnecting; without this, each successful login on the
    // same connection stacked another 'STOR' listener, so one uploaded
    // file triggered the ingest pipeline once per login on that session —
    // duplicate DB rows, and an ENOENT on the second unlink attempt.
    connection.removeAllListeners('STOR');
    connection.on('STOR', (...args: unknown[]) => {
      const [storeErr, clientPath] = args as [Error | null, string | undefined];
      const serverPath = clientPath ? resolveStoredPath(eventDir, clientPath) ?? undefined : undefined;
      handleStoredFile(eventId, storeErr, serverPath).catch(() => {});
    });

    resolve({ root: eventDir, cwd: '/' });
  } catch (err) {
    recordLoginFailure(ip);
    // reject() expects an Error; wrap anything else so the client
    // still gets a clean login failure instead of an unhandled rejection.
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Start the in-process FTP/FTPS server (no-op unless FTP_ENABLED=true). */
export function startFtpServer(): void {
  if (!CONFIG.FTP_ENABLED) {
    console.log('[FTP] In-process FTP server disabled (set FTP_ENABLED=true to enable).');
    return;
  }

  const stagingRoot = CONFIG.FTP_STAGING_DIR;
  fs.mkdirSync(stagingRoot, { recursive: true });

  const tlsOptions = CONFIG.FTP_TLS_CERT && CONFIG.FTP_TLS_KEY
    ? { key: fs.readFileSync(CONFIG.FTP_TLS_KEY), cert: fs.readFileSync(CONFIG.FTP_TLS_CERT) }
    : false;

  // [FIX SEC-F1/P4] An ingest key is a long-lived bearer credential sent in
  // cleartext over plain FTP's PASS command. Refuse to start plaintext FTP
  // in production rather than only warning after the fact — the warning is
  // easy to miss in container logs, and by then the server is already
  // listening. FTP_ALLOW_PLAINTEXT is an explicit, deliberate override.
  const isProduction = process.env.NODE_ENV === 'production';
  if (shouldRefusePlaintextStart(!!tlsOptions, isProduction, CONFIG.FTP_ALLOW_PLAINTEXT)) {
    console.error(
      '[FTP] Refusing to start: FTP_ENABLED=true in production without FTP_TLS_CERT/FTP_TLS_KEY. ' +
      'Photographer ingest keys would cross the network in cleartext. Set both, or set ' +
      'FTP_ALLOW_PLAINTEXT=true to start anyway (not recommended on untrusted Wi-Fi).'
    );
    return;
  }

  ftpServer = new FtpSrv({
    url: `ftp://0.0.0.0:${CONFIG.FTP_PORT}`,
    pasv_url: CONFIG.FTP_PASV_URL || undefined,
    anonymous: false,
    tls: tlsOptions,
    greeting: ['WedMoments Pro Photographer Ingest', 'Upload JPEGs to the live screen'],
  });

  // username = event id (or slug), password = photographer ingest key
  ftpServer.on('login', (data, resolve, reject) => {
    handleLogin(stagingRoot, data, resolve, reject).catch((err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  ftpServer.on('client-error', ({ context, error }) => {
    console.warn('[FTP] client error:', context, error?.message);
  });

  ftpServer
    .listen()
    .then(() => {
      const mode = tlsOptions ? 'explicit FTPS (AUTH TLS) + plain FTP' : 'plain FTP';
      console.log(`[FTP] In-process FTP server listening on 0.0.0.0:${CONFIG.FTP_PORT} (${mode})`);
      if (!tlsOptions) {
        console.warn(
          '[FTP] TLS is not configured: photographer ingest keys will cross the network in ' +
          'cleartext. Set FTP_TLS_CERT and FTP_TLS_KEY before using this on venue Wi-Fi.'
        );
      }
    })
    .catch((err: unknown) => {
      console.error('[FTP] Failed to start FTP server:', (err instanceof Error ? err.message : '') || err);
    });
}

export function stopFtpServer(): void {
  if (ftpServer) {
    try {
      ftpServer.close();
    } catch {
      // ignore
    }
    ftpServer = null;
  }
  loginAttempts.clear();
}
