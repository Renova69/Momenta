import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-110 — after signing in, the host studio showed the demo wedding's data.
 *
 * Part of it was the client merging the sign-in answer's raw row over a cached
 * album. The rest was here: the studio reads its album by address, and the
 * address lookup returned only the public columns, so every setting came back
 * missing and the studio drew moderation, the public showcase and disposable
 * mode as off while they were on — telling a host their album was private
 * while it was on the landing page.
 *
 * The lookup now answers with the projection the room broadcast already sends
 * every guest, and the owner, signed in, gets their album in full.
 */

const TEST_PORT = 6675;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
  slug: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `byslug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Slug Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id, slug: data.event.slug };
}

function bySlug(slug: string, token?: string) {
  return fetch(`${BASE_URL}/api/events/slug/${slug}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('reading an album by its address (N-110)', () => {
  it('carries the album’s settings, as the room broadcast does', async () => {
    const host = await registerHost();
    await query(
      `UPDATE events SET is_moderation_enabled = true, is_public = true, is_disposable_mode = true,
              reveal_at = '2027-06-13T06:00:00Z', max_photos_per_guest = 30 WHERE id = $1`,
      [host.eventId]
    );

    const album = await (await bySlug(host.slug)).json();

    expect(album.is_moderation_enabled).toBe(true);
    expect(album.is_public).toBe(true);
    expect(album.is_disposable_mode).toBe(true);
    expect(new Date(album.reveal_at).toISOString()).toBe('2027-06-13T06:00:00.000Z');
    expect(album.max_photos_per_guest).toBe(30);
  });

  it('keeps the host’s own details from everyone else', async () => {
    const host = await registerHost();
    const other = await registerHost();

    const anonymous = await (await bySlug(host.slug)).json();
    const stranger = await (await bySlug(host.slug, other.token)).json();

    for (const album of [anonymous, stranger]) {
      expect(album.host_email).toBeUndefined();
      expect(album.host_user_id).toBeUndefined();
    }
  });

  it('gives the signed-in owner their album in full', async () => {
    const host = await registerHost();

    const album = await (await bySlug(host.slug, host.token)).json();

    expect(album.host_user_id).toBe(host.userId);
    expect(album.host_email).toMatch(/@test\.com$/);
    expect(album.planTier).toBe('free');
  });
});
