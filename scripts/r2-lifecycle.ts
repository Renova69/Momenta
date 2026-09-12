/**
 * R2 bucket lifecycle policy.
 *
 *   npm run r2:lifecycle          — show the bucket's current rules
 *   npm run r2:lifecycle:apply    — write the policy below
 *
 * A backstop, not a retention mechanism. Album retention is decided per plan in
 * server/lib/planLimits.ts and carried out by the retention sweep, which knows
 * what tier an album is on. This exists for the case that machinery stops
 * running and nobody notices.
 *
 * ============================================================
 * Why there is NO age rule on `events/`
 * ============================================================
 *
 * R2 lifecycle rules delete by object age, optionally narrowed by key prefix.
 * Object keys are `events/{eventId}/...` and carry no plan information, while
 * retention is per tier: 7 days on Free, 90 on Celebration Pass, 365 on Deluxe
 * Keepsake, and **indefinite on Pro Planner** (`retentionDays: null`).
 *
 * So any age rule over `events/` eventually deletes photographs a Pro Planner
 * customer is paying to keep forever, and no prefix can exclude them, because
 * the tier is not in the key. A blind age rule there would not be a backstop,
 * it would be a slow product failure that nobody notices until a customer asks
 * where their wedding went.
 *
 * Changing that needs a product decision — that Pro Planner retention is not
 * truly indefinite — or a key scheme that puts the tier in the path. Neither is
 * something a lifecycle script should decide on its own.
 *
 * ============================================================
 * What IS safe, and why
 * ============================================================
 *
 * `quarantine/` holds photos that are pending moderation or waiting for a
 * disposable-camera reveal (MED-03/SEC-M5). It is a transient state: an object
 * is either promoted out of it or deleted with its album. Anything still
 * sitting there long after the longest finite retention window plus its grace
 * period (365 + 30) is abandoned by any reasonable reading.
 *
 * 400 days is past that boundary with room to spare. The one case it can still
 * catch is a photo left pending moderation on a Pro Planner album for over a
 * year — a host who has had thirteen months to approve it. That is an
 * acceptable trade against the alternative, which is orphaned objects
 * accumulating in a bucket forever with nothing to stop them: 446 of them had
 * already done exactly that before the orphan sweep's quarantine blind spot
 * was fixed.
 *
 * Incomplete multipart uploads are covered by Cloudflare's own default rule,
 * which this policy preserves rather than replacing — PutBucketLifecycle
 * overwrites the entire configuration, so anything omitted here is dropped.
 */
import {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { CONFIG } from '../server/lib/config';

/** Days an object may sit under `quarantine/` before it is considered abandoned. */
const QUARANTINE_MAX_AGE_DAYS = 400;

/** Days before an unfinished multipart upload is aborted (Cloudflare's default). */
const MULTIPART_ABORT_DAYS = 7;

const apply = process.env.LIFECYCLE_APPLY === 'true';

const POLICY = [
  {
    ID: 'Default Multipart Abort Rule',
    Status: 'Enabled' as const,
    Filter: { Prefix: '' },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: MULTIPART_ABORT_DAYS },
  },
  {
    ID: 'Abandoned quarantine objects',
    Status: 'Enabled' as const,
    Filter: { Prefix: 'quarantine/' },
    Expiration: { Days: QUARANTINE_MAX_AGE_DAYS },
  },
];

function client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${CONFIG.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: CONFIG.R2_ACCESS_KEY_ID,
      secretAccessKey: CONFIG.R2_SECRET_ACCESS_KEY,
    },
  });
}

type RulesResult =
  | { ok: true; rules: unknown[] }
  | { ok: false; reason: 'forbidden' | 'error'; detail: string };

/**
 * Read the bucket's rules, distinguishing "there are none" from "we are not
 * allowed to look".
 *
 * A blanket catch returning `[]` conflated those two, and the difference is the
 * whole answer here: the app's own R2 token is deliberately Object Read & Write
 * only, and bucket lifecycle configuration requires Admin. So the honest result
 * of running this with the runtime credentials is 403 — reporting that as "no
 * rules configured" would invite someone to apply a policy that then silently
 * fails, or worse, to believe a backstop exists when it does not.
 */
async function currentRules(s3: S3Client): Promise<RulesResult> {
  try {
    const res = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: CONFIG.R2_BUCKET_NAME }));
    return { ok: true, rules: res.Rules ?? [] };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === 'AccessDenied' || status === 403) {
      return { ok: false, reason: 'forbidden', detail: 'Access Denied (403)' };
    }
    // R2 answers NoSuchLifecycleConfiguration when a bucket genuinely has none.
    if (name === 'NoSuchLifecycleConfiguration' || status === 404) {
      return { ok: true, rules: [] };
    }
    return { ok: false, reason: 'error', detail: `${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const PERMISSION_NOTE =
  'The runtime R2 token is Object Read & Write, which is the right scope for an\n' +
  'application: it can put, get and delete objects, and cannot reconfigure the\n' +
  'bucket. Lifecycle rules need Admin Read & Write. Rather than widening the\n' +
  "app's token, set this policy in the Cloudflare dashboard (R2 > bucket >\n" +
  'Settings > Object lifecycle rules), or run this script once with a separate\n' +
  'admin token that is not the one the app carries.';

async function main(): Promise<void> {
  if (!CONFIG.R2_ACCOUNT_ID || !CONFIG.R2_ACCESS_KEY_ID || !CONFIG.R2_SECRET_ACCESS_KEY) {
    console.error('[r2-lifecycle] R2 is not configured — nothing to do.');
    process.exit(1);
  }

  const s3 = client();
  console.log(`[r2-lifecycle] bucket: ${CONFIG.R2_BUCKET_NAME}`);

  const before = await currentRules(s3);
  console.log('\nCurrent rules:');
  if (before.ok) {
    console.log(before.rules.length === 0 ? '  (none)' : JSON.stringify(before.rules, null, 2));
  } else {
    console.log(`  (could not read — ${before.detail})`);
  }

  console.log('\nPolicy in this file:');
  console.log(JSON.stringify(POLICY, null, 2));

  if (!before.ok && before.reason === 'forbidden') {
    console.log(`\n[r2-lifecycle] These credentials cannot manage lifecycle rules.\n\n${PERMISSION_NOTE}`);
    if (apply) process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(
      '\n[r2-lifecycle] REPORT ONLY — the bucket was not changed.\n' +
        '[r2-lifecycle] Run `npm run r2:lifecycle:apply` to write the policy above.\n' +
        '[r2-lifecycle] Note it REPLACES the whole configuration, so anything on the bucket\n' +
        '[r2-lifecycle] that is not in this file would be dropped.'
    );
    return;
  }

  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: CONFIG.R2_BUCKET_NAME,
      LifecycleConfiguration: { Rules: POLICY },
    })
  );

  const after = await currentRules(s3);
  console.log('\n[r2-lifecycle] Applied. Bucket now reports:');
  console.log(after.ok ? JSON.stringify(after.rules, null, 2) : `  (could not read back — ${after.detail})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[r2-lifecycle] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
