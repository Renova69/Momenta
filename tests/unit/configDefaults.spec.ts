import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The defaults every deployment falls back to.
 *
 * `configValidation.spec.ts` covers the guards that refuse to start.
 * This covers what happens when a variable is simply absent, which is the
 * ordinary case: a developer's machine, a first deploy, a container missing
 * one line of its environment.
 *
 * Worth pinning because the failure is silent in both directions. A default
 * that is wrong in the safe direction disables a feature nobody notices is
 * off; one that is wrong in the unsafe direction — plaintext FTP, an enabled
 * migration, a proxy trusted by accident — looks like a working service.
 */

describe('CONFIG defaults', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  /**
   * Blank rather than delete: config.ts calls dotenv.config() at load, and
   * dotenv fills in any key ABSENT from process.env — so a delete here is
   * quietly undone by whatever is in the developer's .env. Same reasoning as
   * configValidation.spec.ts.
   */
  function blankEnv(...keys: string[]): void {
    for (const key of keys) process.env[key] = '';
  }

  async function loadConfig() {
    const mod = await import('../../server/lib/config');
    return mod.CONFIG;
  }

  describe('booleans default to the safe answer', () => {
    it('leaves the in-process FTP server off', async () => {
      blankEnv('FTP_ENABLED');
      expect((await loadConfig()).FTP_ENABLED).toBe(false);
    });

    it('requires plaintext FTP to be opted into explicitly', async () => {
      blankEnv('FTP_ALLOW_PLAINTEXT');
      expect((await loadConfig()).FTP_ALLOW_PLAINTEXT).toBe(false);
    });

    it('leaves SMTP TLS off unless asked for', async () => {
      blankEnv('SMTP_SECURE');
      expect((await loadConfig()).SMTP_SECURE).toBe(false);
    });

    it('reads these case-insensitively', async () => {
      process.env.FTP_ENABLED = 'TRUE';
      process.env.SMTP_SECURE = 'True';
      const config = await loadConfig();
      expect(config.FTP_ENABLED).toBe(true);
      expect(config.SMTP_SECURE).toBe(true);
    });

    it('treats any value other than "true" as off', async () => {
      process.env.FTP_ENABLED = 'yes';
      expect((await loadConfig()).FTP_ENABLED).toBe(false);
    });
  });

  describe('AUTO_MIGRATE is the exception — on unless refused', () => {
    it('defaults to on, because a half-migrated schema is worse', async () => {
      blankEnv('AUTO_MIGRATE');
      expect((await loadConfig()).AUTO_MIGRATE).toBe(true);
    });

    it('is disabled only by the literal string "false"', async () => {
      process.env.AUTO_MIGRATE = 'false';
      expect((await loadConfig()).AUTO_MIGRATE).toBe(false);
    });

    it('stays on for any other value, including "0"', async () => {
      process.env.AUTO_MIGRATE = '0';
      expect((await loadConfig()).AUTO_MIGRATE).toBe(true);
    });
  });

  describe('numeric defaults', () => {
    it('uses 2121 for the FTP port', async () => {
      blankEnv('FTP_PORT');
      expect((await loadConfig()).FTP_PORT).toBe(2121);
    });

    it('uses 587 for SMTP', async () => {
      blankEnv('SMTP_PORT');
      expect((await loadConfig()).SMTP_PORT).toBe(587);
    });

    it('carries a seven-day dunning grace window', async () => {
      // Stripe retries for roughly this long; cutting a paying customer off
      // mid-wedding because a card expired is worse than carrying them.
      blankEnv('SUBSCRIPTION_GRACE_DAYS');
      expect((await loadConfig()).SUBSCRIPTION_GRACE_DAYS).toBe(7);
    });

    it('honours an override', async () => {
      process.env.SUBSCRIPTION_GRACE_DAYS = '14';
      process.env.FTP_PORT = '2200';
      const config = await loadConfig();
      expect(config.SUBSCRIPTION_GRACE_DAYS).toBe(14);
      expect(config.FTP_PORT).toBe(2200);
    });
  });

  describe('URLs', () => {
    it('strips a trailing slash from PUBLIC_BASE_URL', async () => {
      // It is concatenated with paths; a double slash reaches stored photo
      // URLs and then the ZIP export.
      process.env.PUBLIC_BASE_URL = 'https://example.com///';
      expect((await loadConfig()).PUBLIC_BASE_URL).toBe('https://example.com');
    });

    it('falls back to localhost on the configured port', async () => {
      blankEnv('PUBLIC_BASE_URL');
      process.env.PORT = '7001';
      expect((await loadConfig()).PUBLIC_BASE_URL).toBe('http://localhost:7001');
    });

    it('strips a trailing slash from R2_PUBLIC_URL', async () => {
      process.env.R2_PUBLIC_URL = 'https://cdn.example.com/';
      expect((await loadConfig()).R2_PUBLIC_URL).toBe('https://cdn.example.com');
    });

    describe('APP_PUBLIC_URL falls back in order', () => {
      it('prefers its own value', async () => {
        process.env.APP_PUBLIC_URL = 'https://app.example.com/';
        process.env.PUBLIC_BASE_URL = 'https://other.example.com';
        expect((await loadConfig()).APP_PUBLIC_URL).toBe('https://app.example.com');
      });

      it('then PUBLIC_BASE_URL', async () => {
        blankEnv('APP_PUBLIC_URL');
        process.env.PUBLIC_BASE_URL = 'https://other.example.com/';
        expect((await loadConfig()).APP_PUBLIC_URL).toBe('https://other.example.com');
      });

      it('then localhost', async () => {
        blankEnv('APP_PUBLIC_URL', 'PUBLIC_BASE_URL');
        process.env.PORT = '6502';
        expect((await loadConfig()).APP_PUBLIC_URL).toBe('http://localhost:6502');
      });
    });
  });

  describe('optional integrations default to absent, not to a guess', () => {
    it('leaves Stripe unconfigured', async () => {
      blankEnv('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET');
      const config = await loadConfig();
      expect(config.STRIPE_SECRET_KEY).toBe('');
      expect(config.STRIPE_WEBHOOK_SECRET).toBe('');
    });

    it('leaves every Stripe price id empty', async () => {
      blankEnv(
        'STRIPE_PRICE_CELEBRATION_PASS',
        'STRIPE_PRICE_DELUXE_KEEPSAKE',
        'STRIPE_PRICE_PRO_PLANNER'
      );
      const config = await loadConfig();
      expect(config.STRIPE_PRICE_CELEBRATION_PASS).toBe('');
      expect(config.STRIPE_PRICE_DELUXE_KEEPSAKE).toBe('');
      expect(config.STRIPE_PRICE_PRO_PLANNER).toBe('');
    });

    it('leaves SMTP unconfigured and warns, because that disables deletion', async () => {
      blankEnv('SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD');
      const config = await loadConfig();

      expect(config.SMTP_HOST).toBe('');
      // The warning is load-bearing: no mailer means no retention notice,
      // and no notice means the sweep deletes nothing.
      expect(console.warn).toHaveBeenCalled();
    });

    it('ships a sender address so mail is never sent From: undefined', async () => {
      blankEnv('MAIL_FROM');
      expect((await loadConfig()).MAIL_FROM).toContain('@');
    });

    it('leaves the FTP TLS material empty rather than inventing a path', async () => {
      blankEnv('FTP_TLS_CERT', 'FTP_TLS_KEY');
      const config = await loadConfig();
      expect(config.FTP_TLS_CERT).toBe('');
      expect(config.FTP_TLS_KEY).toBe('');
    });
  });

  describe('storage paths', () => {
    it('defaults the R2 bucket name', async () => {
      blankEnv('R2_BUCKET_NAME');
      expect((await loadConfig()).R2_BUCKET_NAME).toBe('wedmoments-photos');
    });

    it('puts the FTP staging directory under the working directory', async () => {
      blankEnv('FTP_STAGING_DIR');
      expect((await loadConfig()).FTP_STAGING_DIR).toContain('ftp-staging');
    });

    it('honours an explicit staging directory', async () => {
      process.env.FTP_STAGING_DIR = '/srv/ftp-in';
      expect((await loadConfig()).FTP_STAGING_DIR).toBe('/srv/ftp-in');
    });

    it('keeps quarantine structurally outside the public upload mount', async () => {
      // A pending or disposable-locked photo must not be reachable by URL at
      // all, so the two directories cannot be nested. They are siblings:
      // uploads/ and uploads-quarantine/.
      //
      // Note the separator. A plain startsWith() says "uploads-quarantine" is
      // inside "uploads" because it shares the prefix - the same trap
      // resolveStoredPath() guards against in the FTP server.
      const path = await import('path');
      blankEnv('UPLOADS_DIR', 'QUARANTINE_DIR');
      const config = await loadConfig();

      expect(config.QUARANTINE_DIR).not.toBe(config.UPLOADS_DIR);
      expect(config.QUARANTINE_DIR.startsWith(config.UPLOADS_DIR + path.sep)).toBe(false);
    });
  });

  describe('TRUST_PROXY defaults closed', () => {
    it('ignores X-Forwarded-For when unset, and says so', async () => {
      // Trusting it by default lets a client reaching the process directly
      // spoof its own rate-limit identity.
      blankEnv('TRUST_PROXY');
      process.env.NODE_ENV = 'test';
      const config = await loadConfig();

      expect(config.TRUST_PROXY).toBe(false);
      expect(console.warn).toHaveBeenCalled();
    });

    it('accepts a hop count', async () => {
      process.env.TRUST_PROXY = '1';
      expect((await loadConfig()).TRUST_PROXY).toBe(1);
    });

    it('accepts an explicit false', async () => {
      process.env.TRUST_PROXY = 'false';
      expect((await loadConfig()).TRUST_PROXY).toBe(false);
    });
  });
});
