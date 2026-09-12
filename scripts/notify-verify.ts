/**
 * Check the notice mailer before trusting it with customers.
 *
 *   npm run notify:verify                        checks + prints the email
 *   npm run notify:verify -- --to you@you.bg     also sends one to that address
 *
 * Every other path into this system either sends nothing or sends to real
 * hosts. `notify:report` deliberately does not touch SMTP — it only reads the
 * database — so before this existed the first proof that the mail
 * configuration worked would have been a live send to a customer, and a
 * misconfiguration would have been discovered by its absence.
 *
 * Touches no database rows. It never calls sendRetentionNotices, so nothing can
 * be stamped as notified here and no album can be brought closer to deletion by
 * running it.
 */
import { CONFIG } from '../server/lib/config';
import { errorLabel } from '../server/lib/errors';
import { isMailerConfigured, verifyMailer, sendMail } from '../server/lib/mailer';
import {
  buildNoticeEmail,
  isPubliclyReachableUrl,
  hasBulgarianLocaleData,
  type NoticeCandidate,
} from '../server/lib/retentionNotice';

/** `--to addr`, or `--to=addr`. Absent means check and preview, send nothing. */
export function parseToAddress(argv: string[]): string | null {
  const equals = argv.find((a) => a.startsWith('--to='));
  if (equals) return equals.slice('--to='.length).trim() || null;

  const index = argv.indexOf('--to');
  if (index === -1) return null;

  const value = argv[index + 1];
  // `--to` with nothing after it is a mistake, not a request to send nowhere.
  if (value === undefined || value.startsWith('-')) return null;
  return value.trim() || null;
}

/** Never print a password, not even a masked one of the right length. */
export function maskSecret(value: string): string {
  return value ? '(set)' : '(empty)';
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** False for things that are poor practice rather than broken. */
  fatal: boolean;
}

export interface CheckDeps {
  configured: () => boolean;
  urlCheck: () => { ok: boolean; reason?: string };
  locale: () => boolean;
  mailFrom: string;
}

/**
 * Everything that can be decided without opening a socket.
 *
 * Separated from the connection test so it can be exercised without SMTP, and
 * so a run reports every problem at once rather than stopping at the first.
 */
export function staticChecks(deps: CheckDeps): Check[] {
  const checks: Check[] = [];

  checks.push({
    name: 'SMTP_HOST',
    ok: deps.configured(),
    detail: deps.configured() ? 'set' : 'not set — no mail can be sent at all',
    fatal: true,
  });

  const from = deps.mailFrom.trim();
  const fromOk = from.includes('@');
  checks.push({
    name: 'MAIL_FROM',
    ok: fromOk,
    detail: fromOk
      ? from
      : `"${from}" does not look like an address — it must be on a domain verified with your provider`,
    fatal: true,
  });

  const url = deps.urlCheck();
  checks.push({
    name: 'APP_PUBLIC_URL',
    ok: url.ok,
    // A plain-http public host passes with a reason attached; that is a
    // warning, not a failure.
    detail: url.reason ?? CONFIG.APP_PUBLIC_URL,
    fatal: !url.ok,
  });

  const locale = deps.locale();
  checks.push({
    name: 'bg-BG locale data',
    ok: locale,
    detail: locale
      ? 'present — dates render in Bulgarian'
      : 'missing — dates would silently render in English',
    fatal: true,
  });

  return checks;
}

/** A plausible album, so the preview shows what a host would actually read. */
export function previewCandidate(): NoticeCandidate {
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  return {
    eventId: '00000000-0000-0000-0000-000000000000',
    slug: 'primer-na-albuma-2026',
    title: 'Сватбата на Мария и Иван',
    hostEmail: 'primer@example.com',
    expiresAt: expires.toISOString(),
  };
}

function report(checks: Check[]): boolean {
  let failed = false;
  for (const check of checks) {
    const mark = check.ok ? 'ok  ' : check.fatal ? 'FAIL' : 'warn';
    console.log(`  [${mark}] ${check.name.padEnd(18)} ${check.detail}`);
    if (!check.ok && check.fatal) failed = true;
  }
  return failed;
}

async function main(): Promise<void> {
  const to = parseToAddress(process.argv.slice(2));

  console.log('');
  console.log('Notice mailer verification');
  console.log('');
  console.log('Configuration:');
  console.log(`  host       ${CONFIG.SMTP_HOST || '(not set)'}:${CONFIG.SMTP_PORT}`);
  console.log(`  secure     ${CONFIG.SMTP_SECURE} ${CONFIG.SMTP_SECURE ? '(implicit TLS)' : '(STARTTLS)'}`);
  console.log(`  user       ${CONFIG.SMTP_USER || '(none — unauthenticated relay)'}`);
  console.log(`  password   ${maskSecret(CONFIG.SMTP_PASSWORD)}`);
  console.log('');

  console.log('Checks:');
  let failed = report(
    staticChecks({
      configured: isMailerConfigured,
      urlCheck: () => isPubliclyReachableUrl(CONFIG.APP_PUBLIC_URL),
      locale: hasBulgarianLocaleData,
      mailFrom: CONFIG.MAIL_FROM,
    })
  );

  // Only worth attempting once the host is known to be configured.
  if (isMailerConfigured()) {
    try {
      await verifyMailer();
      console.log('  [ok  ] SMTP connection    connected and authenticated');
    } catch (err) {
      console.log(`  [FAIL] SMTP connection    ${errorLabel(err)}`);
      failed = true;
    }
  }

  const { subject, text } = buildNoticeEmail(previewCandidate());
  console.log('');
  console.log('This is what a host receives:');
  console.log('');
  console.log(`  Subject: ${subject}`);
  console.log('');
  for (const line of text.split('\n')) console.log(`  ${line}`);
  console.log('');

  if (!to) {
    console.log('No --to given, so nothing was sent. Add --to you@example.com to send this once.');
    console.log('');
    if (failed) process.exitCode = 1;
    return;
  }

  if (failed) {
    console.error(`Not sending to ${to} — fix the failures above first.`);
    console.log('');
    process.exitCode = 1;
    return;
  }

  try {
    // The body is exactly what a host would get, so this is a true preview.
    // Only the subject is marked, so that a mistyped address does not leave a
    // stranger with what reads like a genuine warning about their photographs.
    await sendMail({ to, subject: `[ТЕСТ] ${subject}`, text, html: buildNoticeEmail(previewCandidate()).html });
    console.log(`Sent one test message to ${to}.`);
    console.log('Check it arrived, and that it did not land in spam — that is what SPF/DKIM/DMARC decide.');
  } catch (err) {
    console.error(`Sending to ${to} failed: ${errorLabel(err)}`);
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((err) => {
  console.error('[notify:verify] failed:', err);
  process.exit(1);
});
