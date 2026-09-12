import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// [FIX C-3] Validate critical secrets at startup — crash fast rather than run insecurely
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    '[CONFIG] JWT_SECRET environment variable is required and must be at least 32 characters. ' +
    'Set it in your .env file before starting the server.'
  );
}

// Secrets that ship in this repository, and are therefore public. Both are
// comfortably longer than 32 characters, so the length check above waves them
// straight through — and both are wired up to be used by default: one is
// docker-compose.yml's `${JWT_SECRET:-...}` fallback, the other is the value in
// .env.example that a `cp .env.example .env` leaves behind.
//
// Anyone holding one can mint a valid session token for any account, so in
// production they are worse than no secret at all: the app looks correctly
// configured while every session is forgeable by anyone who has read the repo.
const PUBLICLY_KNOWN_JWT_SECRETS = new Set([
  'wedmoments_jwt_production_secret_key_2026_super_secure',
  'wedmoments_jwt_super_secret_key_2026_change_in_prod',
]);

if (process.env.NODE_ENV === 'production' && PUBLICLY_KNOWN_JWT_SECRETS.has(JWT_SECRET)) {
  throw new Error(
    '[CONFIG] JWT_SECRET is one of the example values committed to this repository, so it is ' +
    'public knowledge and every session token signed with it is forgeable. Generate a real one ' +
    "— `node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"` — and set it " +
    'in the production environment. Refusing to start.'
  );
}

// [FIX C-9] CORS_ORIGIN must be explicitly configured — wildcard '*' is not safe with credentials
const CORS_ORIGIN = process.env.CORS_ORIGIN;
if (!CORS_ORIGIN) {
  console.warn(
    '[CONFIG] CORS_ORIGIN is not set — defaulting to same-origin only. ' +
    'Set CORS_ORIGIN in .env for LAN/production access (e.g. http://192.168.0.35:6500).'
  );
}

// SEC-A3 — `trust proxy` tells Express which hop to read X-Forwarded-For
// from. Unconditionally trusting it (the old default) means a client that
// reaches this process directly — which the shipped docker-compose.yml
// does, with no reverse proxy in front — can put any IP it wants in that
// header and the IP-based rate limiters (server/middleware/rateLimit.ts)
// key on whatever it says. Defaults closed; a real deployment behind a
// reverse proxy or load balancer sets TRUST_PROXY explicitly.
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNumber = Number(raw);
  return Number.isFinite(asNumber) && raw.trim() !== '' ? asNumber : raw;
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
const TRUST_PROXY_IS_SET = (process.env.TRUST_PROXY ?? '').trim() !== '';

// In production this has to be a decision someone actually made, not a default
// nobody noticed. Getting it wrong is silent and serious in both directions:
// left unset behind a proxy, every request appears to come from the proxy, so
// the per-IP limiters in middleware/rateLimit.ts (authLimiter 25/15min,
// uploadLimiter 20/min) throttle all users as one - a single attacker locks out
// every guest at a wedding, and brute-force protection stops working. Set to a
// blanket `true` on a directly-exposed server and any client can spoof
// X-Forwarded-For to pick its own rate-limit identity (SEC-A3).
//
// Neither failure shows up in a health check, so a console.warn is not enough
// protection for a real deployment. Refuse to start instead, matching how
// JWT_SECRET and STORAGE_PROVIDER are handled below. "No proxy" remains a
// perfectly good answer - it just has to be said out loud, as TRUST_PROXY=false.
if (process.env.NODE_ENV === 'production' && !TRUST_PROXY_IS_SET) {
  throw new Error(
    '[CONFIG] TRUST_PROXY must be set explicitly in production. ' +
    'Behind a reverse proxy or load balancer use the number of hops to trust ("1"), or the ' +
    "proxy's IP/CIDR. If this server is exposed directly with nothing in front of it, set " +
    'TRUST_PROXY=false to say so. Refusing to start rather than silently mis-attributing every ' +
    'client IP and breaking the rate limiters.'
  );
}

if (!TRUST_PROXY_IS_SET) {
  console.warn(
    '[CONFIG] TRUST_PROXY is not set — X-Forwarded-For is ignored, so rate limits key on the ' +
    'connecting socket\'s address. If this server sits behind a reverse proxy or load balancer, ' +
    'set TRUST_PROXY (e.g. "1" for one hop, or the proxy\'s IP/CIDR) or every request will appear ' +
    'to come from the proxy itself.'
  );
}

// G6 — createStorageAdapter() (server/lib/storage.ts) falls back to
// LocalStorageAdapter for anything it doesn't recognize as a fully-configured
// 'r2'. On an ephemeral production container filesystem that means a typo'd
// or under-configured STORAGE_PROVIDER loses every wedding photo on the next
// redeploy, with nothing logged — the app looks completely healthy. Crash at
// startup instead, matching how JWT_SECRET is handled above.
const VALID_STORAGE_PROVIDERS = ['local', 'r2'];
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
if (!VALID_STORAGE_PROVIDERS.includes(STORAGE_PROVIDER)) {
  throw new Error(
    `[CONFIG] STORAGE_PROVIDER="${process.env.STORAGE_PROVIDER}" is not recognized ` +
    `(expected "local" or "r2"). Refusing to start rather than silently falling back to ` +
    'local disk storage.'
  );
}
if (STORAGE_PROVIDER === 'r2') {
  const missingR2Vars = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter(
    (key) => !process.env[key]
  );
  if (missingR2Vars.length > 0) {
    throw new Error(
      `[CONFIG] STORAGE_PROVIDER=r2 but missing required credential(s): ${missingR2Vars.join(', ')}. ` +
      'Refusing to start rather than silently falling back to ephemeral local disk storage.'
    );
  }
  // Without R2_PUBLIC_URL, R2StorageAdapter.save() falls back to the private
  // S3-compatible API endpoint (bucket.accountid.r2.cloudflarestorage.com) as
  // the "public" URL. That endpoint requires SigV4-signed requests even for
  // GET, so every photo would upload successfully and then be permanently
  // unloadable in the browser — silent breakage, discovered only when a
  // guest reports a blank gallery. docs/CLOUDFLARE_R2_SETUP_GUIDE.md lists
  // this as one of the 5 required values; enforce that here too.
  if (!process.env.R2_PUBLIC_URL) {
    throw new Error(
      '[CONFIG] STORAGE_PROVIDER=r2 but missing required R2_PUBLIC_URL. ' +
      'Without it, uploaded photos get a private R2 API URL that browsers cannot load. ' +
      'Enable public access on the bucket and set R2_PUBLIC_URL (see docs/CLOUDFLARE_R2_SETUP_GUIDE.md).'
    );
  }
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn(
    '[CONFIG] STRIPE_SECRET_KEY is not set — real checkout is disabled. ' +
    'POST /api/billing/checkout-session will report 503 STRIPE_NOT_CONFIGURED, ' +
    'and the pricing modal falls back to the direct self-serve tier write ' +
    '(server/routes/subscriptions.ts), which hands out paid tiers for free. ' +
    'That fallback closes automatically the moment this key is set. ' +
    'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env to accept real payments.'
  );
}

// Outbound email. Deliberately NOT fail-fast like JWT_SECRET or R2: the app is
// entirely usable without it — guests upload, hosts moderate, nothing breaks.
// What it gates is retention notices, and the retention sweep already refuses
// to delete an album nobody was warned about (migration 024), so an
// unconfigured mailer means "no notices sent, therefore nothing deleted"
// rather than "photos destroyed silently". That is the safe direction, and it
// is why this warns instead of refusing to start.
if (!process.env.SMTP_HOST) {
  console.warn(
    '[CONFIG] SMTP_HOST is not set — no email can be sent. Retention notices ' +
    'therefore cannot go out, and because the retention sweep will not delete an ' +
    'album until its host has been warned (events.retention_notified_at), ' +
    'RETENTION_ENFORCED=true will delete nothing while this is unset. ' +
    'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/MAIL_FROM to enable it.'
  );
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '6501', 10),
  TRUST_PROXY,
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgrespassword@127.0.0.1:6532/wedmoments_db',
  JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'),
  // MED-03/SEC-M5 — a photo pending moderation or still disposable-locked is
  // saved here instead of under UPLOADS_DIR, which server/index.ts serves
  // publicly via express.static with no auth check. Deliberately a sibling
  // directory, never a subdirectory of UPLOADS_DIR, so it is structurally
  // impossible for it to end up under that static mount by accident.
  QUARANTINE_DIR: process.env.QUARANTINE_DIR || path.join(process.cwd(), 'uploads-quarantine'),

  // Storage Provider Settings ('local' | 'r2') — validated above
  STORAGE_PROVIDER,

  // Cloudflare R2 Credentials
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || 'wedmoments-photos',
  R2_PUBLIC_URL: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''),

  // [FIX C-9] Fall back to same-origin if not set (safer than '*')
  CORS_ORIGIN: CORS_ORIGIN || false as string | false,
  MAX_UPLOAD_SIZE_MB: 50,

  // Apply pending SQL migrations on boot. Leave on unless a separate migration
  // step owns the schema (then run `npm run migrate` in that step instead).
  AUTO_MIGRATE: (process.env.AUTO_MIGRATE || 'true').toLowerCase() !== 'false',

  // Public base URL used to build absolute /uploads URLs (set this to your
  // public host when behind a domain or reverse proxy).
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || `http://localhost:${parseInt(process.env.PORT || '6501', 10)}`,

  // In-process FTP server for in-camera background transfer (default off).
  FTP_ENABLED: (process.env.FTP_ENABLED || 'false').toLowerCase() === 'true',
  FTP_PORT: parseInt(process.env.FTP_PORT || '2121', 10),
  FTP_PASV_URL: process.env.FTP_PASV_URL || '',
  FTP_STAGING_DIR: process.env.FTP_STAGING_DIR || path.join(process.cwd(), 'ftp-staging'),
  FTP_TLS_CERT: process.env.FTP_TLS_CERT || '',
  FTP_TLS_KEY: process.env.FTP_TLS_KEY || '',
  // Explicit escape hatch for plaintext FTP in production (local testing
  // against a production build, a trusted wired network). Off by default —
  // see ftpServer.ts, which otherwise refuses to start plaintext FTP in
  // production (SEC-F1).
  FTP_ALLOW_PLAINTEXT: (process.env.FTP_ALLOW_PLAINTEXT || 'false').toLowerCase() === 'true',

  // Stripe billing — deliberately NOT fail-fast like R2/JWT_SECRET above.
  // Unlike storage, the app is fully usable without payments configured: the
  // self-serve tier-write in subscriptions.ts stays available as a fallback
  // (see server/lib/stripe.ts) so local development and demos keep working
  // with no keys at all. Once STRIPE_SECRET_KEY is set, checkout-session
  // creation switches on automatically and that unpaid fallback closes to
  // paid tiers in the same step — no code change needed for either.
  //
  // This value therefore doubles as a security switch, not just a feature
  // flag: setting it is what makes payment mandatory. Set the webhook secret
  // at the same time, or verified events cannot be processed at all.
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  // Real Stripe Price IDs (`price_...`), one per paid tier. Optional, and
  // meaningful as a set: with all three present the webhook derives the
  // purchased tier from the Price the customer actually paid, which is
  // authoritative, and treats the session's `metadata.tier` as a cross-check
  // that must agree. With any of them missing, checkout falls back to ad-hoc
  // `price_data` and the tier comes from metadata alone — workable, but
  // metadata is editable from the Stripe Dashboard, so it is a weaker claim.
  // See server/lib/stripePlans.ts.
  STRIPE_PRICE_CELEBRATION_PASS: process.env.STRIPE_PRICE_CELEBRATION_PASS || '',
  STRIPE_PRICE_DELUXE_KEEPSAKE: process.env.STRIPE_PRICE_DELUXE_KEEPSAKE || '',
  STRIPE_PRICE_PRO_PLANNER: process.env.STRIPE_PRICE_PRO_PLANNER || '',

  // SMTP, rather than a provider SDK. This app is self-hosted from its own
  // docker-compose, and SMTP is the one interface every provider speaks —
  // SES, Postmark, Mailgun, Resend, or a relay on the same network — so the
  // operator is not locked into whichever vendor happened to be fashionable
  // when this was written.
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  // Implicit TLS (port 465). Port 587 upgrades with STARTTLS instead, which
  // nodemailer does on its own, so this stays false for the common case.
  SMTP_SECURE: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASSWORD: process.env.SMTP_PASSWORD || '',
  // The From header. A bare address works; "Name <addr>" is friendlier in an
  // inbox and is what most providers expect to see.
  MAIL_FROM: process.env.MAIL_FROM || 'WedMoments <noreply@wedmoments.bg>',
  // Where a host is sent to manage their album. Used in notice emails, which
  // are useless without a link back.
  APP_PUBLIC_URL: (process.env.APP_PUBLIC_URL || '').replace(/\/+$/, '') ||
    (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') ||
    `http://localhost:${parseInt(process.env.PORT || '6501', 10)}`,

  // How long a Pro Planner subscription keeps its tier after Stripe marks it
  // `past_due`. Stripe runs its own dunning retries for roughly this long, and
  // cutting a paying customer off mid-wedding because a card expired is worse
  // than carrying them for a week. See scripts/subscription-grace-sweep.ts.
  SUBSCRIPTION_GRACE_DAYS: parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '7', 10),
};
