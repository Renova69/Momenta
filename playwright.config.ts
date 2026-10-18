import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests: the guest and host journeys walked by hand in three running-
 * app passes (MASTER_AUDIT §3i, §3j, §3k), automated so they run on every
 * change. `npm run test:browser` builds the client and runs them against the
 * production build served by Express, on its own port, with local storage.
 *
 * Files end in `.pw.ts` so the Vitest run (`*.spec.ts`) never picks them up.
 */
const PORT = 6685;

// N-189 — the workers too, not only the server below: their cleanup
// (tests/browser/support.ts) deletes what the server wrote, and with .env's
// STORAGE_PROVIDER=r2 it asked R2 to delete files that were on local disk.
process.env.STORAGE_PROVIDER = 'local';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.pw.ts',
  // One server and one database: the journeys run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Guests arrive on a phone, by QR code.
    { name: 'guest-phone', testMatch: '**/*.guest.pw.ts', use: { ...devices['Pixel 7'] } },
    { name: 'host-desktop', testMatch: '**/*.host.pw.ts', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx tsx server/index.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      PORT: String(PORT),
      // Photo addresses are built from this; it has to be the page's own
      // origin, or the policy rightly refuses them as another site's images.
      PUBLIC_BASE_URL: `http://localhost:${PORT}`,
      STORAGE_PROVIDER: 'local',
      FTP_ENABLED: 'false',
      // Checkout is not exercised here; with no key the pricing page never
      // reaches Stripe, whatever the developer's .env holds.
      STRIPE_SECRET_KEY: '',
    },
  },
});
