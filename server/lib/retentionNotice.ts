import { pool } from './db';
import { CONFIG } from './config';
import { errorLabel } from './errors';
import { sendMail } from './mailer';
import { GRACE_PERIOD_DAYS } from './retention';

/**
 * Warning a host that their album is about to be deleted (D1).
 *
 * The retention sweep refuses to delete an album whose
 * `events.retention_notified_at` is unset or too recent (migration 024). This
 * is the only thing that sets that column, which makes it the piece that arms
 * deletion — and the reason its failure handling is written the way it is.
 *
 * **The column is stamped only after a confirmed send, one album at a time.**
 * Stamping optimistically, or in bulk after the loop, would mark a host as
 * warned when nothing reached them; a fortnight later the sweep would delete
 * their photographs on the strength of a notice that never existed. That is
 * the exact failure the notice guard was built to prevent, and it would have
 * been reintroduced by the code meant to satisfy it.
 */

/**
 * How far ahead of expiry a host is warned.
 *
 * Combined with the 30-day grace period that follows expiry and the 14 days a
 * notice must age before deletion is permitted, a host gets roughly six weeks
 * between the warning and anything being removed.
 */
export const NOTICE_LEAD_DAYS = parseInt(process.env.RETENTION_NOTICE_LEAD_DAYS || '14', 10);

/** Per-run ceiling, so a first run against a large backlog does not become a send storm. */
const DEFAULT_BATCH_LIMIT = 200;

export interface NoticeCandidate {
  eventId: string;
  slug: string;
  title: string;
  hostEmail: string | null;
  expiresAt: string;
}

export interface NoticeResult {
  /** Albums inside the notice window that have not been warned yet. */
  pending: NoticeCandidate[];
  sent: string[];
  failed: { eventId: string; reason: string }[];
}

export interface SendNoticeOptions {
  /** False (the default) reports without sending or stamping anything. */
  send?: boolean;
  limit?: number;
  /**
   * Restrict the run to these event ids.
   *
   * Exists for tests, the same way `limit` does. This function is
   * database-wide by design — a nightly run should warn every album that is
   * due — but four spec files call it against one shared database under
   * vitest's file parallelism, so an unscoped run stamps
   * `retention_notified_at` on albums another spec file just created and is
   * about to assert on. That is a genuinely flaky test on the one code path
   * that ends in photographs being deleted.
   *
   * Keyed on event id rather than host address so an album with no host email
   * — which one spec creates deliberately — is still reachable when scoped.
   *
   * Production callers omit it and behave exactly as before.
   */
  eventIds?: string[];
}

/**
 * Albums due a warning: inside the notice window, never warned, reachable.
 *
 * `expires_at IS NULL` is excluded — that is indefinite retention (Pro
 * Planner), where there is nothing to warn about.
 *
 * Addresses with an uncleared hard bounce are excluded too (migration 025).
 * Re-sending to a mailbox that does not exist accomplishes nothing, and the
 * stamp it would leave behind is what later permits the album to be deleted —
 * so the album stays unstamped, stays undeletable, and stays visible in the
 * retention report's "past grace but NOT deletable" bucket until a person deals
 * with it. An album nobody can warn is not an album that may be destroyed.
 *
 * **The celebration must also have happened**, and that condition is doing real
 * work rather than stating the obvious. The free tier's window is 7 days from
 * the celebration, so `expires_at = event_date + 7`, while the notice lead is
 * 14 days — which makes `expires_at < NOW() + 14 days` true from
 * `event_date - 7` onward. Without the guard, a couple who set their album up a
 * month ahead would be emailed "your album will be deleted on ..." a week
 * before they got married, and every free album would do it.
 *
 * The longer tiers never reached this: celebration_pass warns 76 days after the
 * wedding, deluxe_keepsake 351. It is specific to a retention window shorter
 * than the notice lead, which today is only the free tier — but the guard is
 * written against the celebration rather than against the free tier, so
 * shortening any other window later cannot reintroduce it.
 */
export async function findAlbumsNeedingNotice(
  limit = DEFAULT_BATCH_LIMIT,
  eventIds?: string[]
): Promise<NoticeCandidate[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.slug, e.title, e.host_email, e.expires_at
       FROM events e
      WHERE e.expires_at IS NOT NULL
        AND e.retention_notified_at IS NULL
        -- The celebration must have happened. See the note above this query.
        AND e.event_date < NOW()
        AND e.expires_at < NOW() + ($1 || ' days')::interval
        AND NOT EXISTS (
              SELECT 1 FROM email_bounces b
               WHERE b.email = lower(e.host_email)
                 AND b.kind = 'hard'
                 AND b.cleared_at IS NULL
            )
        AND ($3::uuid[] IS NULL OR e.id = ANY($3))
      ORDER BY e.expires_at ASC
      LIMIT $2`,
    [String(NOTICE_LEAD_DAYS), limit, eventIds ?? null]
  );

  return rows.map((r) => ({
    eventId: r.id,
    slug: r.slug,
    title: r.title,
    hostEmail: r.host_email || null,
    expiresAt: new Date(r.expires_at).toISOString(),
  }));
}

/** Hosts are in Bulgaria; both the language and the calendar day are theirs. */
const DISPLAY_LOCALE = 'bg-BG';
const DISPLAY_TIMEZONE = 'Europe/Sofia';

/**
 * Does this runtime actually carry Bulgarian locale data?
 *
 * Node has shipped full-ICU by default since v13, so on any normal deployment
 * this is true. It is worth asking anyway: a runtime built with small-ICU, or
 * one started with a trimmed `NODE_ICU_DATA`, does not fail when asked for
 * `bg-BG` — it quietly falls back to English. The failure mode is a notice that
 * looks entirely correct apart from "October 2" sitting in the middle of a
 * Bulgarian sentence, which no test on a developer machine would catch.
 *
 * Checked once before a batch goes out rather than per album, and treated the
 * same way an unreachable link is: nothing is sent and nothing is stamped, so
 * the albums stay undeletable and the next run retries.
 */
export function hasBulgarianLocaleData(): boolean {
  return Intl.DateTimeFormat.supportedLocalesOf([DISPLAY_LOCALE]).length > 0;
}

/**
 * `2 октомври 2026 г.` — how a date is actually written in Bulgarian.
 *
 * Rendered in Europe/Sofia, not UTC. `expires_at` is a timestamptz whose time
 * of day is whenever the album happened to be created, so anything falling
 * after 21:00 UTC is already tomorrow in Sofia — roughly one notice in eight
 * would otherwise name the wrong day. The instant stays UTC in the database;
 * only the calendar day shown to the host is local, which is the correct split.
 */
export function formatBgDate(iso: string, withYear = true): string {
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIMEZONE,
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' as const } : {}),
  }).format(new Date(iso));
}

/** Album titles are host-supplied and land in an HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Keeps the subject inside what a mail client will actually show. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Is this URL one a recipient could actually open?
 *
 * The notice exists to tell a host how to save their photographs, so a link
 * they cannot reach makes the email worse than useless: they cannot act on the
 * warning, and the album is deleted anyway at the end of the grace period.
 * `APP_PUBLIC_URL` falls back to `PUBLIC_BASE_URL`, which on this deployment is
 * `http://192.168.0.35:6501` — a LAN address that means nothing in somebody
 * else's inbox. Nothing in the config layer objects to that, and it would have
 * gone out to every host.
 *
 * Loopback and private ranges are refused outright. Plain http to a public host
 * is allowed but reported: poor practice rather than broken.
 */
export function isPubliclyReachableUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `APP_PUBLIC_URL "${raw}" is not a valid URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `APP_PUBLIC_URL "${raw}" is not an http(s) URL` };
  }

  const host = url.hostname.toLowerCase();
  const unreachable =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // A bare hostname with no dot is only resolvable on the local network.
    !host.includes('.');

  if (unreachable) {
    return {
      ok: false,
      reason:
        `APP_PUBLIC_URL is "${raw}", which no recipient outside this network can open. ` +
        'Set APP_PUBLIC_URL to the address hosts actually use before sending notices.',
    };
  }

  return {
    ok: true,
    reason: url.protocol === 'http:' ? `APP_PUBLIC_URL "${raw}" is plain http — prefer https` : undefined,
  };
}

/**
 * The warning itself, in Bulgarian.
 *
 * Bulgarian only. The product is Bulgarian-facing, a host has no server-side
 * locale to switch on, and sending everyone both languages makes both halves
 * worse: the subject is truncated by the client long before the second language
 * is reached, so the duplication costs length and buys nothing.
 *
 * It names the album, when it closes, how long the grace period runs, what
 * happens at the end of it, and what to do about it — a notice missing any of
 * those is not really a notice.
 */
export function buildNoticeEmail(candidate: NoticeCandidate): { subject: string; text: string; html: string } {
  const expiresOn = formatBgDate(candidate.expiresAt);
  const expiresShort = formatBgDate(candidate.expiresAt, false);
  const albumUrl = `${CONFIG.APP_PUBLIC_URL}/e/${candidate.slug}`;
  const title = candidate.title || candidate.slug;

  // Bulgarian quotation marks, and a title short enough that the date survives
  // the ~60 characters a client will show.
  const subject = `Албумът „${truncate(title, 32)}“ изтича на ${expiresShort}`;

  // One paragraph per line, wrapping left to the client. A fixed column looks
  // ragged on a phone, which is where this will be read.
  const text = [
    'Здравейте,',
    '',
    // No full stop after the date: `formatBgDate` ends in the abbreviation
    // "г.", and doubling the period is wrong in Bulgarian as in English.
    `Съхранението на сватбения Ви албум „${title}“ изтича на ${expiresOn}`,
    '',
    albumUrl,
    '',
    `След тази дата албумът остава непроменен още ${GRACE_PERIOD_DAYS} дни. Ако не предприемете нищо, снимките ще бъдат изтрити безвъзвратно.`,
    '',
    'За да ги запазите, изтеглете ги от албума или надградете плана си.',
    '',
    'Поздрави,',
    'Екипът на WedMoments',
  ].join('\n');

  const safeTitle = escapeHtml(title);
  const safeUrl = escapeHtml(albumUrl);
  const html = [
    '<p>Здравейте,</p>',
    `<p>Съхранението на сватбения Ви албум <strong>„${safeTitle}“</strong> изтича на <strong>${expiresOn}</strong></p>`,
    `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
    `<p>След тази дата албумът остава непроменен още ${GRACE_PERIOD_DAYS} дни. Ако не предприемете нищо, снимките ще бъдат изтрити безвъзвратно.</p>`,
    '<p>За да ги запазите, изтеглете ги от албума или надградете плана си.</p>',
    '<p>Поздрави,<br>Екипът на WedMoments</p>',
  ].join('\n');

  return { subject, text, html };
}

export async function sendRetentionNotices(options: SendNoticeOptions = {}): Promise<NoticeResult> {
  const send = options.send === true;
  const pending = await findAlbumsNeedingNotice(
    options.limit ?? DEFAULT_BATCH_LIMIT,
    options.eventIds
  );

  const result: NoticeResult = { pending, sent: [], failed: [] };
  if (!send) return result;

  // Checked once, before anything goes out. A notice carrying a link the
  // recipient cannot open is worse than sending nothing: the host cannot act on
  // the warning, and stamping them as warned would let the sweep delete the
  // album a fortnight later. Refusing leaves every album unstamped and
  // therefore undeletable, which is the right outcome for a misconfiguration.
  const urlCheck = isPubliclyReachableUrl(CONFIG.APP_PUBLIC_URL);
  if (!urlCheck.ok) {
    for (const candidate of pending) {
      result.failed.push({ eventId: candidate.eventId, reason: urlCheck.reason ?? 'APP_PUBLIC_URL is unusable' });
    }
    console.error(`[retention-notice] refusing to send: ${urlCheck.reason}`);
    return result;
  }
  if (urlCheck.reason) {
    console.warn(`[retention-notice] ${urlCheck.reason}`);
  }

  // Same treatment for a runtime that cannot write Bulgarian: refuse the batch
  // rather than send a Bulgarian notice with English dates in it.
  if (!hasBulgarianLocaleData()) {
    const reason =
      `this runtime has no ${DISPLAY_LOCALE} locale data, so dates would render in English. ` +
      'Run Node with full ICU (the default since v13) or point NODE_ICU_DATA at complete data.';
    for (const candidate of pending) {
      result.failed.push({ eventId: candidate.eventId, reason });
    }
    console.error(`[retention-notice] refusing to send: ${reason}`);
    return result;
  }

  for (const candidate of pending) {
    // An album with no host email cannot be warned, so it must not be stamped
    // — leaving it unstamped is what keeps the sweep from ever deleting it.
    // Reported as failed rather than skipped silently, because it is a data
    // problem somebody needs to fix.
    if (!candidate.hostEmail) {
      result.failed.push({ eventId: candidate.eventId, reason: 'no host email on the event' });
      continue;
    }

    const { subject, text, html } = buildNoticeEmail(candidate);

    try {
      await sendMail({ to: candidate.hostEmail, subject, text, html });
    } catch (err) {
      // Not stamped. The next run will try again, and until one succeeds this
      // album stays undeletable — which is the correct outcome.
      result.failed.push({ eventId: candidate.eventId, reason: errorLabel(err) });
      continue;
    }

    // Only now, and only for this album.
    try {
      await pool.query('UPDATE events SET retention_notified_at = NOW() WHERE id = $1', [candidate.eventId]);
      result.sent.push(candidate.eventId);
    } catch (err) {
      // The mail went out but the stamp did not. Erring toward a duplicate
      // warning on the next run is obviously right: the alternative is an
      // album that can never be deleted, or worse, one deleted without the
      // record showing why it was allowed.
      console.error(
        `[retention-notice] warned ${candidate.slug} but could not record it:`,
        errorLabel(err)
      );
      result.failed.push({ eventId: candidate.eventId, reason: `sent, but stamping failed: ${errorLabel(err)}` });
    }
  }

  return result;
}
