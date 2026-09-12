import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// G6 — createStorageAdapter() used to fall back silently to local disk for
// any STORAGE_PROVIDER value it didn't fully recognize as a configured 'r2'.
// config.ts now crashes at startup instead, matching the existing
// JWT_SECRET pattern. Every test here loads config.ts fresh (vi.resetModules)
// since the validation runs once at module load time from process.env.
describe('CONFIG storage provider validation (G6)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /**
   * Blank a variable rather than `delete`-ing it.
   *
   * config.ts calls dotenv.config() at module load, and dotenv fills in any
   * key that is ABSENT from process.env — so a `delete` here is quietly undone
   * by whatever the developer happens to have in .env, and these specs then
   * pass or fail based on that file. (They began failing the moment real R2
   * values were added to it.) An empty string keeps the key present, so dotenv
   * leaves it alone, and config.ts treats it as missing exactly like an unset
   * one — every check is `!process.env[key]`.
   */
  function blankEnv(...keys: string[]): void {
    for (const key of keys) process.env[key] = '';
  }

  /**
   * Import config.ts expecting it to reject, and hand back only the error.
   *
   * Deliberately not `expect(import(...)).rejects.toThrow()`: when that
   * assertion fails, vitest prints the resolved module — which is the whole
   * CONFIG object, secrets included. This spec leaked a live STRIPE_SECRET_KEY
   * and STRIPE_WEBHOOK_SECRET into terminal output exactly that way.
   */
  async function importConfigExpectingThrow(): Promise<Error> {
    try {
      await import('../../server/lib/config');
    } catch (err) {
      return err as Error;
    }
    throw new Error('Expected server/lib/config to throw at import time, but it loaded successfully');
  }

  it('accepts STORAGE_PROVIDER=local with no R2 vars set', async () => {
    process.env.STORAGE_PROVIDER = 'local';
    blankEnv('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY');

    const { CONFIG } = await import('../../server/lib/config');
    expect(CONFIG.STORAGE_PROVIDER).toBe('local');
  });

  it('accepts STORAGE_PROVIDER=r2 with all credentials present', async () => {
    process.env.STORAGE_PROVIDER = 'r2';
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_PUBLIC_URL = 'https://pub-abc123.r2.dev';

    const { CONFIG } = await import('../../server/lib/config');
    expect(CONFIG.STORAGE_PROVIDER).toBe('r2');
  });

  it('is case-insensitive for a valid provider value', async () => {
    process.env.STORAGE_PROVIDER = 'R2';
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_PUBLIC_URL = 'https://pub-abc123.r2.dev';

    const { CONFIG } = await import('../../server/lib/config');
    expect(CONFIG.STORAGE_PROVIDER).toBe('r2');
  });

  it('throws on an unrecognized STORAGE_PROVIDER instead of falling back to local', async () => {
    process.env.STORAGE_PROVIDER = 'cloudflare';

    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/STORAGE_PROVIDER="cloudflare" is not recognized/);
  });

  it('throws on a typo\'d STORAGE_DRIVER instead of silently defaulting to local', async () => {
    // STORAGE_PROVIDER itself is unset here (the app never reads STORAGE_DRIVER),
    // which is the documented case (G6 / STORAGE_AND_FINANCIAL_PLAN.md once used
    // the wrong name) — but it still resolves to the safe 'local' default, not a
    // crash. Only an explicit unrecognized STORAGE_PROVIDER throws.
    blankEnv('STORAGE_PROVIDER');
    process.env.STORAGE_DRIVER = 'r2';

    const { CONFIG } = await import('../../server/lib/config');
    expect(CONFIG.STORAGE_PROVIDER).toBe('local');
  });

  it('throws when STORAGE_PROVIDER=r2 is missing all R2 credentials', async () => {
    process.env.STORAGE_PROVIDER = 'r2';
    blankEnv('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY');

    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(
      /missing required credential\(s\): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/
    );
  });

  it('throws when STORAGE_PROVIDER=r2 is missing just the secret key', async () => {
    process.env.STORAGE_PROVIDER = 'r2';
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'key';
    blankEnv('R2_SECRET_ACCESS_KEY');
    process.env.R2_PUBLIC_URL = 'https://pub-abc123.r2.dev';

    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/missing required credential\(s\): R2_SECRET_ACCESS_KEY/);
  });

  it('throws when STORAGE_PROVIDER=r2 has all credentials but no R2_PUBLIC_URL', async () => {
    // Without this, R2StorageAdapter.save() falls back to the private
    // S3-compatible API endpoint as the "public" URL — every upload would
    // succeed and then be permanently unloadable in a browser (see
    // docs/CLOUDFLARE_R2_SETUP_GUIDE.md, which lists this as one of the 5
    // required values). Credentials alone are not enough to start.
    process.env.STORAGE_PROVIDER = 'r2';
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    blankEnv('R2_PUBLIC_URL');

    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/missing required R2_PUBLIC_URL/);
  });
});
