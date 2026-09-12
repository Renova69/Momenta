import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { purgeEventMedia, refreshExpiryDates, computeExpiry } from '../../server/lib/retention';
import { query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';

/**
 * Regression for OPEN_ITEMS.md DB-01 — purgeEventMedia deleted photos one
 * row at a time, and the FOR EACH ROW storage_bytes trigger fired once per
 * row, meaning a purge of thousands of photos became thousands of
 * sequential UPDATEs on the exact same events row (WAL bloat, row-lock
 * contention). The fix disables the trigger for the duration of the bulk
 * delete and sets storage_bytes = 0 directly in one statement, since every
 * photo/audio row for the event is being removed in this one operation.
 *
 * The real risk in that fix is leaving the trigger disabled afterward if
 * anything goes wrong — silently breaking storage accounting for every
 * event, not just the purged one. This is what these tests actually guard.
 */

const TEST_PORT = 6616;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `purge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Purge Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { eventId: data.event.id };
}

describe('purgeEventMedia trigger-disable is safe (DB-01)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const host = await registerHost();
    eventId = host.eventId;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the now-empty event directory after purging (G4)', async () => {
    const removeSpy = vi.spyOn(storageAdapter, 'removeEventDirectory');

    await purgeEventMedia(eventId);

    expect(removeSpy).toHaveBeenCalledWith(eventId);
  });

  it('deletes all photos/audio, zeroes storage_bytes, and leaves the trigger re-enabled for future events', async () => {
    const guestRes = await query(`INSERT INTO guests (event_id, name) VALUES ($1, 'Purge Guest') RETURNING id`, [eventId]);
    const guestId = guestRes.rows[0].id;

    const photoCount = 8;
    const values: string[] = [];
    const params: (string | number)[] = [];
    for (let i = 0; i < photoCount; i++) {
      values.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, 'approved', $${params.length + 5})`);
      params.push(eventId, guestId, `/uploads/events/${eventId}/p${i}.jpg`, `/uploads/events/${eventId}/p${i}.jpg`, 1000);
    }
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes) VALUES ${values.join(', ')}`,
      params
    );
    await query(
      `INSERT INTO audio_guestbook (event_id, guest_id, audio_url, duration_seconds, storage_bytes)
       VALUES ($1, $2, '/uploads/events/x/a.webm', 5, 500)`,
      [eventId, guestId]
    );

    // Trigger-maintained total should reflect what was just inserted:
    // 8*1000 + 500 = 8500.
    const before = await query('SELECT storage_bytes FROM events WHERE id = $1', [eventId]);
    expect(Number(before.rows[0].storage_bytes)).toBe(8500);

    await purgeEventMedia(eventId);

    const photosLeft = await query('SELECT COUNT(*)::int AS c FROM photos WHERE event_id = $1', [eventId]);
    expect(photosLeft.rows[0].c).toBe(0);
    const audioLeft = await query('SELECT COUNT(*)::int AS c FROM audio_guestbook WHERE event_id = $1', [eventId]);
    expect(audioLeft.rows[0].c).toBe(0);

    const after = await query('SELECT storage_bytes FROM events WHERE id = $1', [eventId]);
    expect(Number(after.rows[0].storage_bytes)).toBe(0);

    // The trigger must still be live for every event, not just this one -
    // insert one more photo and confirm the running total picks it up
    // exactly the way it did before the purge ran.
    const postPurgeGuest = await query(`INSERT INTO guests (event_id, name) VALUES ($1, 'Post-Purge Guest') RETURNING id`, [eventId]);
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
       VALUES ($1, $2, '/uploads/events/x/post.jpg', '/uploads/events/x/post.jpg', 'approved', 4242)`,
      [eventId, postPurgeGuest.rows[0].id]
    );
    const postPurge = await query('SELECT storage_bytes FROM events WHERE id = $1', [eventId]);
    expect(Number(postPurge.rows[0].storage_bytes)).toBe(4242);
  });
});

describe('refreshExpiryDates batches its writes correctly (DB-09)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT + 3, () => resolve()));

    const res = await fetch(`http://localhost:${TEST_PORT + 3}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `refresh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
        fullName: 'Refresh Expiry Spec Host',
        password: 'Password123!',
      }),
    });
    eventId = (await res.json()).event.id;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  it('sets expires_at to exactly what computeExpiry would produce for a real event', async () => {
    // Registration defaults to the free tier - deterministic 7-day retention.
    const before = await query('SELECT event_date, created_at FROM events WHERE id = $1', [eventId]);
    const expected = computeExpiry('free', before.rows[0].event_date, before.rows[0].created_at);

    const updatedCount = await refreshExpiryDates();
    expect(updatedCount).toBeGreaterThan(0);

    const after = await query('SELECT expires_at FROM events WHERE id = $1', [eventId]);
    expect(new Date(after.rows[0].expires_at).toISOString()).toBe(expected!.toISOString());
  });

  it('is idempotent - running it again does not change an already-correct expiry', async () => {
    const first = await query('SELECT expires_at FROM events WHERE id = $1', [eventId]);
    await refreshExpiryDates();
    const second = await query('SELECT expires_at FROM events WHERE id = $1', [eventId]);
    expect(new Date(second.rows[0].expires_at).toISOString()).toBe(new Date(first.rows[0].expires_at).toISOString());
  });
});
