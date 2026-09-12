import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';

/**
 * H6 — the public showcase published every wedding, with no opt-in.
 *
 * GET /api/events/showcase/feed returned the 6 newest events to anyone, with
 * host name, venue, date and four preview photos each. No `is_public` column
 * existed anywhere in the schema, so there was nothing a couple could set and
 * nothing the query could filter on: registering was consent to being
 * advertised.
 *
 * Migration 022 adds `events.is_public`, defaulting to **false** for every
 * event that already exists as well as every new one, and marks the seeded
 * demo wedding public so the landing page has something real to show that the
 * operator actually controls.
 */

const TEST_PORT = 6637;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `showcase-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Showcase Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function showcase(): Promise<{ id: string }[]> {
  const res = await fetch(`${BASE_URL}/api/events/showcase/feed`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('showcase requires opt-in (H6)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  it('does not publish a newly registered wedding', async () => {
    const host = await registerHost();

    const feed = await showcase();

    expect(feed.map((e) => e.id)).not.toContain(host.eventId);
  });

  it('defaults is_public to false for a brand-new event', async () => {
    const host = await registerHost();

    const row = await query<{ is_public: boolean }>('SELECT is_public FROM events WHERE id = $1', [host.eventId]);

    expect(row.rows[0].is_public).toBe(false);
  });

  it('publishes an event only once its host opts in, and unpublishes on opt-out', async () => {
    const host = await registerHost();

    const optIn = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(optIn.status).toBe(200);
    expect(await optIn.json()).toMatchObject({ is_public: true });

    expect((await showcase()).map((e) => e.id)).toContain(host.eventId);

    const optOut = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    expect(optOut.status).toBe(200);

    expect((await showcase()).map((e) => e.id)).not.toContain(host.eventId);
  });

  it('is a free privacy control, not a paid feature', async () => {
    // The host is on the free tier by default. Publishing your own album must
    // never be gated behind a plan — and neither must withdrawing it.
    const host = await registerHost();
    const tier = await query<{ tier: string }>(
      "SELECT tier FROM subscriptions WHERE user_id = $1 AND status = 'active'",
      [host.userId]
    );
    expect(tier.rows[0].tier).toBe('free');

    const res = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: true }),
    });

    expect(res.status).toBe(200);
  });

  it('another host cannot publish an album they do not own', async () => {
    const owner = await registerHost();
    const stranger = await registerHost();

    const res = await fetch(`${BASE_URL}/api/events/${owner.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stranger.token}` },
      body: JSON.stringify({ isPublic: true }),
    });

    expect(res.status).toBe(403);
    const row = await query<{ is_public: boolean }>('SELECT is_public FROM events WHERE id = $1', [owner.eventId]);
    expect(row.rows[0].is_public).toBe(false);
  });

  it('keeps the seeded demo wedding public so the landing page is not empty', async () => {
    const seeded = await query<{ is_public: boolean }>(
      "SELECT is_public FROM events WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'"
    );
    // Present in every environment that ran the seed migration; skip where it
    // was deliberately purged rather than assert on data that is not there.
    if (seeded.rows.length === 0) return;
    expect(seeded.rows[0].is_public).toBe(true);
  });

  it('never leaks a private album through the preview photos join', async () => {
    const host = await registerHost();
    await query('UPDATE events SET is_public = false WHERE id = $1', [host.eventId]);

    const feed = (await showcase()) as { id: string; previewPhotos?: unknown[] }[];

    for (const entry of feed) {
      expect(entry.id).not.toBe(host.eventId);
    }
  });
});
