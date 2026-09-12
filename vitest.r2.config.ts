/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

/**
 * Opt-in integration lane: the ONLY suite that talks to real Cloudflare R2.
 *
 *   npm run test:storage:r2
 *
 * Kept out of the default `npm run test:unit` deliberately. Every media-touching
 * spec once ran against whatever STORAGE_PROVIDER .env happened to hold, and
 * when that became `r2` the unit suite started making network round-trips —
 * which broke the two timing-sensitive specs (exportDownload MED-01,
 * ingestRoutes MED-04) constantly, because their reasoning about elapsed work
 * assumes local-disk reads. vitest.config.ts now pins `local` and
 * tests/setup.ts refuses to start otherwise.
 *
 * That pin left the live credential path with no automated coverage at all:
 * storageAdapter.spec.ts exercises R2StorageAdapter against a mocked S3
 * client, which proves the adapter's logic but never that the account, bucket,
 * token permissions and public hostname actually work together. This lane
 * covers exactly that, on demand — run it after changing R2 settings or
 * rotating the token, not on every edit.
 *
 * Requires real credentials in .env. It writes objects to the live bucket and
 * deletes them again; every key it creates is namespaced under a throwaway
 * event id.
 */
export default defineConfig({
  test: {
    globals: true,
    // Node, not jsdom: this lane never touches browser code, and jsdom's fetch
    // globals are the reason the unit suite hand-builds multipart bodies.
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    // No tests/setup.ts — that file's guard exists to keep the UNIT suite off
    // remote storage, which is the opposite of this lane's purpose.
    env: {
      STORAGE_PROVIDER: 'r2',
      ALLOW_REMOTE_STORAGE_IN_TESTS: 'true',
      DB_POOL_MAX: '5',
    },
    // Real network round-trips, so the 5s default is far too tight.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
