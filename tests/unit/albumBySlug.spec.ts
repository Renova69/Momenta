import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { guestsRouter } from '../../server/routes/guests';
import { wsManager } from '../../server/ws/wsServer';
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
  app.use('/api/guests', guestsRouter);
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

/**
 * N-115 — "guests attending" counted the guests this device had stored, which
 * on a host's phone is none and on a guest's is themselves. The host's
 * dashboard showed 0 at an album the server knew 3 guests had joined.
 */
describe('how many guests have joined (N-115)', () => {
  function join(eventId: string, fingerprint: string) {
    return fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, name: 'Count Spec Guest', deviceFingerprint: fingerprint }),
    });
  }

  it('is counted on the server and carried with the album', async () => {
    const host = await registerHost();
    await join(host.eventId, `count-a-${Date.now()}`);
    await join(host.eventId, `count-b-${Date.now()}`);
    // The photographer's ingest identity is not a guest at the wedding.
    await query(
      `INSERT INTO guests (event_id, name, device_fingerprint) VALUES ($1, 'Studio', 'photographer')`,
      [host.eventId]
    );

    const album = await (await bySlug(host.slug)).json();

    expect(album.guest_count).toBe(2);
  });

  it('is announced to the room when a guest joins', async () => {
    const host = await registerHost();
    const broadcast = vi.spyOn(wsManager, 'broadcastToEvent');

    await join(host.eventId, `count-live-${Date.now()}`);

    const sent = broadcast.mock.calls.find(([eventId, type]) => eventId === host.eventId && type === 'EVENT_UPDATED');
    expect(sent?.[2]).toMatchObject({ id: host.eventId, guest_count: 1 });
    broadcast.mockRestore();
  });

  it('is not announced again when a guest only edits their name', async () => {
    const host = await registerHost();
    const fingerprint = `count-edit-${Date.now()}`;
    await join(host.eventId, fingerprint);
    const broadcast = vi.spyOn(wsManager, 'broadcastToEvent');

    await join(host.eventId, fingerprint);

    expect(broadcast.mock.calls.filter(([, type]) => type === 'EVENT_UPDATED')).toHaveLength(0);
    broadcast.mockRestore();
  });
});

describe("a new album's name (N-125)", () => {
  it('is in the language of the product, not "<name>’s Wedding"', async () => {
    const host = await registerHost();
    const album = await (await bySlug(host.slug, host.token)).json();
    expect(album.title).toBe('Сватбата на Slug Spec Host');
  });
});
