import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';

/**
 * Regression for OPEN_ITEMS.md DB-05 — display/thumbnail/original copies are
 * saved to storage (disk or R2) BEFORE the locked, final quota re-check
 * runs. If that re-check rejects the upload, the files written moments
 * earlier were never cleaned up — permanently orphaned, billed forever on
 * R2, with no DB row ever pointing at them.
 */

const TEST_PORT = 6615;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ eventId: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Orphan Cleanup Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { eventId: data.event.id, userId: data.user.id };
}

describe('Quota-rejected uploads clean up already-saved files (DB-05)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/photos', photosRouter);
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

  it('deletes the display/thumbnail files it just wrote when the locked recheck rejects the upload', async () => {
    // Free tier's cheap pre-check only rejects an ALREADY-over-limit event
    // (0 incoming bytes); the locked recheck is what actually accounts for
    // this upload's size. Leaving just 1KB of headroom guarantees any real
    // encoded JPEG (display + thumbnail derivatives, easily tens of KB)
    // passes the pre-check but fails the recheck, after the files exist.
    const FREE_LIMIT = 0.5 * 1024 * 1024 * 1024;
    await query('UPDATE events SET storage_bytes = $1 WHERE id = $2', [FREE_LIMIT - 1024, eventId]);

    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const deleteSpy = vi.spyOn(storageAdapter, 'delete');

    const res = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestName: 'Orphan Spec Guest',
        fullUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        deviceFingerprint: `orphan-fp-${Date.now()}`,
      }),
    });

    expect(res.status).toBe(403);
    // Both the display copy and its derived thumbnail were saved before the
    // rejection - both must be cleaned up, not just one.
    expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const photoRows = await query('SELECT COUNT(*)::int AS c FROM photos WHERE event_id = $1', [eventId]);
    expect(photoRows.rows[0].c).toBe(0);

    await query('UPDATE events SET storage_bytes = 0 WHERE id = $1', [eventId]);
  });
});
