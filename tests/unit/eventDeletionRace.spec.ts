import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

/**
 * N-47 — deleting an album takes a snapshot of its media, deletes the files
 * one by one, then deletes the rows. Nothing stopped uploads, FTP ingests or
 * reveal promotions in between, so a photo that arrived mid-purge lost its row
 * but kept its file: publicly reachable on R2, and left under the served
 * /uploads locally. The album is now marked as being deleted, under its upload
 * lock, before the snapshot is taken, and everything that writes media for it
 * checks that mark.
 *
 * The purge is wrapped rather than replaced, so the route runs for real and
 * the test can see what the database said at the moment the purge began.
 */
const purgeHook = vi.hoisted(() => ({
  seenDeletingAt: undefined as string | null | undefined,
  failNext: false,
}));

vi.mock('../../server/lib/retention', async () => {
  const actual = await vi.importActual<typeof import('../../server/lib/retention')>('../../server/lib/retention');
  const { query } = await vi.importActual<typeof import('../../server/lib/db')>('../../server/lib/db');
  return {
    ...actual,
    purgeEventMedia: async (eventId: string) => {
      const row = await query<{ deleting_at: string | null }>('SELECT deleting_at FROM events WHERE id = $1', [eventId]);
      purgeHook.seenDeletingAt = row.rows[0]?.deleting_at ?? null;
      if (purgeHook.failNext) {
        purgeHook.failNext = false;
        throw new Error('storage unavailable');
      }
      return actual.purgeEventMedia(eventId);
    },
  };
});

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { ingestPhoto } from '../../server/lib/ingestPipeline';
import { promoteEligiblePhotos } from '../../server/lib/photoQuarantine';
import { query } from '../../server/lib/db';
import { deleteEventFixture } from '../helpers/cleanup';

const TEST_PORT = 6662;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const created: string[] = [];

async function registerHost(): Promise<{ token: string; eventId: string; slug: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `deletion-race-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Deletion Race Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  created.push(data.event.id);
  return { token: data.token, eventId: data.event.id, slug: data.event.slug };
}

function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 90, b: 60 } } })
    .jpeg()
    .toBuffer();
}

function deleteAlbum(host: { token: string; eventId: string; slug: string }): Promise<Response> {
  return fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ confirmSlug: host.slug }),
  });
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  for (const id of created) await deleteEventFixture(id);
  if (server) server.close();
});

describe('an album being deleted (N-47)', () => {
  it('is marked before its media is purged', async () => {
    const host = await registerHost();
    purgeHook.seenDeletingAt = undefined;

    const res = await deleteAlbum(host);

    expect(res.status).toBe(200);
    expect(purgeHook.seenDeletingAt).not.toBeNull();
    expect(purgeHook.seenDeletingAt).toBeDefined();
  });

  it('accepts no new photo once marked', async () => {
    const host = await registerHost();
    await query('UPDATE events SET deleting_at = NOW() WHERE id = $1', [host.eventId]);

    const outcome = await ingestPhoto(host.eventId, await jpeg(), 'late.jpg', 'image/jpeg', { baseUrl: '' });

    expect(outcome.ok).toBe(false);
    const photos = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1', [
      host.eventId,
    ]);
    expect(photos.rows[0].n).toBe(0);
  });

  it('does not promote a waiting photo out of quarantine once marked', async () => {
    const host = await registerHost();
    await query('UPDATE events SET is_moderation_enabled = true WHERE id = $1', [host.eventId]);
    const ingested = await ingestPhoto(host.eventId, await jpeg(), 'held.jpg', 'image/jpeg', { baseUrl: '' });
    expect(ingested.ok).toBe(true);
    const photoId = ingested.ok ? ingested.photo.id : '';
    await query("UPDATE photos SET status = 'approved' WHERE id = $1", [photoId]);
    await query('UPDATE events SET deleting_at = NOW() WHERE id = $1', [host.eventId]);

    await promoteEligiblePhotos(host.eventId, false);

    const row = await query<{ is_quarantined: boolean }>('SELECT is_quarantined FROM photos WHERE id = $1', [photoId]);
    expect(row.rows[0].is_quarantined).toBe(true);
  });

  it('takes uploads again if the purge fails and the album is still there', async () => {
    const host = await registerHost();
    purgeHook.failNext = true;

    const res = await deleteAlbum(host);

    expect(res.status).toBe(500);
    const row = await query<{ deleting_at: string | null }>('SELECT deleting_at FROM events WHERE id = $1', [
      host.eventId,
    ]);
    expect(row.rows[0].deleting_at).toBeNull();
  });
});
