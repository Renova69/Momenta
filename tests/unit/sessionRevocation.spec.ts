import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';

/**
 * Server-side session revocation (migration 019).
 *
 * Logging out used to be client-side only — localStorage was cleared and the
 * JWT stayed valid for the rest of its JWT_EXPIRES_IN window (7 days). On a
 * shared laptop that meant "sign out" hid the session without ending it. These
 * specs pin the property that actually matters: a token captured BEFORE logout
 * must stop working AFTER it.
 */

const TEST_PORT = 6641;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdUsers: string[] = [];

async function registerHost() {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `revoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Revocation Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdUsers.push(data.user.id);
  return { token: data.token as string, userId: data.user.id as string, email: data.user.email as string };
}

/** Any route behind requireAuth will do; /api/auth/me is the cheapest. */
function callAuthed(token: string) {
  return fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
}

function logout(token: string) {
  return fetch(`${BASE_URL}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (createdUsers.length > 0) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(() => undefined);
  }
  if (server) server.close();
});

describe('POST /api/auth/logout', () => {
  it('kills a token that was captured before the logout', async () => {
    const { token } = await registerHost();
    expect((await callAuthed(token)).status).toBe(200);

    expect((await logout(token)).status).toBe(204);

    // The whole point: this is the SAME token string that worked a moment ago.
    const after = await callAuthed(token);
    expect(after.status).toBe(401);
    expect((await after.json()).code).toBe('SESSION_REVOKED');
  });

  it('kills every outstanding session, not just the one that asked', async () => {
    const { email } = await registerHost();

    // Two independent logins for one account — a phone and a laptop, say.
    const login = async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Password123!' }),
      });
      return (await res.json()).token as string;
    };
    const phone = await login();
    const laptop = await login();
    expect((await callAuthed(phone)).status).toBe(200);
    expect((await callAuthed(laptop)).status).toBe(200);

    await logout(laptop);

    // Signing out because someone else may have access has to reach the
    // session you are worried about, not only the one in front of you.
    expect((await callAuthed(phone)).status).toBe(401);
    expect((await callAuthed(laptop)).status).toBe(401);
  });

  it('lets the user sign back in afterwards', async () => {
    const { token, email } = await registerHost();
    await logout(token);

    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!' }),
    });
    expect(res.status).toBe(200);

    // The fresh token must be stamped with the NEW version, or login would
    // hand back a token the very next request rejects.
    const fresh = (await res.json()).token as string;
    expect((await callAuthed(fresh)).status).toBe(200);
  });

  it('rejects an unauthenticated logout', async () => {
    expect((await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST' })).status).toBe(401);
  });

  it('stops a revoked token being recognised on optionalAuth routes too', async () => {
    const { token } = await registerHost();
    await logout(token);

    // optionalAuth widens what a route returns for a recognised host, so a
    // revoked token must read as an anonymous guest rather than as the owner.
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});
