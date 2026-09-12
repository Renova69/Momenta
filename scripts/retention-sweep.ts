/**
 * Album retention maintenance.
 *
 *   npm run retention:report   — recompute expiry dates and report what is due
 *   npm run retention:sweep    — the same, then delete media past the grace period
 *
 * The sweep only deletes when RETENTION_ENFORCED=true is set. Wedding photos are
 * irreplaceable, so removing them is never a side effect of running a report.
 *
 * Run this from cron (daily is plenty), not from the request path.
 */
import { pool } from '../server/lib/db';
import {
  refreshExpiryDates,
  sweepExpiredAlbums,
  GRACE_PERIOD_DAYS,
  RETENTION_NOTICE_DAYS,
} from '../server/lib/retention';
import { formatBytes } from '../server/lib/planLimits';

const enforce = process.env.RETENTION_ENFORCED === 'true';

function table(rows: { slug: string; expiresAt: string; storageBytes: number; photoCount: number; tier: string }[]) {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const row of rows) {
    console.log(
      `  ${row.slug.padEnd(38).slice(0, 38)}  ${row.tier.padEnd(17)}  ` +
        `expired ${row.expiresAt.slice(0, 10)}  ${String(row.photoCount).padStart(5)} photos  ` +
        formatBytes(row.storageBytes).padStart(9)
    );
  }
}

async function main() {
  console.log('[retention] recomputing expiry dates from current plans...');
  const refreshed = await refreshExpiryDates();
  console.log(`[retention] ${refreshed} event(s) evaluated.\n`);

  const result = await sweepExpiredAlbums(enforce);

  console.log(`Approaching or past expiry (still inside the ${GRACE_PERIOD_DAYS}-day grace period):`);
  table(result.expiringSoon);

  console.log(
    `\nPast the grace period but NOT deletable — the host has not been warned ` +
      `(or the warning is less than ${RETENTION_NOTICE_DAYS} days old):`
  );
  table(result.awaitingNotice);
  if (result.awaitingNotice.length > 0) {
    // Why an album is stuck here matters, because the three reasons need
    // different responses and only one of them resolves on its own.
    const bounced = result.awaitingNotice.filter((r) => r.bouncedAt !== null);
    const noAddress = result.awaitingNotice.filter((r) => r.bouncedAt === null && !r.hostEmail);
    const pending = result.awaitingNotice.filter((r) => r.bouncedAt === null && r.hostEmail);

    if (pending.length > 0) {
      console.log(
        `\n  ${pending.length} waiting on a notice. If NOTICE_SEND is not set, nothing is\n` +
          `  being sent and these stay here — which is the intended resting state until\n` +
          `  you mean to enable it. See OPEN_ITEMS.md D1.`
      );
      for (const row of pending.slice(0, 20)) {
        console.log(`    ${(row.hostEmail ?? '').padEnd(34).slice(0, 34)}  ${row.slug}`);
      }
      if (pending.length > 20) console.log(`    ... and ${pending.length - 20} more`);
    }

    if (bounced.length > 0) {
      console.log(
        `\n  ${bounced.length} BLOCKED BY A BOUNCED ADDRESS. These can never be notified and so\n` +
          `  can never be deleted. Nothing here resolves on its own: correct the host's\n` +
          `  email, or \`npm run bounce:clear -- --email <addr>\` once you know it works.`
      );
      for (const row of bounced.slice(0, 20)) {
        console.log(
          `    ${(row.hostEmail ?? '').padEnd(34).slice(0, 34)}  ${row.slug}  ` +
            `bounced ${row.bouncedAt!.slice(0, 10)}`
        );
      }
      if (bounced.length > 20) console.log(`    ... and ${bounced.length - 20} more`);
    }

    if (noAddress.length > 0) {
      console.log(
        `\n  ${noAddress.length} have no host email at all, so cannot be warned or deleted.\n` +
          `  That is a data problem worth fixing rather than a retention one.`
      );
      for (const row of noAddress.slice(0, 20)) console.log(`    ${row.slug}`);
      if (noAddress.length > 20) console.log(`    ... and ${noAddress.length - 20} more`);
    }
  }

  console.log(`\nNotified and past the grace period, eligible for deletion:`);
  table(result.eligible);

  if (!enforce) {
    const total = result.eligible.reduce((sum, c) => sum + c.storageBytes, 0);
    console.log(
      `\n[retention] REPORT ONLY — nothing was deleted. ` +
        `${result.eligible.length} album(s) holding ${formatBytes(total)} are eligible.\n` +
        `[retention] Set RETENTION_ENFORCED=true to delete the eligible ones. Albums awaiting\n` +
        `[retention] notice are never deleted, whatever that flag says.`
    );
  } else {
    console.log(
      `\n[retention] Deleted media for ${result.deleted.length} album(s), freeing ${formatBytes(result.freedBytes)}.`
    );

    if (result.leakedPaths.length > 0) {
      // The rows naming these objects are gone, so nothing in the database can
      // find them again - only `npm run storage:orphans` can. Printed at the
      // end of the run rather than left as a console.warn buried mid-loop,
      // because that is how 164 MB of unreachable objects went unnoticed once
      // already.
      console.error(
        `\n[retention] WARNING — ${result.leakedPaths.length} stored object(s) could not be ` +
          `deleted and are now orphaned:\n` +
          result.leakedPaths.map((path) => `  ${path}`).join('\n') +
          `\n[retention] Run \`npm run storage:orphans\` to confirm, then sweep them.`
      );
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[retention] sweep failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
