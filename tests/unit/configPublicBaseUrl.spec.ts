import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * N-174 — production started with PUBLIC_BASE_URL unset and fell back to
 * http://localhost:6501. Under local storage that address is written into
 * every stored photo, voice message and preview URL, so guests' phones show
 * broken images, and setting the variable later repairs none of the rows
 * already written. It is also one of the origins checkout may return to. The
 * server already refused to start without JWT_SECRET or TRUST_PROXY; this is
 * the same rule.
 */
describe('CONFIG public address in production (N-174)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY = 'false';
    process.env.STORAGE_PROVIDER = 'local';
    process.env.JWT_SECRET = 'b'.repeat(48);
    process.env.DATABASE_URL = 'postgresql://postgres:s3cret-Value-9@db:5432/wedmoments_db';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function importConfigExpectingThrow(): Promise<Error> {
    try {
      await import('../../server/lib/config');
    } catch (err) {
      return err as Error;
    }
    throw new Error('Expected server/lib/config to throw at import time, but it loaded successfully');
  }

  it('refuses to start without PUBLIC_BASE_URL', async () => {
    process.env.PUBLIC_BASE_URL = '';
    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/PUBLIC_BASE_URL must be set in production/);
  });

  it('refuses a value that is not an http(s) address', async () => {
    process.env.PUBLIC_BASE_URL = 'album.example.com';
    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/PUBLIC_BASE_URL/);
  });

  it('starts with a real address, without its trailing slash', async () => {
    process.env.PUBLIC_BASE_URL = 'https://album.example.com/';
    const { CONFIG } = await import('../../server/lib/config');
    expect(CONFIG.PUBLIC_BASE_URL).toBe('https://album.example.com');
  });
});
