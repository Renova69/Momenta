import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { parseTrustProxy } from '../../server/lib/config';
import { query } from '../../server/lib/db';
import * as authMiddleware from '../../server/middleware/auth';
import { issueDownloadToken } from '../../server/lib/downloadToken';
import { issueGuestToken } from '../../server/lib/guestAuth';
import { hashPassword } from '../../server/middleware/auth';
import { computeExpiry } from '../../server/lib/retention';

/**
 * Regressions for the remaining auth-hygiene slice of OPEN_ITEMS.md Phase 5:
 *
 *   SEC-A3 — `trust proxy` was hardcoded to `1`, so a client reaching this
 *   server directly (the shipped docker-compose.yml has no reverse proxy)
 *   could put any IP it wanted in X-Forwarded-For and have the IP-based rate
 *   limiters key on it.
 *   SEC-A6 — login returned in ~1ms for a nonexistent email but ran a real
 *   bcrypt comparison (~90ms) for a real email with the wrong password —
 *   enough of a gap to enumerate registered emails by timing alone.
 *   SEC-A7 — bcrypt silently truncates at 72 *bytes*; a password with
 *   multi-byte UTF-8 could exceed that well under 72 characters and Zod's
 *   128-character cap never caught it.
 */

describe('parseTrustProxy (SEC-A3)', () => {
  it('defaults closed when unset', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
  });

  it('parses explicit booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('parses a hop count as a number', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('passes through a non-numeric value (IP/CIDR/preset) as-is', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('Login timing & password hygiene (SEC-A6, SEC-A7)', () => {
  const TEST_PORT = 6607;
  const BASE_URL = `http://localhost:${TEST_PORT}`;
  let server: ReturnType<typeof createServer>;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await query('DELETE FROM users WHERE email = ANY($1::text[])', [createdEmails]).catch(() => undefined);
    }
    if (server) server.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a real bcrypt comparison even for a nonexistent email (SEC-A6)', async () => {
    // Wall-clock timing is too noisy in CI (cold-start alone can exceed a
    // real bcrypt round trip) — assert the actual mechanism directly:
    // comparePassword is called against the fixed decoy hash.
    const spy = vi.spyOn(authMiddleware, 'comparePassword');

    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nobody-${Date.now()}@test.com`, password: 'whatever123' }),
    });

    expect(res.status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('whatever123', authMiddleware.DUMMY_PASSWORD_HASH);
  });

  it('rejects a registration password that exceeds 72 bytes via multi-byte characters (SEC-A7)', async () => {
    // 40 repeats of a 3-byte character = 120 bytes, but only 40 *characters*
    // — comfortably under the old 128-character cap, well over bcrypt's
    // 72-byte limit.
    const multiByte = '\u{1F600}'.repeat(40); // 😀, 4 bytes each in UTF-8 = 160 bytes
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `a7-${Date.now()}@test.com`,
        fullName: 'Byte Cap Spec',
        password: multiByte,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('still accepts a plain-ASCII password right at 72 characters', async () => {
    const email = `a7-ok-${Date.now()}@test.com`;
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        fullName: 'Byte Cap Spec OK',
        password: 'a'.repeat(72),
      }),
    });
    expect(res.status).toBe(201);
    createdEmails.push(email);
  });

  it('rejects a plain-ASCII password over 72 characters', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `a7-toolong-${Date.now()}@test.com`,
        fullName: 'Byte Cap Spec Long',
        password: 'a'.repeat(73),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('requireAuth rejects non-session tokens (SEC-01)', () => {
  const TEST_PORT = 6610;
  const BASE_URL = `http://localhost:${TEST_PORT}`;
  let server: ReturnType<typeof createServer>;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await query('DELETE FROM users WHERE email = ANY($1::text[])', [createdEmails]).catch(() => undefined);
    }
    if (server) server.close();
  });

  it('rejects a download token replayed as a Bearer session token', async () => {
    const email = `sec01-${Date.now()}@test.com`;
    createdEmails.push(email);
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName: 'SEC-01 Spec Host', password: 'Password123!' }),
    });
    const regData = await regRes.json();

    // A real, validly-signed download token for this exact host+event —
    // the token this session should never accept as a full session.
    const { token: downloadToken } = issueDownloadToken(regData.event.id, regData.user.id);

    const listRes = await fetch(`${BASE_URL}/api/events`, {
      headers: { Authorization: `Bearer ${downloadToken}` },
    });
    expect(listRes.status).toBe(401);

    // The real session token from registration still works, proving this
    // isn't a route/setup problem masking the result above.
    const controlRes = await fetch(`${BASE_URL}/api/events`, {
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    expect(controlRes.status).toBe(200);
  });

  it('rejects a guest token replayed as a Bearer session token', async () => {
    const guestToken = issueGuestToken('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
    const res = await fetch(`${BASE_URL}/api/events`, {
      headers: { Authorization: `Bearer ${guestToken}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("Login's event-auto-creation fallback (DB-13)", () => {
  const TEST_PORT = 6620;
  const BASE_URL = `http://localhost:${TEST_PORT}`;
  let server: ReturnType<typeof createServer>;
  let userId = '';
  const email = `db13-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const password = 'Password123!';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    // Bypasses normal registration (which always auto-creates one event) to
    // reach the exact scenario the login fallback exists for: a user row
    // with zero events, e.g. an OAuth import.
    const passwordHash = await hashPassword(password);
    const created = await query(
      `INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [email, 'DB13 Spec Host', passwordHash]
    );
    userId = created.rows[0].id;
    await query(
      `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency)
       VALUES ($1, 'free', 'active', 'one_time', 0, 'EUR')`,
      [userId]
    );
  });

  afterAll(async () => {
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    if (server) server.close();
  });

  it('the auto-created event has a real expires_at, not left NULL forever', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event?.id).toBeTruthy();

    const row = await query('SELECT expires_at, event_date, created_at FROM events WHERE id = $1', [data.event.id]);
    expect(row.rows[0].expires_at).not.toBeNull();
    const expected = computeExpiry('free', row.rows[0].event_date, row.rows[0].created_at);
    expect(new Date(row.rows[0].expires_at).toISOString()).toBe(expected!.toISOString());
  });
});

describe('PUT /api/auth/me — host profile updates', () => {
  const TEST_PORT = 6623;
  const BASE_URL = `http://localhost:${TEST_PORT}`;
  let server: ReturnType<typeof createServer>;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await query('DELETE FROM users WHERE email = ANY($1::text[])', [createdEmails]).catch(() => undefined);
    }
    if (server) server.close();
  });

  async function registerHost() {
    const email = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
    createdEmails.push(email);
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName: 'Original Name', password: 'Password123!' }),
    });
    const data = await res.json();
    return { token: data.token as string, email };
  }

  it('updates the full name and persists it', async () => {
    const { token } = await registerHost();

    const putRes = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fullName: 'Кирил и Мадалина' }),
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.user.fullName).toBe('Кирил и Мадалина');

    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meData = await meRes.json();
    expect(meData.user.fullName).toBe('Кирил и Мадалина');
  });

  it('does not accept a change to email through this route', async () => {
    const { token, email } = await registerHost();

    const putRes = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fullName: 'New Name', email: 'someone-else@test.com' }),
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.user.email).toBe(email);
  });

  it('rejects an empty name', async () => {
    const { token } = await registerHost();

    const putRes = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fullName: '   ' }),
    });
    expect(putRes.status).toBe(400);
  });

  it('rejects the request without a valid session token', async () => {
    const putRes = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'Nobody' }),
    });
    expect(putRes.status).toBe(401);
  });
});
