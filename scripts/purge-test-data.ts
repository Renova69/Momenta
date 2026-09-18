/**
 * Removes rows created by the test suites.
 *
 *   npm run db:purge-test-data              report what would go
 *   PURGE_CONFIRM=true npm run db:purge-test-data   actually delete
 *
 * Also called automatically by tests/globalTeardown.ts after every unit run,
 * which is what stops this accumulating in the first place.
 *
 * Specs register hosts and create events on every run, and only about two
 * thirds of them clean up after themselves — a spec that fails mid-way skips
 * its afterAll entirely. Over a week of development that left 5,461 events and
 * 13,763 users in the local database, which slowed every retention report and
 * buried its real output in fixture noise.
 *
 * SAFETY: identification is by email domain, as an ALLOW-list of domains only
 * the test suites ever use. It is deliberately not slug patterns — those drift
 * as specs are added, and a pattern that is slightly too broad deletes a real
 * wedding. A row is only ever removed if its owner's address ends in one of
 * TEST_EMAIL_DOMAINS, so genuine accounts are excluded by construction rather
 * than by a list of exceptions someone has to remember to maintain.
 */
import { pool } from '../server/lib/db';
import { errorLabel } from '../server/lib/errors';
import { purgeEventMedia } from '../server/lib/retention';

/** Domains used exclusively by the specs. Nothing real may ever live here. */
export const TEST_EMAIL_DOMAINS = ['test.com', 'test.local', 'example.com'] as const;

const LIKE_PATTERNS = TEST_EMAIL_DOMAINS.map((d) => `%@${d}`);

export interface PurgeResult {
  events: number;
  users: number;
  /** Bytes of stored media released along with those events. */
  mediaBytes: number;
}

export interface PurgeOptions {
  /**
   * Only remove rows that already existed at this instant.
   *
   * Identification by email domain says *whose* rows these are. It does not say
   * *when* they were made, and the teardown that calls this runs while other
   * vitest processes may be mid-suite — so without a cutoff it deletes the
   * fixtures another run is still using. Reproduced directly: firing this purge
   * against a live suite deleted 11 events and 152 users and failed 11 tests
   * across 6 unrelated spec files, which is exactly the shape of the
   * intermittent failures that went unexplained for a week.
   *
   * A run therefore cleans up after *previous* runs, never its own peers.
   * Accumulation stays bounded — one run's worth, collected by the next — and a
   * concurrent run's rows become untouchable by construction rather than by
   * timing.
   *
   * Omitted by the CLI, where an operator asking for a purge means all of it.
   */
  createdBefore?: string | null;
}

export async function purgeTestData(dryRun = false, options: PurgeOptions = {}): Promise<PurgeResult> {
  const cutoff = options.createdBefore ?? null;

  // `$2 IS NULL OR ...` rather than building the SQL conditionally: one
  // statement, one plan, and no chance of the count and the delete drifting
  // apart.
  const eventScope = `(e.host_email LIKE ANY($1::text[]) OR u.email LIKE ANY($1::text[]))
                      AND ($2::timestamptz IS NULL OR e.created_at < $2)`;

  // Deleting a user cascades into their events (migration 011), so an old user
  // holding a new event would take that event down with them and put us right
  // back where we started. The NOT EXISTS is what makes the cutoff mean what it
  // says.
  const userScope = `email LIKE ANY($1::text[])
                     AND ($2::timestamptz IS NULL OR created_at < $2)
                     AND NOT EXISTS (
                       SELECT 1 FROM events e
                        WHERE e.host_user_id = users.id
                          AND ($2::timestamptz IS NULL OR e.created_at >= $2)
                     )`;

  // Same reach as the delete below, so the preview cannot promise less than
  // the run removes.
  const countEvents = `SELECT COUNT(*)::int AS n
                         FROM events e
                         LEFT JOIN users u ON u.id = e.host_user_id
                        WHERE ${eventScope}`;
  const countUsers = `SELECT COUNT(*)::int AS n FROM users WHERE ${userScope}`;

  if (dryRun) {
    const e = await pool.query(countEvents, [LIKE_PATTERNS, cutoff]);
    const u = await pool.query(countUsers, [LIKE_PATTERNS, cutoff]);
    return { events: e.rows[0].n, users: u.rows[0].n, mediaBytes: 0 };
  }

  // Delete the STORED MEDIA before the rows that point at it.
  //
  // Removing an event row does not remove its photos from disk or from R2 —
  // nothing cascades into object storage — and once the row is gone the
  // storage paths are unreachable, so the files are stranded with no way left
  // to identify them. An earlier version of this script deleted the rows only,
  // and left 4,260 objects (200 MB) orphaned in R2 plus 4,018 directories on
  // local disk. purgeEventMedia is the same function the retention sweep uses.
  //
  // Matched two ways, not one. Selecting only on the event's own host_email
  // missed every event whose owner is a doomed test user but whose host_email
  // column holds something else — and the `DELETE FROM users` below cascades
  // into exactly those, taking the photo rows with it and stranding the files
  // anyway. The media purge has to see an event before the cascade does.
  const { rows: doomed } = await pool.query<{ id: string }>(
    `SELECT e.id
       FROM events e
       LEFT JOIN users u ON u.id = e.host_user_id
      WHERE ${eventScope}`,
    [LIKE_PATTERNS, cutoff]
  );

  let mediaBytes = 0;
  for (const { id } of doomed) {
    try {
      const purge = await purgeEventMedia(id);
      mediaBytes += purge.freedBytes;
      if (purge.failedPaths.length > 0) {
        console.warn(`  ${id}: ${purge.failedPaths.length} object(s) left in storage`);
      }
    } catch (err) {
      // Storage that will not delete must not block the row cleanup — the
      // alternative is a database that keeps growing because a bucket is
      // temporarily unreachable.
      console.warn(`[purge-test-data] could not purge media for event ${id}:`, errorLabel(err));
    }
  }

  // Events before users. Most hang off a user and would cascade anyway
  // (migration 011), but specs that insert an event directly leave it with a
  // NULL host_user_id and nothing to cascade from — those are only reachable here.
  const events = await pool.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [doomed.map((e) => e.id)]);
  const users = await pool.query(`DELETE FROM users WHERE ${userScope}`, [LIKE_PATTERNS, cutoff]);

  return { events: events.rowCount ?? 0, users: users.rowCount ?? 0, mediaBytes };
}

async function main(): Promise<void> {
  const confirmed = process.env.PURGE_CONFIRM === 'true';

  const preview = await purgeTestData(true);
  console.log('');
  console.log(`Test-fixture rows found: ${preview.events} event(s), ${preview.users} user(s)`);
  console.log(`Matching on host/user email domains: ${TEST_EMAIL_DOMAINS.join(', ')}`);
  console.log('');

  if (!confirmed) {
    console.log('Report only. Set PURGE_CONFIRM=true to delete them.');
    console.log('');
    return;
  }

  const result = await purgeTestData(false);
  console.log(`Deleted ${result.events} event(s) and ${result.users} user(s).`);
  console.log('');
}

// Only run as a CLI, so tests/globalTeardown.ts can import purgeTestData().
if (process.argv[1]?.includes('purge-test-data')) {
  main()
    .catch((err) => {
      console.error('[purge-test-data] failed:', errorLabel(err));
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
