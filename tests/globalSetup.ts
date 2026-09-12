import { purgeTestData } from '../scripts/purge-test-data';
import { pool } from '../server/lib/db';

/**
 * Removes the rows the suite just created, once, after every run.
 *
 * Exported as `teardown` from a globalSetup file, which is how Vitest does
 * this — `globalTeardown` is a Jest option and is silently ignored here, so
 * naming it that way looks correct and simply never runs.
 *
 * Per-spec `afterAll` cleanup is not enough on its own and never was: about a
 * third of the specs that create events never delete them, and even the ones
 * that do skip their afterAll when an assertion throws mid-test. The result was
 * 5,461 events and 13,763 users accumulated in the local database over a week —
 * enough to slow the retention report and bury its real output.
 *
 * A global teardown runs regardless of whether tests passed, which is exactly
 * the case per-spec cleanup misses.
 *
 * Failure here is logged, never thrown: leftover fixture rows are untidy, but
 * failing the run because of them would turn a green suite red for a reason
 * that has nothing to do with the code under test.
 */
export async function teardown(): Promise<void> {
  try {
    const { events, users, mediaBytes } = await purgeTestData(false);
    if (events > 0 || users > 0) {
      const mb = (mediaBytes / 1024 / 1024).toFixed(1);
      console.log(`[teardown] removed ${events} test event(s), ${users} test user(s), ${mb} MB of media`);
    }
  } catch (err) {
    console.warn('[teardown] could not purge test data:', err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end().catch(() => undefined);
  }
}
