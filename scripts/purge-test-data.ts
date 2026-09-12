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

export async function purgeTestData(dryRun = false): Promise<PurgeResult> {
  const countEvents = `SELECT COUNT(*)::int AS n FROM events WHERE host_email LIKE ANY($1::text[])`;
  const countUsers = `SELECT COUNT(*)::int AS n FROM users WHERE email LIKE ANY($1::text[])`;

  if (dryRun) {
    const e = await pool.query(countEvents, [LIKE_PATTERNS]);
    const u = await pool.query(countUsers, [LIKE_PATTERNS]);
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
  const { rows: doomed } = await pool.query<{ id: string }>(
    `SELECT id FROM events WHERE host_email LIKE ANY($1::text[])`,
    [LIKE_PATTERNS]
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
  const events = await pool.query(`DELETE FROM events WHERE host_email LIKE ANY($1::text[])`, [LIKE_PATTERNS]);
  const users = await pool.query(`DELETE FROM users WHERE email LIKE ANY($1::text[])`, [LIKE_PATTERNS]);

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
