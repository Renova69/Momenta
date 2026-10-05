import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { ingestPhoto } from '../../server/lib/ingestPipeline';
import { limitsFor } from '../../server/lib/planLimits';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-52 — Pro Planner pools its storage across all of a host's albums, but the
 * final check before an upload is written ran under a lock keyed on the album
 * alone (SEC-D1). Two uploads to two different albums of one host took two
 * different locks, read the same pooled total, and both passed — however close
 * to the cap that total already was.
 */

let userId = '';
const events: string[] = [];

async function newEvent(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO events (title, slug, host_name, host_email, host_user_id, event_date, venue_name, welcome_message)
     VALUES ('Pooled Spec', $1, 'Host', 'pooled@test.com', $2, NOW(), 'Venue', 'Welcome') RETURNING id`,
    [`pooled-spec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, userId]
  );
  events.push(rows[0].id);
  return rows[0].id;
}

function frame(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: seed, g: 100, b: 140 } } })
    .jpeg()
    .toBuffer();
}

async function pooledBytes(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT COALESCE(SUM(storage_bytes), 0)::bigint AS n FROM events WHERE host_user_id = $1',
    [userId]
  );
  return Number(rows[0].n);
}

beforeAll(async () => {
  const user = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role)
     VALUES ($1, 'Pooled Spec Host', 'x', 'planner') RETURNING id`,
    [`pooled-spec-${Date.now()}@test.com`]
  );
  userId = user.rows[0].id;
  await query(
    `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit)
     VALUES ($1, 'pro_planner', 'active', 'monthly', 4900, 'EUR', 10)`,
    [userId]
  );
});

afterAll(async () => {
  await deleteEventFixtures(events);
  await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
});

describe('the pooled storage cap under concurrent uploads (N-52)', () => {
  it('lets only as many through as fit, across different albums of one host', async () => {
    const first = await newEvent();
    const second = await newEvent();
    const filler = await newEvent();

    // How much one frame costs once stored (display, thumbnail, original).
    const before = await pooledBytes();
    const probe = await ingestPhoto(filler, await frame(1), 'probe.jpg', 'image/jpeg', { baseUrl: '' });
    expect(probe.ok).toBe(true);
    const oneFrame = (await pooledBytes()) - before;
    expect(oneFrame).toBeGreaterThan(0);

    // Leave room for one more frame and a half, so exactly one of two fits.
    const room = Math.floor(oneFrame * 1.5);
    const fill = limitsFor('pro_planner').storageBytes - (await pooledBytes()) - room;
    await query('UPDATE events SET storage_bytes = storage_bytes + $2 WHERE id = $1', [filler, fill]);

    const [a, b] = await Promise.all([
      ingestPhoto(first, await frame(2), 'a.jpg', 'image/jpeg', { baseUrl: '' }),
      ingestPhoto(second, await frame(3), 'b.jpg', 'image/jpeg', { baseUrl: '' }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await pooledBytes()).toBeLessThanOrEqual(limitsFor('pro_planner').storageBytes);
  }, 30_000);
});
