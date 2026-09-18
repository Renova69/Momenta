import { purgeTestData } from '../scripts/purge-test-data';
import { pool } from '../server/lib/db';
import { CONFIG } from '../server/lib/config';

/**
 * True when this teardown is allowed to delete media.
 *
 * `tests/setup.ts` refuses to let the unit suite run against remote storage,
 * and that guard covers the *worker* processes — where `vitest.config.ts`'s
 * `test.env` applies. This file is not one of those. `globalSetup` runs in
 * Vitest's main process, which `test.env` never touches, so it resolved
 * `STORAGE_PROVIDER` from `.env` instead: on any machine whose `.env` says
 * `r2`, the teardown below called `purgeEventMedia` against the **live
 * Cloudflare bucket** after a suite that had written every byte to local disk.
 *
 * Two consequences, and the second is the one that went unnoticed for months:
 *
 *   1. Every `npm run test:unit` issued real DeleteObject calls to production
 *      storage. They were no-ops only because a local disk path is not a key
 *      that exists in the bucket.
 *   2. The local files it was supposed to be deleting were never deleted at
 *      all, while the teardown reported success. That is where 10,431
 *      orphaned album directories on this machine came from — the exact
 *      accumulation the comment in `purge-test-data.ts` says this function was
 *      written to prevent.
 *
 * The scripts now pin `STORAGE_PROVIDER=local` for the whole Vitest
 * invocation, not just its workers. This asserts the pin held, because the
 * failure mode is silent in both directions.
 */
function mayPurgeMedia(): boolean {
  return CONFIG.STORAGE_PROVIDER === 'local' || process.env.ALLOW_REMOTE_STORAGE_IN_TESTS === 'true';
}

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
  if (!mayPurgeMedia()) {
    console.error(
      `[teardown] STORAGE_PROVIDER resolved to "${CONFIG.STORAGE_PROVIDER}" in Vitest's main process.\n` +
        '[teardown] Refusing to purge: this would delete media from remote storage after a suite\n' +
        '[teardown] that wrote to local disk, and would leave the local files behind.\n' +
        '[teardown] Run via `npm run test:unit`, which pins the provider for the whole process.'
    );
    await pool.end().catch(() => undefined);
    return;
  }

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
