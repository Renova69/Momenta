/**
 * Retention notices — warn hosts before their album is deleted.
 *
 *   npm run notify:report   — list albums due a warning, send nothing
 *   npm run notify:send     — actually send, and record who was warned
 *
 * This is the piece that makes retention enforcement possible at all. The
 * sweep refuses to delete an album whose `events.retention_notified_at` is
 * unset (migration 024), and this is the only thing that sets it — so until
 * this has run successfully against an album, that album cannot be deleted no
 * matter what RETENTION_ENFORCED says.
 *
 * Sending is opt-in for the same reason the sweep's deletion is: it has a real
 * effect on customers, and should never be a side effect of running a report.
 *
 * Run before the retention sweep, not after. An album warned today is not
 * deletable for another RETENTION_NOTICE_DAYS regardless, so ordering within a
 * single run does not matter for safety — but a notice that goes out after the
 * sweep has already looked is a day wasted.
 */
import { pool } from '../server/lib/db';
import { isMailerConfigured, verifyMailer } from '../server/lib/mailer';
import {
  sendRetentionNotices,
  isPubliclyReachableUrl,
  hasBulgarianLocaleData,
  NOTICE_LEAD_DAYS,
} from '../server/lib/retentionNotice';
import { CONFIG } from '../server/lib/config';
import { RETENTION_NOTICE_DAYS, GRACE_PERIOD_DAYS } from '../server/lib/retention';

const send = process.env.NOTICE_SEND === 'true';

async function main(): Promise<void> {
  console.log('');
  console.log(
    `Retention notices — warning ${NOTICE_LEAD_DAYS} day(s) before expiry, ` +
      `then ${GRACE_PERIOD_DAYS} days grace, then deletable once the notice is ` +
      `${RETENTION_NOTICE_DAYS} days old`
  );
  console.log(send ? 'Mode: SENDING' : 'Mode: report only (set NOTICE_SEND=true to send)');
  console.log('');

  if (send) {
    // Checked before SMTP, because it is the likelier mistake and the more
    // damaging one: a broken mailer sends nothing, while a LAN address sends
    // every host a link they cannot open.
    const urlCheck = isPubliclyReachableUrl(CONFIG.APP_PUBLIC_URL);
    if (!urlCheck.ok) {
      console.error(`[notice] ${urlCheck.reason}`);
      console.error('[notice] Nothing was sent and nothing was marked as notified.');
      process.exitCode = 1;
      return;
    }
    if (urlCheck.reason) console.warn(`[notice] ${urlCheck.reason}`);

    if (!hasBulgarianLocaleData()) {
      console.error('[notice] This runtime has no bg-BG locale data — dates would render in English.');
      console.error('[notice] Run Node with full ICU (the default since v13), or set NODE_ICU_DATA.');
      console.error('[notice] Nothing was sent and nothing was marked as notified.');
      process.exitCode = 1;
      return;
    }

    if (!isMailerConfigured()) {
      console.error('[notice] SMTP_HOST is not set — cannot send. Nothing was marked as notified.');
      process.exitCode = 1;
      return;
    }
    try {
      // One clear failure here beats the same failure repeated per host.
      await verifyMailer();
    } catch (err) {
      console.error('[notice] SMTP connection failed:', err instanceof Error ? err.message : err);
      console.error('[notice] Nothing was sent and nothing was marked as notified.');
      process.exitCode = 1;
      return;
    }
  }

  const result = await sendRetentionNotices({ send });

  if (result.pending.length === 0) {
    console.log('  (no albums are due a warning)');
    console.log('');
    return;
  }

  for (const candidate of result.pending) {
    const status = result.sent.includes(candidate.eventId)
      ? 'sent'
      : result.failed.find((f) => f.eventId === candidate.eventId)?.reason ?? (send ? 'skipped' : 'due');
    console.log(
      `  ${candidate.slug.padEnd(34).slice(0, 34)}  expires ${candidate.expiresAt.slice(0, 10)}  ` +
        `${(candidate.hostEmail ?? '(no host email)').padEnd(34).slice(0, 34)}  ${status}`
    );
  }

  console.log('');
  if (!send) {
    console.log(
      `[notice] REPORT ONLY — ${result.pending.length} album(s) are due a warning. ` +
        'Nothing was sent, and nothing was marked as notified.'
    );
    console.log('[notice] Set NOTICE_SEND=true to send them.');
  } else {
    console.log(`[notice] Sent ${result.sent.length}, failed ${result.failed.length}.`);
    if (result.failed.length > 0) {
      console.log('[notice] Albums that failed were NOT marked as notified, so they stay undeletable');
      console.log('[notice] and will be retried on the next run. That is the intended behaviour.');
      process.exitCode = 1;
    }
  }
  console.log('');
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error('[notice] failed:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
