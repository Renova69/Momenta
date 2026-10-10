import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import {
  sweepExpiredAlbums,
  purgeEventMedia,
  markEventDeleting,
  clearDeletionMark,
  GRACE_PERIOD_DAYS,
  RETENTION_NOTICE_DAYS,
} from '../../server/lib/retention';
import { getUploadContext } from '../../server/middleware/tierGate';
import { storageAdapter } from '../../server/lib/storage';
import { query, pool } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-73 — the album delete route marks an album as being deleted before it
 * purges (N-47), so an upload landing mid-purge is refused instead of losing
 * its row and keeping its file. The retention sweep purged without the mark.
 * And a mark is honoured for an hour only, so a purge longer than that lost
 * its protection part way through.
 *
 * N-74 — the sweep read its list of deletable albums once, then purged them
 * one by one. An album whose host paid to extend it while the sweep worked
 * through the albums before it was still purged.
 */

const createdEvents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

/** An album past its grace period, warned long enough ago to be deleted, holding one photo. */
async function deletableAlbum(daysPastGrace: number): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, expires_at, retention_notified_at)
     VALUES ($1, 'Sweep Spec', 'Spec Host', 'sweep@test.local', CURRENT_DATE,
             NOW() - make_interval(days => $2), NOW() - make_interval(days => $3))
     RETURNING id`,
    [`sweep-${tag}`, GRACE_PERIOD_DAYS + daysPastGrace, RETENTION_NOTICE_DAYS + 1]
  );
  const eventId = event.rows[0].id;
  createdEvents.push(eventId);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    eventId,
  ]);
  const saved = await storageAdapter.save(Buffer.from('photo'), `p-${tag}.jpg`, 'image/jpeg', eventId);
  await query(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
     VALUES ($1, $2, $3, $3, 'approved', 5)`,
    [eventId, guest.rows[0].id, saved.storagePath]
  );
  return eventId;
}

async function photoCount(eventId: string): Promise<number> {
  const { rows } = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1', [eventId]);
  return rows[0].n;
}

async function deletionMark(eventId: string): Promise<Date | null> {
  const { rows } = await query<{ deleting_at: Date | null }>('SELECT deleting_at FROM events WHERE id = $1', [
    eventId,
  ]);
  return rows[0].deleting_at;
}

/** Run `during` on the purge's first storage delete, then let the purge carry on. */
function onFirstDelete(during: () => Promise<void>): void {
  const real = storageAdapter.delete.bind(storageAdapter);
  let first = true;
  vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
    if (first) {
      first = false;
      await during();
    }
    return real(p);
  });
}

describe('the retention sweep and uploads arriving mid-purge (N-73)', () => {
  it('refuses an upload while it purges the album', async () => {
    const eventId = await deletableAlbum(5);
    let uploadContext: unknown = 'not checked';
    onFirstDelete(async () => {
      uploadContext = await getUploadContext(eventId, undefined);
    });

    const result = await sweepExpiredAlbums(true, { eventIds: [eventId] });

    expect(result.deleted).toEqual([eventId]);
    expect(uploadContext).toBeNull();
  });

  it('takes the mark off once the purge is done, as the album itself stays', async () => {
    const eventId = await deletableAlbum(5);

    await sweepExpiredAlbums(true, { eventIds: [eventId] });

    expect(await deletionMark(eventId)).toBeNull();
    expect(await photoCount(eventId)).toBe(0);
  });

  it('takes the mark off when the purge fails, so the album keeps taking uploads', async () => {
    const eventId = await deletableAlbum(5);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const purgeFails = vi.spyOn(storageAdapter, 'removeEventDirectory');
    // Fails after the rows are gone, which is the last step a purge takes.
    purgeFails.mockRejectedValue(new Error('disk gone'));

    await sweepExpiredAlbums(true, { eventIds: [eventId] });

    expect(await deletionMark(eventId)).toBeNull();
  });
});

describe('a purge that runs for longer than the mark is honoured (N-73)', () => {
  it('renews the mark as it goes', async () => {
    const eventId = await deletableAlbum(5);
    // A purge that began almost an hour ago and still has files to delete.
    const { rows: marked } = await query<{ token: string }>(
      "UPDATE events SET deleting_at = NOW() - INTERVAL '55 minutes' WHERE id = $1 RETURNING deleting_at::text AS token",
      [eventId]
    );
    const held = { eventId, token: marked[0].token };
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const real = storageAdapter.delete.bind(storageAdapter);
    vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
      clock += 10 * 60 * 1000; // each delete takes ten minutes
      return real(p);
    });
    const extra = await storageAdapter.save(Buffer.from('second'), `second-${start}.jpg`, 'image/jpeg', eventId);
    const { rows } = await query<{ guest_id: string }>('SELECT guest_id FROM photos WHERE event_id = $1 LIMIT 1', [
      eventId,
    ]);
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
       VALUES ($1, $2, $3, $3, 'approved', 6)`,
      [eventId, rows[0].guest_id, extra.storagePath]
    );

    await purgeEventMedia(eventId, held);

    const mark = await deletionMark(eventId);
    expect(mark).not.toBeNull();
    // Renewed against the database clock: well inside the hour again.
    const { rows: age } = await query<{ fresh: boolean }>(
      "SELECT deleting_at > NOW() - INTERVAL '5 minutes' AS fresh FROM events WHERE id = $1",
      [eventId]
    );
    expect(age[0].fresh).toBe(true);
  });

  it('does not put a mark on an album nobody is deleting', async () => {
    const eventId = await deletableAlbum(5);
    // A second file, so a renewal falls due between the two deletes.
    const extra = await storageAdapter.save(Buffer.from('second'), `unmarked-${Date.now()}.jpg`, 'image/jpeg', eventId);
    const { rows } = await query<{ guest_id: string }>('SELECT guest_id FROM photos WHERE event_id = $1 LIMIT 1', [
      eventId,
    ]);
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
       VALUES ($1, $2, $3, $3, 'approved', 6)`,
      [eventId, rows[0].guest_id, extra.storagePath]
    );
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const real = storageAdapter.delete.bind(storageAdapter);
    vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
      clock += 10 * 60 * 1000;
      return real(p);
    });

    await purgeEventMedia(eventId);

    expect(await deletionMark(eventId)).toBeNull();
  });
});

describe('an album extended while the sweep is working (N-74)', () => {
  it('is not purged on the strength of the list read before it was extended', async () => {
    const older = await deletableAlbum(9); // purged first: expires_at ascending
    const extended = await deletableAlbum(5);
    onFirstDelete(async () => {
      // The host buys more time while the sweep is on the album before.
      await query(
        `UPDATE events SET expires_at = NOW() + INTERVAL '1 year', retention_notified_at = NULL WHERE id = $1`,
        [extended]
      );
    });

    const result = await sweepExpiredAlbums(true, { eventIds: [older, extended] });

    expect(result.deleted).toEqual([older]);
    expect(await photoCount(extended)).toBe(1);
    expect(await deletionMark(extended)).toBeNull();
  });

  it('stops purging an album its host extends while the purge is running (N-101)', async () => {
    // The re-check before the purge (N-74) does not cover a purchase that
    // lands during it, and a purge can run for an hour.
    const eventId = await deletableAlbum(5);
    const { rows } = await query<{ guest_id: string }>('SELECT guest_id FROM photos WHERE event_id = $1 LIMIT 1', [
      eventId,
    ]);
    for (const n of [1, 2]) {
      const extra = await storageAdapter.save(Buffer.from(`more-${n}`), `more-${n}-${Date.now()}.jpg`, 'image/jpeg', eventId);
      await query(
        `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
         VALUES ($1, $2, $3, $3, 'approved', 6)`,
        [eventId, rows[0].guest_id, extra.storagePath]
      );
    }
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const real = storageAdapter.delete.bind(storageAdapter);
    let deletes = 0;
    vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
      deletes += 1;
      if (deletes === 1) {
        // The host pays while the first file is being deleted.
        await query(
          `UPDATE events SET expires_at = NOW() + INTERVAL '1 year', retention_notified_at = NULL WHERE id = $1`,
          [eventId]
        );
      }
      clock += 2000;
      return real(p);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await sweepExpiredAlbums(true, { eventIds: [eventId] });

    expect(result.deleted).toEqual([]);
    expect(await photoCount(eventId)).toBe(3);
    expect(deletes).toBe(1);
    expect(await deletionMark(eventId)).toBeNull();
  });

  it('still purges every album that remains deletable', async () => {
    const first = await deletableAlbum(9);
    const second = await deletableAlbum(5);

    const result = await sweepExpiredAlbums(true, { eventIds: [first, second] });

    expect(result.deleted).toEqual([first, second]);
    expect(await photoCount(first)).toBe(0);
    expect(await photoCount(second)).toBe(0);
  });
});

/**
 * Found by the security review of e38d95b: the mark could lapse without the
 * purge noticing. A renewal that failed was only logged, a mark taken off by
 * something else was renewed into nothing, and the rows were deleted without
 * checking the mark was still held — each one reopening uploads part way
 * through, which is the drift the mark exists to prevent. A purge now stops
 * instead, leaving rows that name deleted files: visible, and finished by the
 * next attempt.
 */
describe('a purge whose deletion mark lapses', () => {
  /** A second photo, so the purge has more than one file to work through. */
  async function addSecondPhoto(eventId: string): Promise<void> {
    const extra = await storageAdapter.save(Buffer.from('second'), `lapse-${Date.now()}.jpg`, 'image/jpeg', eventId);
    const { rows } = await query<{ guest_id: string }>('SELECT guest_id FROM photos WHERE event_id = $1 LIMIT 1', [
      eventId,
    ]);
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
       VALUES ($1, $2, $3, $3, 'approved', 6)`,
      [eventId, rows[0].guest_id, extra.storagePath]
    );
  }

  it('stops before deleting the rows when its mark was taken off part way', async () => {
    const eventId = await deletableAlbum(5);
    const mark = await markEventDeleting(eventId);
    onFirstDelete(async () => {
      await query('UPDATE events SET deleting_at = NULL WHERE id = $1', [eventId]);
    });

    await expect(purgeEventMedia(eventId, mark!)).rejects.toThrow(/mark/i);

    expect(await photoCount(eventId)).toBe(1);
  });

  it('stops when its mark cannot be renewed', async () => {
    const eventId = await deletableAlbum(5);
    await addSecondPhoto(eventId);
    const mark = await markEventDeleting(eventId);
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const real = storageAdapter.delete.bind(storageAdapter);
    vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
      clock += 10 * 60 * 1000;
      return real(p);
    });
    const realQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('SET deleting_at = NOW()') && sql.includes('deleting_at = $2::timestamptz')) {
        return Promise.reject(new Error('connection reset'));
      }
      return realQuery(...args);
    }) as typeof pool.query);

    await expect(purgeEventMedia(eventId, mark!)).rejects.toThrow();

    expect(await photoCount(eventId)).toBe(2);
  });

  it('still purges an album nobody marked, for the maintenance scripts', async () => {
    const eventId = await deletableAlbum(5);

    await purgeEventMedia(eventId);

    expect(await photoCount(eventId)).toBe(0);
  });
});

describe('two deletions of the same album', () => {
  it('lets only one hold the mark at a time', async () => {
    const eventId = await deletableAlbum(5);

    expect(await markEventDeleting(eventId)).not.toBeNull();
    expect(await markEventDeleting(eventId)).toBeNull();
  });

  /**
   * N-100 — a mark recorded a time, not who held it. A deletion that stalled
   * for an hour had its mark taken over, carried on under the new holder's
   * mark, and on failure took that mark off, reopening uploads under the
   * other deletion's purge.
   */
  it('does not let a deletion whose mark was taken over take the new holder\'s mark off (N-100)', async () => {
    const eventId = await deletableAlbum(5);
    const stalled = await markEventDeleting(eventId);
    await query("UPDATE events SET deleting_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [eventId]);
    const successor = await markEventDeleting(eventId);
    expect(successor).not.toBeNull();

    await clearDeletionMark(stalled!);

    expect(await deletionMark(eventId)).not.toBeNull();
    await clearDeletionMark(successor!);
    expect(await deletionMark(eventId)).toBeNull();
  });

  it('stops a purge whose mark was taken over, rather than carry on under another\'s (N-100)', async () => {
    const eventId = await deletableAlbum(5);
    const stalled = await markEventDeleting(eventId);
    await query("UPDATE events SET deleting_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [eventId]);
    await markEventDeleting(eventId);

    await expect(purgeEventMedia(eventId, stalled!)).rejects.toThrow(/mark/i);
    expect(await deletionMark(eventId)).not.toBeNull();
  });

  it('lets a deletion take over a mark left behind by one that crashed', async () => {
    const eventId = await deletableAlbum(5);
    await query("UPDATE events SET deleting_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [eventId]);

    expect(await markEventDeleting(eventId)).not.toBeNull();
  });

  it('leaves an album the host is deleting to the host, mark and all', async () => {
    const eventId = await deletableAlbum(5);
    await markEventDeleting(eventId); // the host's delete, under way

    const result = await sweepExpiredAlbums(true, { eventIds: [eventId] });

    expect(result.deleted).toEqual([]);
    expect(await deletionMark(eventId)).not.toBeNull();
    expect(await photoCount(eventId)).toBe(1);
  });
});

describe('fixtures', () => {
  it('stores the photos it purges on disk', async () => {
    const eventId = await deletableAlbum(5);
    const { rows } = await query<{ storage_path: string }>('SELECT storage_path FROM photos WHERE event_id = $1', [
      eventId,
    ]);
    const abs = storageAdapter.getAbsolutePath(rows[0].storage_path);
    expect(abs && fs.existsSync(abs)).toBe(true);
  });
});
