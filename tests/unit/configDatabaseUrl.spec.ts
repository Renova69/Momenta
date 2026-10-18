import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * N-167 — in production the server must not reach the database with the
 * password committed to this repository, or with none configured at all.
 * config.ts's own fallback carried that password; docker-compose.yml did too.
 * The pattern is the JWT_SECRET one: refuse to start rather than run with a
 * credential anyone who has read the repository knows.
 */
describe('CONFIG database URL in production (N-167)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY = 'false';
    process.env.PUBLIC_BASE_URL = 'https://album.example.com';
    process.env.STORAGE_PROVIDER = 'local';
    process.env.JWT_SECRET = 'a'.repeat(48);
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

  it('refuses to start without DATABASE_URL', async () => {
    // Blank, not deleted: dotenv refills an absent key from .env.
    process.env.DATABASE_URL = '';
    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/DATABASE_URL must be set in production/);
  });

  it('refuses the database password published in this repository', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgrespassword@db:5432/wedmoments_db';
    const err = await importConfigExpectingThrow();
    expect(err.message).toMatch(/published in this repository/);
    expect(err.message).not.toContain('postgrespassword');
  });

  it('starts with a real password', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:s3cret-Value-9@db:5432/wedmoments_db';
    const { CONFIG } = await import('../../server/lib/config');
    expect(CONFIG.DATABASE_URL).toContain('@db:5432');
  });
});
