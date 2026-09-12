import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { purgeEventMedia } from '../../server/lib/retention';
import { pool, query } from '../../server/lib/db';

/**
 * H5 — a retention purge must not lock the whole `photos` table.
 *
 * purgeEventMedia used to run:
 *
 *   ALTER TABLE photos DISABLE TRIGGER trg_photos_storage_bytes
 *
 * to skip the per-row storage_bytes accounting during a bulk delete. The
 * optimization is real — a purge of thousands of photos otherwise becomes
 * thousands of sequential UPDATEs against the same `events` row — but
 * ALTER TABLE takes an ACCESS EXCLUSIVE lock on the *entire table*, for every
 * event, for the duration of the transaction, and queues behind any in-flight
 * query. The nightly sweep loops over candidates, so a live wedding's uploads
 * and feed reads stall once per expired album.
 *
 * It also silently requires table ownership, so it fails outright under a
 * least-privilege application role.
 *
 * Migration 020 moves the skip into the trigger function itself, gated on a
 * transaction-local GUC. `SET LOCAL` needs no special privilege and takes no
 * table lock at all, so the accounting shortcut survives and the lock does not.
 */

const TEST_PORT = 6631;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `nolock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Purge Lock Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { eventId: data.event.id };
}

/**
 * Record every SQL string the purge transaction issues.
 *
 * Only the promise-style `pool.connect()` is intercepted. pg's own
 * `pool.query()` calls `pool.connect(callback)` internally, so a mock that
 * ignores that callback strands every pooled query — the SELECTs at the top of
 * purgeEventMedia simply never resolve. Callback-style calls are handed
 * straight through untouched.
 *
 * The patched `query` is also removed again on release, so a client going back
 * into the pool does not carry this instrumentation into later tests.
 */
function captureTransactionSql(): { statements: string[]; restore: () => void } {
  const statements: string[] = [];
  const realConnect = pool.connect.bind(pool);

  const spy = vi.spyOn(pool, 'connect').mockImplementation(((...args: unknown[]) => {
    if (args.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realConnect as any)(...args);
    }
    return realConnect().then((client) => {
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = (...queryArgs: any[]) => {
        const text = typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text;
        if (typeof text === 'string') statements.push(text);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realQuery as any)(...queryArgs);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).release = (...releaseArgs: any[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = realQuery;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).release = realRelease;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realRelease as any)(...releaseArgs);
      };
      return client;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);

  return { statements, restore: () => spy.mockRestore() };
}

async function seedPhoto(eventId: string, bytes: number): Promise<void> {
  const guest = await query<{ id: string }>(
    `INSERT INTO guests (event_id, name) VALUES ($1, 'Purge Guest') RETURNING id`,
    [eventId]
  );
  await query(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, thumbnail_url, status, storage_bytes)
     VALUES ($1, $2, $3, $3, $3, 'approved', $4)`,
    [eventId, guest.rows[0].id, `/uploads/events/${eventId}/purge-${Math.random().toString(36).slice(2)}.jpg`, bytes]
  );
}

describe('retention purge takes no table-wide lock (H5)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
    eventId = (await registerHost()).eventId;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues no ALTER TABLE, so no ACCESS EXCLUSIVE lock is ever taken', async () => {
    await seedPhoto(eventId, 1000);
    const { statements, restore } = captureTransactionSql();

    await purgeEventMedia(eventId);
    restore();

    const ddl = statements.filter((sql) => /\bALTER\s+TABLE\b/i.test(sql));
    expect(ddl).toEqual([]);
  });

  it('still skips the per-row accounting, via a transaction-local setting', async () => {
    await seedPhoto(eventId, 1000);
    const { statements, restore } = captureTransactionSql();

    await purgeEventMedia(eventId);
    restore();

    // SET LOCAL is transaction-scoped and needs no privilege; it dies with the
    // COMMIT/ROLLBACK exactly as the DISABLE/ENABLE pair was meant to.
    expect(statements.some((sql) => /SET\s+LOCAL\s+wedmoments\.bulk_purge/i.test(sql))).toBe(true);
  });

  it('leaves the event with zero photos and zero storage_bytes', async () => {
    await seedPhoto(eventId, 4096);
    await seedPhoto(eventId, 8192);

    await purgeEventMedia(eventId);

    const photos = await query<{ count: string }>('SELECT COUNT(*) AS count FROM photos WHERE event_id = $1', [eventId]);
    const event = await query<{ storage_bytes: string }>('SELECT storage_bytes FROM events WHERE id = $1', [eventId]);

    expect(Number(photos.rows[0].count)).toBe(0);
    expect(Number(event.rows[0].storage_bytes)).toBe(0);
  });

  it('keeps the trigger accounting for ordinary single-row deletes afterwards', async () => {
    // The real danger in the old approach was leaving the trigger disabled,
    // silently breaking storage accounting for every event. The GUC cannot
    // leak out of its transaction, but assert the outcome regardless.
    await purgeEventMedia(eventId);
    await seedPhoto(eventId, 5000);

    const afterInsert = await query<{ storage_bytes: string }>(
      'SELECT storage_bytes FROM events WHERE id = $1',
      [eventId]
    );
    expect(Number(afterInsert.rows[0].storage_bytes)).toBe(5000);

    await query('DELETE FROM photos WHERE event_id = $1', [eventId]);

    const afterDelete = await query<{ storage_bytes: string }>(
      'SELECT storage_bytes FROM events WHERE id = $1',
      [eventId]
    );
    expect(Number(afterDelete.rows[0].storage_bytes)).toBe(0);
  });
});
