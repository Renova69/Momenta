import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { promoteEligiblePhotos } from '../../server/lib/photoQuarantine';
import { storageAdapter } from '../../server/lib/storage';
import { pool, query } from '../../server/lib/db';
import { CONFIG } from '../../server/lib/config';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-106 — the reveal promotion runs every photo's move on one shared
 * connection, each under a session-level advisory lock. An unlock that
 * failed there was swallowed and the connection went back to the pool still
 * holding the lock, so every later approve or delete of that photo waited
 * for it for ever. A connection whose locks cannot be given back is now
 * closed rather than returned.
 */

const createdEvents: string[] = [];
const patched: { client: PoolClient; query: PoolClient['query'] }[] = [];

afterEach(() => {
  for (const { client, query: original } of patched.splice(0)) client.query = original;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

async function albumAwaitingReveal(): Promise<{ eventId: string; photoId: string }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date)
     VALUES ($1, 'Unlock Spec', 'Spec Host', 'unlock@test.local', CURRENT_DATE) RETURNING id`,
    [`unlock-${tag}`]
  );
  const eventId = event.rows[0].id;
  createdEvents.push(eventId);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    eventId,
  ]);
  const saved = await storageAdapter.save(Buffer.from('p'), `p-${tag}.jpg`, 'image/jpeg', eventId, { quarantine: true });
  const photo = await query<{ id: string }>(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, is_quarantined, storage_bytes)
     VALUES ($1, $2, $3, $3, 'approved', true, 0) RETURNING id`,
    [eventId, guest.rows[0].id, saved.storagePath]
  );
  return { eventId, photoId: photo.rows[0].id };
}

/** Whether another session could take the photo's move lock right now. */
async function moveLockIsFree(photoId: string): Promise<boolean> {
  const other = new pg.Client({ connectionString: CONFIG.DATABASE_URL });
  await other.connect();
  try {
    const key = `photo_move_${photoId}`;
    const { rows } = await other.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [
      key,
    ]);
    if (rows[0].ok) await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    return rows[0].ok;
  } finally {
    await other.end();
  }
}

describe('the reveal promotion when an unlock fails (N-106)', () => {
  it('does not hand a connection still holding a photo lock back to the pool', async () => {
    const { eventId, photoId } = await albumAwaitingReveal();
    const realConnect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
    vi.spyOn(pool, 'connect').mockImplementation(((...args: unknown[]) => {
      // pool.query borrows its connection through the callback form; leave it alone.
      if (typeof args[0] === 'function') return realConnect(...args);
      return (async () => {
        const client = await realConnect();
        const original = client.query;
        patched.push({ client, query: original });
        client.query = ((...queryArgs: unknown[]) =>
          String(queryArgs[0]).includes('pg_advisory_unlock')
            ? Promise.reject(new Error('connection reset'))
            : (original as (...a: unknown[]) => unknown).apply(client, queryArgs)) as PoolClient['query'];
        return client;
      })();
    }) as typeof pool.connect);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await promoteEligiblePhotos(eventId, false);
    vi.restoreAllMocks();

    expect(await moveLockIsFree(photoId)).toBe(true);
  });
});
