import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { query } from '../../server/lib/db';
import { deleteEventFixture, deleteEventFixturesForHost } from '../helpers/cleanup';

/**
 * N-41 — signing in to an account with no album creates one, so the
 * dashboard has something to open. That path did a plain SELECT for the
 * host's latest album and, finding none, inserted one, with none of the
 * locking POST /api/events uses (DB-06). Concurrent logins all passed the
 * SELECT before any INSERT committed, and each created an album. A host can
 * reach zero albums on their own by deleting the last one, and every album
 * takes its tier from the host's subscription, so on a single-album paid plan
 * each duplicate was another paid album with its own allowance.
 */

const TEST_PORT = 6661;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const users: string[] = [];

const PASSWORD = 'Password123!';

async function registerHost(): Promise<{ userId: string; email: string; eventId: string }> {
  const email = `login-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Login Fallback Host', password: PASSWORD }),
  });
  const data = await res.json();
  users.push(data.user.id);
  return { userId: data.user.id, email, eventId: data.event.id };
}

function login(email: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

async function albumCount(userId: string): Promise<number> {
  const res = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events WHERE host_user_id = $1', [userId]);
  return res.rows[0].n;
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  for (const userId of users) {
    await deleteEventFixturesForHost(userId);
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
  }
  if (server) server.close();
});

describe('signing in to an account with no album (N-41)', () => {
  it('creates one album, not one per concurrent login', async () => {
    const host = await registerHost();
    await deleteEventFixture(host.eventId);
    expect(await albumCount(host.userId)).toBe(0);

    const responses = await Promise.all(Array.from({ length: 6 }, () => login(host.email)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(await albumCount(host.userId)).toBe(1);

    // And every one of them was handed that same album.
    const ids = await Promise.all(responses.map(async (r) => (await r.json()).event.id as string));
    expect(new Set(ids).size).toBe(1);
  });

  it('still creates the album for a single login', async () => {
    const host = await registerHost();
    await deleteEventFixture(host.eventId);

    const res = await login(host.email);

    expect(res.status).toBe(200);
    expect(await albumCount(host.userId)).toBe(1);
  });
});
