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
    // DB-backed HTTP tests against a shared Postgres, 16 workers deep. The
    // default 5s is fine on a quiet machine — the slowest of these takes 1.6s —
    // and too tight on a busy one, which is the intermittent failure nobody
    // could reproduce. Most specs already pass 20_000 by hand; this makes that
    // the default instead of something each author has to remember.
    testTimeout: 20_000,
    hookTimeout: 30_000,

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

      // Test sessions do not wait for each commit to reach the disk.
      //
      // On a Docker Desktop volume that flush takes about 200 ms, so a spec
      // that writes fifty rows one by one spent ten seconds just committing
      // them, and specs near the timeout failed whenever the machine was busy.
      // Visibility and locking are unchanged: a committed row is seen at once
      // by every other session either way. Only a database crash could lose
      // the last few commits, which a test run can afford. node-postgres
      // reads PGOPTIONS, so this reaches every pool the workers open, and
      // nothing outside the test run.
      PGOPTIONS: '-c synchronous_commit=off',

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
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      // All of the app's own code. The list used to name nine folders, which
      // left the hooks, utils, contexts, App.tsx, the WebSocket and FTP
      // servers and shared/ out of the number without saying so.
      include: ['src/**', 'server/**', 'shared/**'],
      exclude: [
        // Process entry points: they only start the app. server/index.ts is
        // exercised by the e2e suite, which runs in its own process.
        'src/main.tsx',
        'server/index.ts',
        // Declarations only; nothing to execute.
        'src/types/**',
        '**/*.d.ts',
      ],
      // A floor, a few points under what the suite measures (2026-10-17:
      // 90% of lines, 85% of branches), so coverage cannot quietly slide
      // below the project's 80% standard.
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 80,
        branches: 80,
      },
    },
  },
});
