import { describe, it, expect } from 'vitest';
import {
  parseToAddress,
  maskSecret,
  staticChecks,
  previewCandidate,
  type CheckDeps,
} from '../../scripts/notify-verify';
import { buildNoticeEmail } from '../../server/lib/retentionNotice';

/**
 * `notify:verify` — the check that had to exist before SMTP could be trusted.
 *
 * Every other path either sends nothing or sends to real hosts: `notify:report`
 * deliberately never opens a socket, and `notify:send` mails customers. Without
 * this, the first proof that the mail configuration worked would have been a
 * live send to somebody's wedding album, and a misconfiguration would have been
 * discovered by its silence.
 *
 * The two properties worth pinning are that it refuses to send while anything
 * is wrong, and that it cannot touch the database — it never calls
 * `sendRetentionNotices`, so no album can be stamped as notified, and none can
 * be brought closer to deletion by running a diagnostic.
 */

const ok: CheckDeps = {
  configured: () => true,
  urlCheck: () => ({ ok: true }),
  locale: () => true,
  mailFrom: 'WedMoments <noreply@wedmoments.bg>',
};

describe('notify:verify', () => {
  describe('parseToAddress', () => {
    it('reads both spellings', () => {
      expect(parseToAddress(['--to', 'a@b.bg'])).toBe('a@b.bg');
      expect(parseToAddress(['--to=a@b.bg'])).toBe('a@b.bg');
    });

    it('sends nothing when no address is given', () => {
      expect(parseToAddress([])).toBeNull();
      expect(parseToAddress(['--verbose'])).toBeNull();
    });

    it('treats a dangling --to as a mistake rather than as an address', () => {
      // `--to` with the address forgotten, or with the next flag swallowed as
      // if it were one. Sending to "--dry-run" is not a useful reading.
      expect(parseToAddress(['--to'])).toBeNull();
      expect(parseToAddress(['--to', '--dry-run'])).toBeNull();
      expect(parseToAddress(['--to='])).toBeNull();
    });
  });

  describe('maskSecret', () => {
    it('never reveals the password, not even its length', () => {
      expect(maskSecret('hunter2')).toBe('(set)');
      expect(maskSecret('a-much-longer-password')).toBe('(set)');
      expect(maskSecret('')).toBe('(empty)');
    });
  });

  describe('staticChecks', () => {
    it('passes a complete configuration', () => {
      const checks = staticChecks(ok);

      expect(checks.every((c) => c.ok)).toBe(true);
      expect(checks.map((c) => c.name)).toEqual([
        'SMTP_HOST',
        'MAIL_FROM',
        'APP_PUBLIC_URL',
        'bg-BG locale data',
      ]);
    });

    it('reports every problem at once, not just the first', () => {
      // A run that stopped at the first failure would take four rounds to
      // configure, each ending in another surprise.
      const checks = staticChecks({
        configured: () => false,
        urlCheck: () => ({ ok: false, reason: 'LAN address' }),
        locale: () => false,
        mailFrom: 'not-an-address',
      });

      expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
        'SMTP_HOST',
        'MAIL_FROM',
        'APP_PUBLIC_URL',
        'bg-BG locale data',
      ]);
    });

    it('fails a MAIL_FROM that is not an address', () => {
      const check = staticChecks({ ...ok, mailFrom: 'WedMoments' }).find((c) => c.name === 'MAIL_FROM');

      expect(check?.ok).toBe(false);
      expect(check?.fatal).toBe(true);
    });

    it('treats plain http to a public host as a warning, not a failure', () => {
      // Poor practice rather than broken: the link still opens.
      const check = staticChecks({
        ...ok,
        urlCheck: () => ({ ok: true, reason: 'prefer https' }),
      }).find((c) => c.name === 'APP_PUBLIC_URL');

      expect(check?.ok).toBe(true);
      expect(check?.fatal).toBe(false);
      expect(check?.detail).toContain('https');
    });

    it('marks an unreachable URL fatal, so no test mail carries a dead link', () => {
      const check = staticChecks({
        ...ok,
        urlCheck: () => ({ ok: false, reason: 'LAN address' }),
      }).find((c) => c.name === 'APP_PUBLIC_URL');

      expect(check?.ok).toBe(false);
      expect(check?.fatal).toBe(true);
    });
  });

  describe('the preview', () => {
    it('renders the real notice, so what is shown is what a host gets', () => {
      const candidate = previewCandidate();
      const { subject, text } = buildNoticeEmail(candidate);

      expect(subject).toContain(candidate.title);
      expect(text).toContain(candidate.slug);
      expect(text).toContain('Здравейте,');
    });

    it('uses an album that expires inside the notice window', () => {
      // A preview dated in the past, or years out, would not show the sentence
      // a host actually reads.
      const days = (new Date(previewCandidate().expiresAt).getTime() - Date.now()) / 86_400_000;

      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(14);
    });

    it('cannot be mistaken for a real album', () => {
      // The eventId is all zeroes and the host address is example.com, so a
      // preview that somehow reached the database would match nothing.
      expect(previewCandidate().eventId).toBe('00000000-0000-0000-0000-000000000000');
      expect(previewCandidate().hostEmail).toContain('@example.com');
    });
  });
});
