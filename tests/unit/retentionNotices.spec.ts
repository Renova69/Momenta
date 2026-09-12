import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

const sent: { to: string; subject: string; text: string }[] = [];
let failFor: Set<string> = new Set();

vi.mock('../../server/lib/mailer', () => ({
  isMailerConfigured: () => true,
  verifyMailer: async () => undefined,
  resetMailer: () => undefined,
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (failFor.has(m.to)) throw new Error('SMTP rejected recipient(s): ' + m.to);
    sent.push(m);
  },
}));

import { authRouter } from '../../server/routes/auth';
import {
  sendRetentionNotices,
  buildNoticeEmail,
  formatBgDate,
  isPubliclyReachableUrl,
  hasBulgarianLocaleData,
  NOTICE_LEAD_DAYS,
} from '../../server/lib/retentionNotice';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';

/**
 * Retention notices — the thing that was missing, and the one property that
 * actually matters.
 *
 * `events.retention_notified_at` is what later permits an album to be deleted
 * (migration 024). So stamping it is not bookkeeping: it is the act that arms
 * deletion. Stamping after a send that failed would mark a host as warned when
 * nothing reached them, and their photos would be destroyed a fortnight later
 * on the strength of a notice that never existed — the precise failure the
 * notice guard was built to prevent, reintroduced by the code meant to satisfy
 * it.
 *
 * Everything below exists to pin that: stamp only on a confirmed send, per
 * album, never in bulk after the loop.
 */

const TEST_PORT = 6643;
/** `2 октомври 2026 г.` — the format the notice uses. */
const BG_DATE = /\d{1,2} (януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември) \d{4} г\./;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

async function registerHost(): Promise<{ eventId: string; email: string; slug: string }> {
  const email = `notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Notice Spec Host', password: 'Password123!' }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { eventId: data.event.id, email, slug: data.event.slug };
}

/** Put the album inside the notice window without expiring it yet. */
async function expiringSoon(eventId: string): Promise<void> {
  await query(
    `UPDATE events SET expires_at = NOW() + INTERVAL '${Math.max(1, NOTICE_LEAD_DAYS - 2)} days' WHERE id = $1`,
    [eventId]
  );
}

async function notifiedAt(eventId: string): Promise<string | null> {
  const r = await query<{ retention_notified_at: string | null }>(
    'SELECT retention_notified_at FROM events WHERE id = $1',
    [eventId]
  );
  return r.rows[0]?.retention_notified_at ?? null;
}

describe('retention notices', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  beforeEach(() => {
    sent.length = 0;
    failFor = new Set();
  });

  it('does not stamp anything in report mode', async () => {
    const host = await registerHost();
    await expiringSoon(host.eventId);

    const result = await sendRetentionNotices({ send: false });

    expect(result.pending.map((p) => p.eventId)).toContain(host.eventId);
    expect(sent).toHaveLength(0);
    expect(await notifiedAt(host.eventId)).toBeNull();
  });

  it('sends and stamps when told to send', async () => {
    const host = await registerHost();
    await expiringSoon(host.eventId);

    const result = await sendRetentionNotices({ send: true });

    expect(result.sent).toContain(host.eventId);
    expect(sent.map((m) => m.to)).toContain(host.email);
    expect(await notifiedAt(host.eventId)).not.toBeNull();
  });

  it('DOES NOT stamp when the send fails', async () => {
    // The property the whole notice mechanism rests on.
    const host = await registerHost();
    await expiringSoon(host.eventId);
    failFor = new Set([host.email]);

    const result = await sendRetentionNotices({ send: true });

    expect(result.failed.map((f) => f.eventId)).toContain(host.eventId);
    expect(result.sent).not.toContain(host.eventId);
    expect(await notifiedAt(host.eventId)).toBeNull();
  });

  it('stamps per album, so one failure does not arm the others', async () => {
    const good = await registerHost();
    const bad = await registerHost();
    await expiringSoon(good.eventId);
    await expiringSoon(bad.eventId);
    failFor = new Set([bad.email]);

    await sendRetentionNotices({ send: true });

    expect(await notifiedAt(good.eventId)).not.toBeNull();
    expect(await notifiedAt(bad.eventId)).toBeNull();
  });

  it('does not notify the same album twice', async () => {
    const host = await registerHost();
    await expiringSoon(host.eventId);

    await sendRetentionNotices({ send: true });
    sent.length = 0;
    const second = await sendRetentionNotices({ send: true });

    expect(second.sent).not.toContain(host.eventId);
    // This album specifically, not the mailbox as a whole.
    // sendRetentionNotices has no event scope — it picks up every album that
    // is due — so another spec file running in a parallel worker can put its
    // own album into `sent` between the two calls here. Asserting the mailbox
    // is empty made this test a measurement of what else happened to be
    // running, which passed until the suite grew enough for the windows to
    // overlap.
    expect(sent.map((m) => m.to)).not.toContain(host.email);
  });

  it('leaves an album alone until it is inside the notice window', async () => {
    const host = await registerHost();
    await query("UPDATE events SET expires_at = NOW() + INTERVAL '2 years' WHERE id = $1", [host.eventId]);

    const result = await sendRetentionNotices({ send: true });

    expect(result.sent).not.toContain(host.eventId);
    expect(await notifiedAt(host.eventId)).toBeNull();
  });

  it('ignores an album with indefinite retention', async () => {
    // Pro Planner has expires_at IS NULL — nothing to warn about.
    const host = await registerHost();
    await query('UPDATE events SET expires_at = NULL WHERE id = $1', [host.eventId]);

    const result = await sendRetentionNotices({ send: true });

    expect(result.sent).not.toContain(host.eventId);
  });

  it('tells the host which album, when it expires, and where to go', async () => {
    const host = await registerHost();
    await expiringSoon(host.eventId);

    await sendRetentionNotices({ send: true });
    const mail = sent.find((m) => m.to === host.email);

    expect(mail).toBeDefined();
    // A warning that does not say what is at risk, or what to do about it, is
    // not much of a warning.
    expect(mail!.text).toContain(host.slug);
    expect(mail!.text).toMatch(BG_DATE);
    expect(mail!.subject.length).toBeGreaterThan(0);
  });

  it('honours a batch limit', async () => {
    const a = await registerHost();
    const b = await registerHost();
    await expiringSoon(a.eventId);
    await expiringSoon(b.eventId);

    const result = await sendRetentionNotices({ send: true, limit: 1 });

    expect(result.sent.length).toBe(1);
  });

  it('skips an album with no host email rather than throwing', async () => {
    const host = await registerHost();
    await expiringSoon(host.eventId);
    await query("UPDATE events SET host_email = '' WHERE id = $1", [host.eventId]);

    const result = await sendRetentionNotices({ send: true });

    expect(result.sent).not.toContain(host.eventId);
    expect(result.failed.map((f) => f.eventId)).toContain(host.eventId);
    expect(await notifiedAt(host.eventId)).toBeNull();
  });

  /**
   * The copy itself.
   *
   * Rendering the email is how the LAN-address link was found — reading the
   * code never would have shown it. These pin the parts a reader would notice
   * and a test otherwise never looks at.
   */
  describe('copy', () => {
    const candidate = {
      eventId: 'e1',
      slug: 'monika-and-alexander-2026',
      title: 'Сватбата на Моника и Александър',
      hostEmail: 'host@example.com',
      expiresAt: '2026-10-02T09:00:00.000Z',
    };

    it('writes the date the way a Bulgarian reader writes it', () => {
      expect(formatBgDate('2026-10-02T09:00:00.000Z')).toBe('2 октомври 2026 г.');
      expect(formatBgDate('2026-01-15T09:00:00.000Z')).toBe('15 януари 2026 г.');
      expect(formatBgDate('2026-10-02T09:00:00.000Z', false)).toBe('2 октомври');
    });

    it('uses the host\u2019s calendar day, not UTC\u2019s', () => {
      // expires_at is a timestamptz whose time of day is whenever the album
      // happened to be created. Anything after 21:00 UTC is already tomorrow
      // in Sofia, so roughly one notice in eight would name the wrong day.
      expect(formatBgDate('2026-10-02T22:00:00.000Z')).toBe('3 октомври 2026 г.'); // EEST, +3
      expect(formatBgDate('2026-01-15T23:30:00.000Z')).toBe('16 януари 2026 г.'); // EET, +2
    });

    it('does not fall back to English month names', () => {
      // The month names come from Intl. A runtime without bg-BG data does not
      // throw when asked for it — it quietly answers in English, and the only
      // visible symptom is "October 2" inside a Bulgarian sentence.
      expect(hasBulgarianLocaleData()).toBe(true);
      expect(formatBgDate('2026-10-02T09:00:00.000Z')).not.toMatch(/[A-Za-z]/);
    });

    it('keeps the subject short enough for a client to show it whole', () => {
      const { subject } = buildNoticeEmail(candidate);

      expect(subject.length).toBeLessThanOrEqual(70);
      // The date has to survive the truncation — it is the only urgent part.
      expect(subject).toContain('2 октомври');
    });

    it('truncates a long title rather than losing the date', () => {
      const { subject } = buildNoticeEmail({ ...candidate, title: 'Х'.repeat(200) });

      expect(subject.length).toBeLessThanOrEqual(70);
      expect(subject).toContain('2 октомври');
      expect(subject).toContain('…');
    });

    it('is Bulgarian only', () => {
      const { subject, text, html } = buildNoticeEmail(candidate);

      for (const part of [subject, text, html.replace(/<[^>]*>/g, '')]) {
        expect(part).not.toContain('Hello');
        expect(part).not.toContain('expires');
      }
    });

    it('does not repeat the slug above the link it already contains', () => {
      const { text } = buildNoticeEmail(candidate);
      const occurrences = text.split(candidate.slug).length - 1;

      expect(occurrences).toBe(1);
    });

    it('leaves wrapping to the client instead of breaking mid-sentence', () => {
      // The previous copy was hard-wrapped at a fixed column, which put a line
      // break inside "Ако не / предприемете нищо" — tidy in a terminal, ragged
      // on the phone this will actually be read on.
      const { text } = buildNoticeEmail(candidate);
      const lines = text.split('\n');

      expect(lines).toContain(
        'След тази дата албумът остава непроменен още 30 дни. Ако не предприемете нищо, снимките ще бъдат изтрити безвъзвратно.'
      );
      expect(lines).toContain(
        'Съхранението на сватбения Ви албум „Сватбата на Моника и Александър“ изтича на 2 октомври 2026 г.'
      );
    });

    it('escapes a title that would otherwise inject markup', () => {
      const { html } = buildNoticeEmail({ ...candidate, title: '<img src=x onerror=alert(1)>' });

      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    });
  });

  /**
   * The link has to be one the recipient can open.
   *
   * APP_PUBLIC_URL falls back to PUBLIC_BASE_URL, which on this deployment is
   * a LAN address. Sending that to a host is worse than sending nothing: they
   * cannot act on the warning, and being stamped as warned is what later lets
   * the sweep delete their photographs.
   */
  describe('unreachable APP_PUBLIC_URL', () => {
    it('refuses every address a recipient could not reach', () => {
      const unreachable = [
        'http://192.168.0.35:6501',
        'http://10.0.0.7',
        'http://172.16.4.1',
        'http://169.254.1.1',
        'http://127.0.0.1:6501',
        'http://localhost:6501',
        'http://wedmoments',
        'not-a-url',
        'ftp://example.com',
      ];

      for (const raw of unreachable) {
        expect({ raw, ok: isPubliclyReachableUrl(raw).ok }).toEqual({ raw, ok: false });
      }
    });

    it('accepts a real public address', () => {
      expect(isPubliclyReachableUrl('https://wedmoments.bg').ok).toBe(true);
      expect(isPubliclyReachableUrl('https://app.wedmoments.bg:8443/x').ok).toBe(true);
    });

    it('allows plain http to a public host but says so', () => {
      const check = isPubliclyReachableUrl('http://wedmoments.bg');

      expect(check.ok).toBe(true);
      expect(check.reason).toContain('https');
    });

    it('sends nothing and stamps nothing when the runtime cannot write Bulgarian', async () => {
      const host = await registerHost();
      await expiringSoon(host.eventId);
      // What a small-ICU runtime does: answers "no locales matched" rather
      // than throwing, so every date silently comes back in English.
      const locales = vi
        .spyOn(Intl.DateTimeFormat, 'supportedLocalesOf')
        .mockReturnValue([] as unknown as string[]);
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await sendRetentionNotices({ send: true });

        expect(sent).toHaveLength(0);
        expect(result.failed.map((f) => f.eventId)).toContain(host.eventId);
        expect(await notifiedAt(host.eventId)).toBeNull();
      } finally {
        locales.mockRestore();
        err.mockRestore();
      }
    });

    it('sends nothing and stamps nothing when the link is a LAN address', async () => {
      const host = await registerHost();
      await expiringSoon(host.eventId);
      const real = CONFIG.APP_PUBLIC_URL;
      CONFIG.APP_PUBLIC_URL = 'http://192.168.0.35:6501';
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await sendRetentionNotices({ send: true });

        expect(sent).toHaveLength(0);
        expect(result.sent).toHaveLength(0);
        expect(result.failed.map((f) => f.eventId)).toContain(host.eventId);
        // The part that matters: unstamped, so the sweep still cannot touch it
        // and the next run retries once the address is fixed.
        expect(await notifiedAt(host.eventId)).toBeNull();
      } finally {
        CONFIG.APP_PUBLIC_URL = real;
        err.mockRestore();
      }
    });
  });
});
