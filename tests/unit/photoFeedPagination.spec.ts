import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';

/**
 * Regression for OPEN_ITEMS.md DB-03 — the photo feed orders by
 * `priority DESC, created_at DESC` (photographer-sourced frames get
 * priority=10 so they lead the projector rotation), but the keyset cursor
 * only compared `created_at < $cursor`. Once a page boundary landed right
 * after a high-priority-but-not-newest photo, every guest photo newer than
 * that photo's own created_at silently failed the cursor filter and was
 * skipped — permanently hidden from pagination, not just reordered.
 */

const TEST_PORT = 6614;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ eventId: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `pagination-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Pagination Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { eventId: data.event.id, userId: data.user.id };
}

describe('Photo feed keyset pagination respects priority, not just created_at (DB-03)', () => {
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

    const guestRes = await query(
      `INSERT INTO guests (event_id, name) VALUES ($1, 'Pagination Guest') RETURNING id`,
      [eventId]
    );
    const guestId = guestRes.rows[0].id;

    // Three photos, deliberately out of created_at/priority alignment:
    //   photoOld     priority=0,  created_at = T1 (oldest)
    //   photoPro     priority=10, created_at = T2 (middle) - the photographer frame
    //   photoNew     priority=0,  created_at = T3 (newest)
    // Correct feed order (priority DESC, created_at DESC): photoPro, photoNew, photoOld.
    const base = Date.now();
    const t1 = new Date(base - 3000).toISOString();
    const t2 = new Date(base - 2000).toISOString();
    const t3 = new Date(base - 1000).toISOString();

    await query(
      `INSERT INTO photos (id, event_id, guest_id, storage_path, full_url, status, priority, created_at)
       VALUES
         ('00000000-0000-0000-0000-0000000000a1', $1, $2, '/uploads/events/x/old.jpg', '/uploads/events/x/old.jpg', 'approved', 0, $3),
         ('00000000-0000-0000-0000-0000000000a2', $1, $2, '/uploads/events/x/pro.jpg', '/uploads/events/x/pro.jpg', 'approved', 10, $4),
         ('00000000-0000-0000-0000-0000000000a3', $1, $2, '/uploads/events/x/new.jpg', '/uploads/events/x/new.jpg', 'approved', 0, $5)`,
      [eventId, guestId, t1, t2, t3]
    );
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  it('does not skip a newer guest photo when paginating past a higher-priority older one', async () => {
    const page1Res = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}&limit=1`);
    const page1 = await page1Res.json();
    expect(page1.length).toBe(1);
    expect(page1[0].id).toBe('00000000-0000-0000-0000-0000000000a2'); // photoPro, highest priority

    const cursor = `${page1[0].priority}:${page1[0].createdAt}`;
    const page2Res = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}&limit=10&cursor=${encodeURIComponent(cursor)}`);
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    const page2Ids = page2.map((p: { id: string }) => p.id);

    // The bug: photoNew (created after photoPro) would fail a created_at-only
    // cursor filter and be silently missing here.
    expect(page2Ids).toContain('00000000-0000-0000-0000-0000000000a3');
    expect(page2Ids).toContain('00000000-0000-0000-0000-0000000000a1');
    expect(page2Ids.indexOf('00000000-0000-0000-0000-0000000000a3')).toBeLessThan(
      page2Ids.indexOf('00000000-0000-0000-0000-0000000000a1')
    );
  });

  it('rejects a malformed cursor instead of silently ignoring it', async () => {
    const res = await fetch(`${BASE_URL}/api/photos?eventId=${eventId}&cursor=not-a-real-cursor`);
    expect(res.status).toBe(400);
  });
});
