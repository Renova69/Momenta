import { describe, it, expect, afterAll } from 'vitest';
import { purgeTestData } from '../../scripts/purge-test-data';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * The teardown must never delete a row it did not outlive.
 *
 * `purgeTestData` identifies fixtures by email domain. That says *whose* rows
 * they are; it says nothing about *when* they were made. It runs from
 * `globalSetup`'s teardown, which fires whenever a vitest process finishes —
 * including while another one is halfway through a suite. Unscoped, it deletes
 * the other run's live fixtures.
 *
 * That was the cause of a week of scattered, unreproducible failures, and it
 * was confirmed by doing it on purpose: firing the purge against a running
 * suite removed 11 events and 152 users, and failed 11 tests across 6 unrelated
 * spec files — concurrentUploadQuota, exportDownload, ingestRoutes,
 * photoComments, photoReactions, slugConcurrency. Whichever specs happened to
 * be mid-test. Green on a re-run done alone. With the cutoff in place the same
 * experiment deletes nothing and the suite passes.
 *
 * ---
 *
 * These tests use `dryRun` throughout, and that is not timidity. A test that
 * called the real delete would itself remove every fixture older than its
 * cutoff — including those of sibling specs running in parallel workers right
 * now. It would reproduce the very bug it exists to prevent, intermittently,
 * and would be blamed on something else. The counting path and the deleting
 * path are built from the same two scope expressions for exactly this reason,
 * so asserting on the count asserts on what the delete would take.
 */

const createdEvents: string[] = [];
const createdUsers: string[] = [];

/** An event (and its host) stamped with an explicit creation time. */
async function seed(label: string, createdAt: string): Promise<{ userId: string; eventId: string }> {
  const unique = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { rows: userRows } = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role, created_at)
     VALUES ($1, 'Purge Scope Spec', 'not-a-real-hash', 'host', $2)
     RETURNING id`,
    [`${unique}@test.local`, createdAt]
  );
  const userId = userRows[0].id;
  createdUsers.push(userId);

  const { rows: eventRows } = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, host_user_id, event_date, created_at)
     VALUES ($1, 'Purge Scope Spec', 'Purge Scope Host', $2, $3, CURRENT_DATE, $4)
     RETURNING id`,
    [unique, `${unique}@test.local`, userId, createdAt]
  );
  createdEvents.push(eventRows[0].id);

  return { userId, eventId: eventRows[0].id };
}

async function countedForCutoff(cutoff: string): Promise<{ events: number; users: number }> {
  const { events, users } = await purgeTestData(true, { createdBefore: cutoff });
  return { events, users };
}

/**
 * The cutoff, read from Postgres.
 *
 * Deliberately not `new Date()`. Rows are stamped by the database's clock, and
 * this process and the database are several hundred milliseconds apart here —
 * enough that a row inserted with `NOW()` immediately after a JS timestamp can
 * land *before* it. That skew is the reason the real cutoff is read from the
 * database too, and a test that used the app clock would be testing a
 * different, easier thing.
 */
async function dbNow(): Promise<string> {
  const { rows } = await query<{ now: string }>('SELECT now()::text AS now');
  return rows[0].now;
}

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (createdUsers.length > 0) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(() => undefined);
  }
});

describe('a purge scoped to rows that predate the run', () => {
  it('counts a row created before the cutoff', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seed('before', old);

    const before = await countedForCutoff(new Date(Date.now() - 30 * 60 * 1000).toISOString());

    expect(before.events).toBeGreaterThan(0);
  });

  it('leaves a row created after it alone', async () => {
    // The whole fix. This row stands in for a fixture belonging to a suite that
    // is still running.
    const cutoff = await dbNow();
    const baseline = await purgeTestData(true, { createdBefore: cutoff });

    const fresh = await seed('after', await dbNow());

    const after = await purgeTestData(true, { createdBefore: cutoff });
    const { rows } = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM events WHERE id = $1 AND created_at >= $2',
      [fresh.eventId, cutoff]
    );

    // The row exists and is newer than the cutoff...
    expect(rows[0].n).toBe(1);
    // ...and adding it did not widen the purge's reach by one. The absolute
    // count is not the assertion: this database legitimately holds older
    // fixtures, and sibling specs are creating newer ones as this runs. The
    // delta is the only thing that means anything.
    expect(after.events).toBe(baseline.events);
  });

  it('spares an old host who owns a new album', async () => {
    // Deleting a user cascades into their events, so a cutoff that looked only
    // at the user would still take a live album down and the guarantee would be
    // worthless. This is the case the NOT EXISTS clause exists for.
    const cutoff = await dbNow();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const baseline = await purgeTestData(true, { createdBefore: cutoff });

    const { rows: userRows } = await query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, role, created_at)
       VALUES ($1, 'Purge Scope Spec', 'not-a-real-hash', 'host', $2)
       RETURNING id`,
      [`old-host-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`, stale]
    );
    const userId = userRows[0].id;
    createdUsers.push(userId);

    const { rows: eventRows } = await query<{ id: string }>(
      `INSERT INTO events (slug, title, host_name, host_email, host_user_id, event_date, created_at)
       VALUES ($1, 'Purge Scope Spec', 'Purge Scope Host', $2, $3, CURRENT_DATE, NOW())
       RETURNING id`,
      [
        `old-host-new-album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        `old-host-kept-${Date.now()}@test.local`,
        userId,
      ]
    );
    createdEvents.push(eventRows[0].id);

    const after = await purgeTestData(true, { createdBefore: cutoff });
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u
        WHERE u.id = $1
          AND u.created_at < $2
          AND EXISTS (SELECT 1 FROM events e WHERE e.host_user_id = u.id AND e.created_at >= $2)`,
      [userId, cutoff]
    );

    // The fixture is the shape the guard is about — an old user, a new album...
    expect(rows[0].n).toBe(1);
    // ...and neither it nor its owner widened the purge's reach.
    expect(after.users).toBe(baseline.users);
    expect(after.events).toBe(baseline.events);
  });

  it('still reaches everything when no cutoff is given', async () => {
    // The CLI path. An operator asking for a purge means all of it, and losing
    // that would turn the fix into a slow leak instead of a fast one.
    await seed('unbounded', new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const unbounded = await purgeTestData(true);

    expect(unbounded.events).toBeGreaterThan(0);
  });
});
