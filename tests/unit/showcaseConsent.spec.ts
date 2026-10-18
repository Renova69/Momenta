import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

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
    await deleteEventFixtures(createdEvents);
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

  // N-40 — the seeded demo wedding used to be kept public "so the landing page
  // is not empty". But its host is the demo login, whose password ships in the
  // client bundle, and the album takes unmoderated anonymous uploads: anyone
  // could put anything on the landing page. The page has static sample
  // weddings for an empty feed, so it is not empty without it.
  it('does not publish the seeded demo wedding', async () => {
    const seeded = await query<{ is_public: boolean }>(
      "SELECT is_public FROM events WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'"
    );
    // Present in every environment that ran the seed migration; skip where it
    // was deliberately purged rather than assert on data that is not there.
    if (seeded.rows.length === 0) return;
    expect(seeded.rows[0].is_public).toBe(false);
  });

  it('never shows an album a demo account owns, even after it opts in', async () => {
    // Unpublishing the seed is not enough on its own: anyone signed in with
    // the public demo login could switch the album back on. Since N-166 the
    // demo account is view-only and cannot; an album flagged public some
    // other way stays off the showcase all the same.
    const host = await registerHost();
    await query('UPDATE users SET is_demo = true WHERE id = $1', [host.userId]);

    const optIn = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(optIn.status).toBe(403);

    await query('UPDATE events SET is_public = true WHERE id = $1', [host.eventId]);
    expect((await showcase()).map((e) => e.id)).not.toContain(host.eventId);
  });

  it('marks exactly the two seeded demo logins as demo accounts', async () => {
    const demo = await query<{ email: string }>('SELECT email FROM users WHERE is_demo ORDER BY email');
    const seededDemo = demo.rows.map((r) => r.email).filter((e) => e.endsWith('@wedmoments.bg'));
    // Absent where the seed was purged; otherwise exactly these two.
    if (seededDemo.length === 0) return;
    expect(seededDemo).toEqual(['demo.couple@wedmoments.bg', 'demo.planner@wedmoments.bg']);
  });

  // N-36 — the preview query filtered on status alone. A disposable-mode
  // upload is stored `approved` with `is_locked`, so the showcase published
  // the newest locked photos of any public album before the reveal, with
  // captions and, on R2, working quarantine URLs. The guest feed has always
  // hidden them; the showcase was the half of SEC-07 nobody fixed.
  it('withholds disposable-locked photos until the reveal', async () => {
    const host = await registerHost();
    await query(
      `UPDATE events SET is_public = true, is_disposable_mode = true, reveal_at = NOW() + INTERVAL '1 day'
        WHERE id = $1`,
      [host.eventId]
    );
    const guest = await query<{ id: string }>(
      "INSERT INTO guests (event_id, name) VALUES ($1, 'Showcase Lock Guest') RETURNING id",
      [host.eventId]
    );
    // The locked photo is deliberately NOT in quarantine, so this tests the
    // lock on its own. That state is real: a host who switches disposable
    // mode off has its photos promoted, and switching it back on with a new
    // reveal time locks them again without moving them back.
    const photos = await query<{ id: string; is_locked: boolean }>(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, thumbnail_url, caption, status, is_locked, is_quarantined)
       VALUES ($1, $2, 'events/x/locked.jpg', '/uploads/locked.jpg', '/uploads/locked-t.jpg',
               'before the reveal', 'approved', true, false),
              ($1, $2, 'events/x/open.jpg', '/uploads/open.jpg', '/uploads/open-t.jpg',
               'taken before disposable mode', 'approved', false, false)
       RETURNING id, is_locked`,
      [host.eventId, guest.rows[0].id]
    );
    const lockedId = photos.rows.find((p) => p.is_locked)!.id;
    const openId = photos.rows.find((p) => !p.is_locked)!.id;

    const feed = (await showcase()) as { id: string; photos_count: number; previewPhotos: { id: string }[] }[];
    const entry = feed.find((e) => e.id === host.eventId);

    expect(entry).toBeDefined();
    expect(entry!.previewPhotos.map((p) => p.id)).toEqual([openId]);
    expect(entry!.previewPhotos.map((p) => p.id)).not.toContain(lockedId);
    expect(entry!.photos_count).toBe(1);

    // After the reveal the same photo is public.
    await query("UPDATE events SET reveal_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [host.eventId]);

    const revealed = ((await showcase()) as { id: string; previewPhotos: { id: string }[] }[]).find(
      (e) => e.id === host.eventId
    );
    expect(revealed!.previewPhotos.map((p) => p.id).sort()).toEqual([lockedId, openId].sort());
  });

  it('never shows a photo whose files are still in quarantine', async () => {
    // Revealed but not yet promoted: the row still points at quarantine, a
    // URL that stops working the moment promotion moves the file.
    const host = await registerHost();
    await query('UPDATE events SET is_public = true WHERE id = $1', [host.eventId]);
    const guest = await query<{ id: string }>(
      "INSERT INTO guests (event_id, name) VALUES ($1, 'Showcase Quarantine Guest') RETURNING id",
      [host.eventId]
    );
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, thumbnail_url, status, is_locked, is_quarantined)
       VALUES ($1, $2, 'quarantine/events/x/q.jpg', '/uploads/quarantine/q.jpg', '/uploads/quarantine/q-t.jpg',
               'approved', false, true)`,
      [host.eventId, guest.rows[0].id]
    );

    const entry = ((await showcase()) as { id: string; previewPhotos: unknown[] }[]).find(
      (e) => e.id === host.eventId
    );

    expect(entry!.previewPhotos).toEqual([]);
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
