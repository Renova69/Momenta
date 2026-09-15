import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { query } from '../../server/lib/db';

const TEST_PORT = 6649;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

/**
 * Registration and sign-in, at the edges the happy path never reaches.
 *
 * `serverAuth.spec.ts` covers hashing, tokens and the middleware;
 * `authHardening.spec.ts` covers the timing decoy (SEC-A6), the 72-byte bcrypt
 * truncation (SEC-A7) and token replay. What was left uncovered here is what
 * happens when two people, or one person twice, arrive at the same account —
 * which is where an auth route stops being about cryptography and starts being
 * about whether someone can get back into their own wedding album.
 */

const createdEvents: string[] = [];
const createdUsers: string[] = [];

interface Registered {
  status: number;
  body: Record<string, unknown>;
}

async function register(email: string, fullName = 'Lifecycle Spec Host'): Promise<Registered> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName, password: 'Password123!' }),
  });
  const body = await res.json().catch(() => ({}));
  const event = (body as { event?: { id?: string } }).event;
  const user = (body as { user?: { id?: string } }).user;
  if (event?.id) createdEvents.push(event.id);
  if (user?.id) createdUsers.push(user.id);
  return { status: res.status, body: body as Record<string, unknown> };
}

function login(email: string, password = 'Password123!'): Promise<Response> {
  return fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function uniqueEmail(prefix = 'lifecycle'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
}, 30_000);

afterAll(async () => {
  if (server) server.close();
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(
    () => undefined
  );
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(
    () => undefined
  );
});

describe('registering the same address twice', () => {
  it('refuses the second attempt with a 409, not a duplicate account', async () => {
    const email = uniqueEmail();

    const first = await register(email);
    const second = await register(email);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  }, 30_000);

  it('refuses a simultaneous duplicate with a 409 rather than a 500 (M8)', async () => {
    // The email pre-check is a plain SELECT, so two concurrent registrations
    // can both pass it and one loses the race against users_email_key. That is
    // the same situation the pre-check reports as 409; surfacing it as an
    // opaque 500 just because it was detected a few milliseconds later would be
    // a worse answer to an identical condition.
    const email = uniqueEmail();

    const [a, b] = await Promise.all([register(email), register(email)]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([201, 409]);

    const { rows } = await query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM users WHERE email = $1',
      [email]
    );
    expect(rows[0].c).toBe(1);
  }, 30_000);
});

describe('what registration hands back', () => {
  it('never returns the password hash', async () => {
    const { body } = await register(uniqueEmail());

    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect(JSON.stringify(body)).not.toContain('$2b$');
  }, 30_000);

  it('returns the host their own name and a usable session', async () => {
    const { status, body } = await register(uniqueEmail(), 'Monika Petrova');

    expect(status).toBe(201);
    expect((body.user as Record<string, unknown>).fullName).toBe('Monika Petrova');
    expect(typeof body.token).toBe('string');
  }, 30_000);
});

describe('signing in to an account that cannot take a password', () => {
  it('refuses rather than failing with a 500', async () => {
    // password_hash is nullable — a row seeded by a migration or created
    // administratively has none. Reaching bcrypt with null would throw, and a
    // 500 on the login route reads as an outage rather than as an account that
    // needs attention.
    const email = uniqueEmail('nohash');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, role)
       VALUES ($1, 'No Hash Host', NULL, 'host') RETURNING id`,
      [email]
    );
    createdUsers.push(rows[0].id);

    const res = await login(email);

    expect(res.status).toBe(401);
    expect(String((await res.json()).error)).toMatch(/password setup/i);
  }, 30_000);
});

describe('the capitalisation a phone keyboard adds', () => {
  it('signs the host in when they type their address in a different case', async () => {
    // Mobile keyboards capitalise the first character by default, so an
    // address is routinely entered as `Ana@...` on a phone and `ana@...` on a
    // laptop. If the lookup is case-sensitive, the second one is simply not an
    // account, and the host is locked out of their own wedding album with
    // "Invalid email or password."
    const email = uniqueEmail('CaseTest');
    const capitalised = email.charAt(0).toUpperCase() + email.slice(1);

    const registered = await register(capitalised);
    expect(registered.status).toBe(201);

    const res = await login(capitalised.toLowerCase());

    expect(res.status).toBe(200);
  }, 30_000);

  it('does not let the same address register twice under different casing', async () => {
    // Otherwise one person ends up with two accounts and two separate albums,
    // and neither of them is wrong from the database's point of view.
    const email = uniqueEmail('dupecase');

    const lower = await register(email);
    const upper = await register(email.toUpperCase());

    expect(lower.status).toBe(201);
    expect(upper.status).toBe(409);
  }, 30_000);
});

/**
 * The account after its album is gone.
 *
 * `DELETE /api/events/:id` shipped as the GDPR erasure path, and it made a
 * state reachable that previously was not: a signed-in host with no event at
 * all. Both of the endpoints the dashboard calls on load have to survive it,
 * and they answer differently on purpose — `GET /me` reports the absence,
 * while signing in again provisions a fresh album rather than leaving the host
 * staring at an empty app with no way forward.
 */
describe('a host whose album has been deleted', () => {
  async function deleteTheirEvent(userId: string): Promise<void> {
    await query('DELETE FROM events WHERE host_user_id = $1', [userId]);
  }

  it('is still described by /me, with no event rather than an error', async () => {
    const email = uniqueEmail('noevent');
    const { body } = await register(email);
    const token = body.token as string;
    await deleteTheirEvent((body.user as { id: string }).id);

    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.event).toBeNull();
    expect(me.user.email).toBe(email);
  }, 30_000);

  it('gets a fresh album when they sign in again', async () => {
    // Otherwise deleting an album is a one-way door out of the product.
    const email = uniqueEmail('relogin');
    const { body } = await register(email);
    await deleteTheirEvent((body.user as { id: string }).id);

    const res = await login(email);

    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session.event).toBeTruthy();
    expect(session.event.id).not.toBe((body.event as { id: string }).id);
    createdEvents.push(session.event.id);
  }, 30_000);

  it('gives that fresh album a real retention deadline', async () => {
    // An event created outside the registration path once left expires_at
    // NULL, which means indefinite — the album would never have been swept.
    const email = uniqueEmail('relogin-expiry');
    const { body } = await register(email);
    await deleteTheirEvent((body.user as { id: string }).id);

    const session = await (await login(email)).json();
    createdEvents.push(session.event.id);

    const { rows } = await query<{ expires_at: string | null }>(
      'SELECT expires_at FROM events WHERE id = $1',
      [session.event.id]
    );
    expect(rows[0].expires_at).not.toBeNull();
  }, 30_000);
});

describe('GET /api/auth/me', () => {
  it('reports the album with the plan resolved from the subscription', async () => {
    // Not from events.plan_tier, which is denormalised and writable — the
    // dashboard gates its own tabs on this value.
    const { body } = await register(uniqueEmail('me-tier'));
    const token = body.token as string;
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      (body.user as { id: string }).id,
    ]);
    await query("UPDATE events SET plan_tier = 'free' WHERE id = $1", [
      (body.event as { id: string }).id,
    ]);

    const me = await (
      await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();

    expect(me.event.planTier).toBe('deluxe_keepsake');
  }, 30_000);

  it('never includes the password hash', async () => {
    const { body } = await register(uniqueEmail('me-safe'));
    const token = body.token as string;

    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const text = await res.text();
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('$2b$');
  }, 30_000);

  it('refuses a caller with no session', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/me`);
    expect(res.status).toBe(401);
  });
});
