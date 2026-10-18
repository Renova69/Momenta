import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * N-166 — the demo couple's account was anyone's.
 *
 * The sign-in page offers "1-Клик Демо", and the demo password ships in the
 * client bundle, so every visitor is the demo host. `users.is_demo` existed
 * but only the showcase read it: a visitor could change the demo password
 * (signing every other visitor out and breaking the button), delete the
 * account and its album, or rewrite the album every later prospect sees.
 * Signing out bumped `token_version` too, so one visitor leaving ended every
 * other visitor's session.
 *
 * The owner's rule (2026-10-18): the demo is view-only. Every host request
 * that would change something is refused with DEMO_READ_ONLY, decided once in
 * requireAuth so a route added later is covered without remembering to.
 */

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { ingestRouter } from '../../server/routes/ingest';
import { subscriptionsRouter } from '../../server/routes/subscriptions';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

const TEST_PORT = 6686;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const PASSWORD = 'Password123!';
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
  email: string;
}

const send = (method: string, url: string, token: string | null, body?: unknown) =>
  fetch(`${BASE_URL}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function registerHost(label: string): Promise<Host> {
  const email = `demo-ro-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await send('POST', '/api/auth/register', null, { email, fullName: 'Demo Spec Host', password: PASSWORD });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id, email };
}

/** A host marked as the demo account, signed in afresh as a visitor would be. */
async function demoHost(): Promise<Host & { loginBody: Record<string, unknown> }> {
  const host = await registerHost('demo');
  await query('UPDATE users SET is_demo = TRUE WHERE id = $1', [host.userId]);
  const res = await send('POST', '/api/auth/login', null, { email: host.email, password: PASSWORD });
  const loginBody = await res.json();
  return { ...host, token: loginBody.token, loginBody };
}

const refused = async (res: Response) => {
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe('DEMO_READ_ONLY');
};

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/ingest', ingestRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('the demo account is view-only (N-166)', () => {
  it('tells the client it is the demo, at sign-in and on /me', async () => {
    const host = await demoHost();
    expect((host.loginBody.user as { isDemo?: boolean }).isDemo).toBe(true);

    const me = await (await send('GET', '/api/auth/me', host.token)).json();
    expect(me.user.isDemo).toBe(true);
  });

  it('refuses a password change and an account deletion', async () => {
    const host = await demoHost();

    await refused(await send('POST', '/api/auth/password', host.token, { currentPassword: PASSWORD, newPassword: 'Changed-456!' }));
    await refused(await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD }));
    await refused(await send('PUT', '/api/auth/me', host.token, { fullName: 'Vandal' }));

    // Still the published password, still an account.
    expect((await send('POST', '/api/auth/login', null, { email: host.email, password: PASSWORD })).status).toBe(200);
  });

  it('refuses edits to the album, its cover, a new album, keys and plans', async () => {
    const host = await demoHost();
    const before = await query<{ title: string }>('SELECT title FROM events WHERE id = $1', [host.eventId]);

    await refused(await send('PUT', `/api/events/${host.eventId}`, host.token, { title: 'Defaced' }));
    await refused(await send('POST', `/api/events/${host.eventId}/cover`, host.token, { image: 'data:image/png;base64,AAAA' }));
    await refused(await send('DELETE', `/api/events/${host.eventId}`, host.token, { confirmSlug: 'x' }));
    await refused(await send('POST', '/api/events', host.token, { title: 'Another' }));
    await refused(await send('POST', '/api/ingest/keys', host.token, { eventId: host.eventId, label: 'x' }));
    await refused(await send('POST', '/api/subscriptions/upgrade', host.token, { tier: 'pro_planner' }));

    const after = await query<{ title: string }>('SELECT title FROM events WHERE id = $1', [host.eventId]);
    expect(after.rows[0].title).toBe(before.rows[0].title);
  });

  it('still lets the visitor look', async () => {
    const host = await demoHost();
    expect((await send('GET', '/api/events', host.token)).status).toBe(200);
    expect((await send('GET', `/api/events/${host.eventId}`, host.token)).status).toBe(200);
  });

  it("signs one visitor out without signing out the others", async () => {
    const first = await demoHost();
    const second = await send('POST', '/api/auth/login', null, { email: first.email, password: PASSWORD });
    const secondToken = (await second.json()).token as string;

    expect((await send('POST', '/api/auth/logout', first.token)).status).toBe(204);

    expect((await send('GET', '/api/auth/me', secondToken)).status).toBe(200);
  });

  it('leaves an ordinary host free to edit', async () => {
    const host = await registerHost('plain');
    const res = await send('PUT', `/api/events/${host.eventId}`, host.token, { title: 'Our wedding' });
    expect(res.status).toBe(200);

    const me = await (await send('GET', '/api/auth/me', host.token)).json();
    expect(me.user.isDemo).toBe(false);
  });
});
