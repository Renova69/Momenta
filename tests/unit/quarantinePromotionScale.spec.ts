import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { promoteEligiblePhotos } from '../../server/lib/photoQuarantine';
import { storageAdapter } from '../../server/lib/storage';
import { pool, query } from '../../server/lib/db';

/**
 * H4 — the disposable-reveal stampede.
 *
 * A reveal is a passive deadline: `reveal_at` simply passes, and nothing
 * fires. So promotion happens lazily on the read path, in GET /api/photos.
 * That is the right trigger, but the implementation made it dangerous at
 * exactly the moment it matters most:
 *
 *   1. Eligibility was `storage_path LIKE '%quarantine%' OR ...` across three
 *      columns. A leading wildcard cannot use an index, so every feed load by
 *      every guest sequentially scanned `photos` — not just at a reveal, but
 *      permanently, for every event.
 *
 *   2. When rows did match, `Promise.all(rows.map(promote))` fired unbounded.
 *      Each promotion is a SELECT, up to three storage copy/delete round
 *      trips, and an UPDATE.
 *
 * At the reveal every guest refreshes at once, so every one of those requests
 * tries to promote the same few hundred photos simultaneously. The pool is 40
 * connections. It empties, and every HTTP endpoint times out along with it —
 * during the first dance.
 *
 * Migration 021 adds an indexed `photos.is_quarantined` flag. Promotion is
 * serialized per event with an advisory lock and runs at bounded concurrency,
 * so a thundering herd collapses into one bounded pass.
 */

const TEST_PORT = 6633;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

async function registerHost(): Promise<{ token: string; userId: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `qscale-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Quarantine Scale Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function enableModeration(eventId: string, token: string): Promise<void> {
  // Moderation is the celebration_pass tier gate; grant it directly so this
  // spec is about promotion, not billing.
  await query(
    `UPDATE subscriptions SET tier = 'celebration_pass', event_limit = 1
      WHERE user_id = (SELECT host_user_id FROM events WHERE id = $1) AND status = 'active'`,
    [eventId]
  );
  const res = await fetch(`${BASE_URL}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ isModerationEnabled: true }),
  });
  expect(res.status).toBe(200);
}

async function uploadPhoto(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Scale Guest',
      deviceFingerprint: `qs-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  const body = await res.json();
  expect(res.status).toBe(201);
  return body.id as string;
}

/** Record every SQL string issued on the pool, promise- and callback-style alike. */
function captureSql(): { statements: string[]; restore: () => void } {
  const statements: string[] = [];
  const realQuery = pool.query.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (typeof text === 'string') statements.push(text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realQuery as any)(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  return { statements, restore: () => spy.mockRestore() };
}

describe('quarantine promotion does not stampede (H4)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 120, g: 160, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks a quarantined photo with the indexed flag at insert', async () => {
    const host = await registerHost();
    await enableModeration(host.eventId, host.token);
    const photoId = await uploadPhoto(host.eventId);

    const row = await query<{ is_quarantined: boolean; status: string }>(
      'SELECT is_quarantined, status FROM photos WHERE id = $1',
      [photoId]
    );
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].is_quarantined).toBe(true);
  });

  it('selects eligible photos by the indexed flag, never a leading-wildcard LIKE', async () => {
    const host = await registerHost();
    const { statements, restore } = captureSql();

    await promoteEligiblePhotos(host.eventId, false);
    restore();

    const wildcard = statements.filter((sql) => /LIKE\s+'%quarantine/i.test(sql));
    expect(wildcard).toEqual([]);
    expect(statements.some((sql) => /is_quarantined/i.test(sql))).toBe(true);
  });

  it('clears the flag once a photo is promoted', async () => {
    const host = await registerHost();
    await enableModeration(host.eventId, host.token);
    const photoId = await uploadPhoto(host.eventId);

    const approve = await fetch(`${BASE_URL}/api/photos/${photoId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(approve.status).toBe(200);

    const row = await query<{ is_quarantined: boolean; storage_path: string }>(
      'SELECT is_quarantined, storage_path FROM photos WHERE id = $1',
      [photoId]
    );
    expect(row.rows[0].is_quarantined).toBe(false);
    expect(row.rows[0].storage_path).not.toContain('quarantine');
  });

  it('bounds how many promotions run at once', async () => {
    const host = await registerHost();
    await enableModeration(host.eventId, host.token);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await uploadPhoto(host.eventId));

    // Approve them in the database directly so they become eligible together,
    // exactly as a reveal deadline passing would make a whole album eligible.
    await query("UPDATE photos SET status = 'approved' WHERE id = ANY($1::uuid[])", [ids]);

    let inFlight = 0;
    let peak = 0;
    const real = storageAdapter.promoteFromQuarantine.bind(storageAdapter);
    vi.spyOn(storageAdapter, 'promoteFromQuarantine').mockImplementation(async (storagePath: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return await real(storagePath);
      } finally {
        inFlight -= 1;
      }
    });

    await promoteEligiblePhotos(host.eventId, false);

    // 8 photos x 3 derivatives = 24 objects. Unbounded, every one of them
    // would be open at once.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(12);
  });

  it('does not promote the same photo twice under concurrent feed loads', async () => {
    const host = await registerHost();
    await enableModeration(host.eventId, host.token);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await uploadPhoto(host.eventId));
    await query("UPDATE photos SET status = 'approved' WHERE id = ANY($1::uuid[])", [ids]);

    const promoteSpy = vi.spyOn(storageAdapter, 'promoteFromQuarantine');

    // Six guests refreshing the feed the instant the reveal lands.
    await Promise.all(Array.from({ length: 6 }, () => promoteEligiblePhotos(host.eventId, false)));

    const promotedPaths = promoteSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((path) => path.includes('quarantine'));

    // Each still-quarantined object is handled once across all six callers.
    expect(new Set(promotedPaths).size).toBe(promotedPaths.length);

    const remaining = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM photos WHERE event_id = $1 AND is_quarantined',
      [host.eventId]
    );
    expect(Number(remaining.rows[0].count)).toBe(0);
  });

  it('is cheap when nothing is quarantined', async () => {
    const host = await registerHost();
    const { statements, restore } = captureSql();

    await promoteEligiblePhotos(host.eventId, false);
    restore();

    // One indexed lookup, and nothing else: no per-photo SELECT, no UPDATE.
    expect(statements).toHaveLength(1);
  });
});
