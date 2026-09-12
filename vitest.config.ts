/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // Deletes the fixture rows the run created — see tests/globalSetup.ts,
    // which exports `teardown`. Runs whether or not the suite passed, which is
    // the case per-spec afterAll hooks cannot cover.
    globalSetup: ['./tests/globalSetup.ts'],
    env: {
      // Cap the Postgres pool per test worker.
      //
      // server/lib/db.ts sizes its pool for a real upload burst (DB_POOL_MAX
      // defaults to 40), but vitest runs spec files in parallel worker
      // processes and each one imports that module, so each gets its OWN pool
      // of that size. Against a server with max_connections=100, three active
      // workers can ask for 120 connections; the surplus fails with a connect
      // timeout, and whichever DB-heavy spec happened to be mid-request fails.
      // That is the cause of the long-standing intermittent failures that
      // moved between files (serverRoutes, exportDownload, ingestRoutes,
      // configValidation…), always passed in isolation, and always passed
      // under --no-file-parallelism.
      //
      // Tests are not bursting; a handful of connections each is plenty, and
      // 5 leaves headroom for up to 20 workers.
      DB_POOL_MAX: '5',

      // Unit tests always use local disk, never real Cloudflare R2 — pinned
      // here rather than per-spec so it cannot be forgotten in a new file.
      //
      // This is a TEST-RUNNER setting only. It does not touch .env, the dev
      // server or production: set STORAGE_PROVIDER=r2 there and uploads go to
      // R2 exactly as intended.
      //
      // Why it matters: with .env switched to r2, every spec that uploads or
      // reads media silently started making real network round-trips to
      // Cloudflare. Two timing-sensitive specs then failed constantly —
      // exportDownload's MED-01 abort test paces storage reads at 75ms and
      // reasons about what the export has managed to do before a client
      // disconnect, which is meaningless when each read is instead a variable
      // network hop, and ingestRoutes' MED-04 uploads 21 files, which alone
      // can exceed the 5s default timeout over the wire. Same code against
      // local disk: 489/489 across repeated parallel runs.
      //
      // Nothing here needs real R2 — storageAdapter.spec.ts exercises
      // R2StorageAdapter against a mocked S3 client, and configValidation.spec.ts
      // sets its own provider values. See tests/setup.ts for the guard that
      // keeps this honest.
      STORAGE_PROVIDER: 'local',

      // A public-looking address for the retention notice suite.
      //
      // CONFIG.APP_PUBLIC_URL falls back to PUBLIC_BASE_URL, which in .env is
      // this machine's LAN address. sendRetentionNotices refuses to send to a
      // link no recipient could open, so without this pin the notice specs
      // would exercise the refusal path rather than the sending one — and
      // would start doing so silently the day somebody edited .env.
      APP_PUBLIC_URL: 'https://tests.wedmoments.bg',
    },
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // tests/integration/** is the opt-in live-Cloudflare-R2 lane, run on
    // demand via `npm run test:storage:r2` (vitest.r2.config.ts). It makes
    // real network calls, so it must never join the default run.
    exclude: ['tests/**/*.test.ts', 'tests/integration/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: [
        'src/components/**',
        'src/services/**',
        'src/router/**',
        'src/i18n/**',
        'src/config/**',
        'src/api/**',
        'server/lib/**',
        'server/middleware/**',
        'server/routes/**',
      ],
    },
  },
});
