# Repo Audit — WedMoments

**Date:** 11 September 2026 · **Remediation pass:** 12 September 2026 (§12, §13)
**Method:** `repo-audit` skill (`~/.claude/skills/repo-audit/SKILL.md`), hard rules retained, section
plan adapted — see "Deviation from the skill spec" below.
**Scope:** whole repository at `C:\dev\Wedding_album`.

---

## Rules this document was written under

Taken verbatim from the skill, and kept because they are what makes an audit worth reading:

1. **Cite everything.** Every factual claim ends in `path/to/file.ts:LINE` with a real line number.
   No citation → the claim is invalid → it is omitted or marked `UNVERIFIED`.
2. **No speculation.** No "probably", "likely", "seems", "typically", "should be". Anything not
   established by reading goes to §12 as an open question.
3. **No fabrication.** No invented module names, function names, paths, line numbers, env vars or
   commands.
4. **Read before claiming.** No file is described that was not opened with the Read tool during the
   audit session.
5. **Fail loudly.** A section that cannot be filled with cited evidence says so, and lists what was
   inspected, rather than guessing.

### Deviation from the skill spec

The skill's Required Reading Order names twelve files. **All twelve are absent from this
repository**, verified by existence check:

```
MISSING  CLAUDE.md
MISSING  graphify-out/GRAPH_REPORT.md
MISSING  graphify-out/wiki/index.md
MISSING  MAIN.md
MISSING  MAIN_FEATURES.md
MISSING  CODING_ROADMAP.md
MISSING  HOW_TO.md
MISSING  apps/backend/src/app.module.ts
MISSING  apps/backend/src/main.ts
MISSING  apps/backend/prisma/schema.prisma
MISSING  apps/frontend/src/App.tsx
MISSING  apps/frontend/vite.config.js
```

The skill is written for a NestJS + Prisma monorepo with `apps/backend` and `apps/frontend`. This
repository is Express 5 + raw SQL over `pg` + a Vite React SPA, all at the root. Its stop condition
("if any required file is missing, STOP and report which one") was reported before proceeding.
Sections 2, 4, 5 and 7 are therefore rewritten against the actual stack; the hard rules above are
unchanged.

---

## 1. Repo Map

### Top-level directories

| Path | Purpose | Citation |
|---|---|---|
| `server/` | Express API. 40 TypeScript files. | `server/index.ts:23` |
| `server/routes/` | 10 routers, mounted under `/api/*` | `server/index.ts:112-120` |
| `server/lib/` | db, config, storage, retention, mailer, stripe, validation | `server/index.ts:7-21` |
| `server/middleware/` | auth, rateLimit, tierGate, validate, uuid | `server/middleware/auth.ts:107` |
| `server/ws/` | event-scoped WebSocket manager | `server/ws/wsServer.ts:54` |
| `server/ftp/` | in-process FTP server for in-camera transfer | `server/index.ts:166` |
| `src/` | React 18 SPA. 76 TypeScript/TSX files. | `package.json:7` |
| `shared/` | code shared by client and server (slug transliteration) | `server/lib/storage.ts:8` |
| `database/migrations/` | 25 sequential `.sql` migrations | `database/migrations/025_email_bounces.sql:22` |
| `scripts/` | 20 operational CLI entry points | `package.json:13-33` |
| `tests/` | 92 unit specs, 1 e2e, 1 integration, 1 helper | `package.json:35,39` |
| `docs/` | 15 reference documents | `ls docs/` |

### Files at root that are not application files

Three entries at the repository root are debris from earlier tooling sessions, not source:

- **`617`** — 2421 bytes. A captured Claude Code hook-event JSON payload, beginning
  `{"session_id":"05c56139-1526-4ff1-acbb-a89a6e667198", … "hook_event_name":"PostToolUse"}`. It
  contains the stdout of a `Bash` call that inspected `server/routes/events.ts`.
- **`{{.Destination}}`** — 423 bytes. A shell fragment saved as a filename by a mis-quoted Go
  template redirect; its content begins
  `"=== where the volume lives ==="; docker volume inspect wedmoments_uploads_data --format '{{.Mountpoint}}'`.
- **`1`** — 0 bytes, created 11 Sep 12:58.

None is referenced by `package.json`, `Dockerfile`, `docker-compose.yml` or `vercel.json`.

### `server.ts` at root

`server.ts` is two lines and forwards to the real entry point:

```ts
// Root entry point forwarding to modular server architecture
import './server/index';
```
(`server.ts:1-2`)

No reference to `server.ts` appears in `package.json`, `Dockerfile`, `docker-compose.yml` or
`vercel.json`. The entry point actually used is `server/index.ts` (`package.json:11`).

### Source files by size

`find server src shared scripts -name '*.ts' -o -name '*.tsx' | xargs wc -l`, 26 153 lines total:

```
1331  src/i18n/index.ts
1067  server/routes/events.ts
1009  server/routes/photos.ts
 986  src/components/host/HostDashboard.tsx
 694  src/components/camera/CameraCaptureModal.tsx
 578  src/App.tsx
 536  src/components/host/QRCanvasStudio.tsx
 528  src/components/home/LandingHomePage.tsx
 495  server/routes/billingWebhook.ts
 447  server/lib/storage.ts
 446  scripts/maintenance-scheduler.ts
 422  server/ws/wsServer.ts
 418  src/components/home/PublicWeddingsShowcase.tsx
 397  src/components/layout/Navbar.tsx
 387  src/components/projector/LiveProjectorScreen.tsx
 383  src/components/audio/AudioGuestbook.tsx
 375  server/routes/auth.ts
 353  src/context/AppContext.tsx
 342  server/middleware/tierGate.ts
 342  server/lib/retentionNotice.ts
 339  server/lib/retention.ts
 321  src/components/gallery/PhotoCard.tsx
 320  src/components/host/HostAuthPage.tsx
 315  src/services/photoService.ts
```

Two application files exceed the 800-line ceiling in the project's own coding standards:
`server/routes/events.ts` (1067) and `server/routes/photos.ts` (1009). `src/i18n/index.ts` (1331) is
a translation table rather than logic.

> **Superseded 12 September 2026.** Both route files have since been split (§13); the largest server
> file is now `server/routes/events/crud.ts` at 588 lines. The listing above is kept as the reading
> that prompted the change. `src/components/host/HostDashboard.tsx` (986) was overlooked here and
> also exceeds the ceiling.

---

## 2. Backend Architecture

### Entry point and boot order

`server/index.ts`, in order:

| Step | What | Line |
|---|---|---|
| 1 | `app.set('trust proxy', CONFIG.TRUST_PROXY)` | `:29` |
| 2 | `wsManager.init(server)` | `:32` |
| 3 | create `UPLOADS_DIR` if absent | `:35-37` |
| 4 | parse comma-separated CORS origins | `:40-42` |
| 5 | `helmet(...)` with an explicit CSP | `:63-91` |
| 6 | `cors({ origin: corsOrigin, credentials: true })` | `:93` |
| 7 | **Stripe webhook with `express.raw()`** | `:100` |
| 8 | `express.json()` / `express.urlencoded()` | `:102-103` |
| 9 | `express.static` on `/uploads` | `:106` |
| 10 | global `apiLimiter` on `/api` | `:109` |
| 11 | routers | `:112-120` |
| 12 | `/api/health` | `:123-130` |
| 13 | SPA static + history fallback if `dist/` exists | `:133-142` |
| 14 | run migrations, then `server.listen` | `:146-167` |

Step 7 before step 8 is load-bearing and documented as such: Stripe signature verification needs the
exact raw request bytes, and moving the route after `express.json()` would make every webhook call
fail verification (`server/index.ts:95-99`).

Migrations run at boot when `AUTO_MIGRATE` is enabled, and a migration failure calls
`process.exit(1)` rather than serving a half-migrated schema (`server/index.ts:147-157`).

### Router mount table

| Mount | Router | Line |
|---|---|---|
| `/api/billing/webhook` | `handleStripeWebhook` (raw body) | `server/index.ts:100` |
| `/api/auth` | `authRouter` | `server/index.ts:112` |
| `/api/events` | `eventsRouter` | `server/index.ts:113` |
| `/api/photos` | `photosRouter` | `server/index.ts:114` |
| `/api` | `questsRouter` | `server/index.ts:115` |
| `/api/audio` | `audioRouter` | `server/index.ts:116` |
| `/api/guests` | `guestsRouter` | `server/index.ts:117` |
| `/api/ingest` | `ingestRouter` | `server/index.ts:118` |
| `/api/subscriptions` | `subscriptionsRouter` | `server/index.ts:119` |
| `/api/billing` | `billingRouter` | `server/index.ts:120` |

### Endpoint inventory

Every route handler declaration found by Grep across `server/routes/`:

**auth** — `POST /register` (`auth.ts:39`), `POST /login` (`:172`), `GET /me` (`:285`),
`PUT /me` (`:327`), `POST /logout` (`:363`).

**events** — `GET /slug/:slug` (`events.ts:135`), `GET /showcase/feed` (`:160`), `POST /` (`:235`),
`GET /` (`:368`), `GET /:id` (`:388`), `PUT /:id` (`:406`),
`POST /:id/guest-sessions/reset` (`:572`), `DELETE` (`:632`), `GET /:id/usage` (`:700`),
`POST` (`:737`), `GET /:id/qr-config` (`:770`), `PUT` (`:806`), `POST` (`:871`), `GET` (`:898`).

**photos** — `GET /` (`photos.ts:179`), `GET /:id/preview` (`:318`), `POST /` (`:353`),
`POST /:id/like` (`:722`), `POST` (`:786`), `POST` (`:854`), `POST /:id/status` (`:927`),
`DELETE /:id` (`:970`).

**quests** — `GET /events/:id/quests` (`quests.ts:42`), `POST` (`:73`),
`DELETE /quests/:id` (`:112`), `POST` (`:138`).

**guests** — `POST /` (`guests.ts:29`), `GET /` (`:99`).

**ingest** — `POST /keys` (`ingest.ts:51`), `GET /keys` (`:82`), `DELETE /keys/:id` (`:111`),
`POST /:eventId/photos` (`:138`).

**audio** — `POST /` (`audio.ts:37`), `GET /` (`:175`).

**subscriptions** — `POST /upgrade` (`subscriptions.ts:32`).

**billing** — `POST` (`billing.ts:93`), `POST /portal-session` (`billing.ts:191`).

### Configuration surface

`server/lib/config.ts:165-266` exports a single frozen-by-convention `CONFIG` object. Notable
entries and their defaults:

| Key | Default | Line |
|---|---|---|
| `PORT` | `6501` | `:166` |
| `DATABASE_URL` | local Postgres on `:6532` | `:168` |
| `JWT_EXPIRES_IN` | `7d` | `:170` |
| `UPLOADS_DIR` | `<cwd>/uploads` | `:171` |
| `QUARANTINE_DIR` | `<cwd>/uploads-quarantine` | `:177` |
| `MAX_UPLOAD_SIZE_MB` | `50` | `:191` |
| `AUTO_MIGRATE` | on unless `"false"` | `:195` |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | `:199` |
| `FTP_ENABLED` | `false` | `:202` |
| `FTP_ALLOW_PLAINTEXT` | `false` | `:212` |
| `SMTP_PORT` | `587` | `:246` |
| `SMTP_SECURE` | `false` | `:249` |
| `MAIL_FROM` | `WedMoments <noreply@wedmoments.bg>` | `:254` |
| `APP_PUBLIC_URL` | falls back to `PUBLIC_BASE_URL`, then localhost | `:257-259` |
| `SUBSCRIPTION_GRACE_DAYS` | `7` | `:265` |

`QUARANTINE_DIR` is deliberately a **sibling** of `UPLOADS_DIR`, never a subdirectory, so it is
structurally impossible for a quarantined file to fall under the public `express.static` mount
(`server/lib/config.ts:172-177`).

---

## 3. Frontend Architecture

### Routing

Routing is a hand-rolled `AppRouter` class over `history.pushState`, not React Router
(`src/router/index.ts:9`). Routes parsed by `parseUrl`:

| Pattern | Resulting view | Line |
|---|---|---|
| `/e/:slug/(tv\|projector)` | `projector` | `:35-38` |
| `/e/:slug/quests` | `guest`, subTab `quests` | `:41-44` |
| `/e/:slug/audio` | `guest`, subTab `audio` | `:47-50` |
| `/e/:slug/ingest` | `ingest` | `:53-56` |
| `/e/:slug` | `guest`, subTab `feed` | `:59-62` |
| `/host`, `/dashboard` | `host` | `:65-67` |
| `/pricing` | `pricing` | `:70-72` |
| `?event=slug` (legacy) | view from `?view=` | `:75-82` |
| `/` or `''` | `guest`, subTab `feed` | `:85-87` |
| anything else | `host` | `:89` |

`navigate()` accepts `{ replace: true }` so a live preview updating on each keystroke does not push a
history entry per character (`src/router/index.ts:133-140`).

`hostReturnUrl()` builds the Stripe return URL from the app's routing rather than from
`window.location.pathname`, because a host commonly opens the pricing modal from `/e/:slug` — their
own album's guest view — and deriving the return URL from that path dropped them back on the guest
page after paying (`src/router/index.ts:158-183`).

### State

A single `AppProvider` context owns event, guests, currentGuest, photos, quests, audio entries and QR
config (`src/context/AppContext.tsx:74-80`). Every one is initialised from `storageService`, i.e.
localStorage first rather than server first. The context's declared surface is at
`src/context/AppContext.tsx:20-70`.

### Auth token storage

The host JWT lives in `localStorage` under the key `wedmoments_host_token`, read or written in five
places:

- `src/api/apiClient.ts:48`
- `src/services/authService.ts:221`
- `src/services/offlineQueueService.ts:195`
- `src/services/realtimeSocket.ts:31`
- `src/services/storageSyncService.ts:169,175`

---

## 4. Data Model

### Enums

`photo_status` — `pending | approved | rejected | featured`
(`database/migrations/001_initial_schema.sql:14`)
`canvas_size_type` — `A2 | A3 | A4 | TABLE_CARD | SQUARE_BANNER` (`:20`)
`frame_style_type` — `minimal_gold | floral_vintage | modern_clean | boho_arch` (`:26`)

### Tables in the initial schema

| Table | Lines |
|---|---|
| `events` | `001_initial_schema.sql:34-51` |
| `guests` | `:59-68` |
| `scavenger_quests` | `:76-85` |
| `photos` | `:92-109` |
| `photo_likes` | `:120-126` |
| `photo_comments` | `:133-139` |
| `guest_quest_completions` | `:146-153` |
| `audio_guestbook` | `:160-168` |
| `qr_canvas_configs` | `:175-185` |

### Tables added by later migrations

`users` and `subscriptions` (`003_host_accounts_and_subscriptions.sql`), `stripe_webhook_events`
(`017_stripe_webhook_events.sql`), `event_deletions` (`024_retention_notice_and_event_deletion.sql`),
`email_bounces` (`025_email_bounces.sql:22-37`).

### Relations actually declared

```
events ─┬─< guests ─┬─< photos ─┬─< photo_likes
        │           │           └─< photo_comments
        │           └─< guest_quest_completions >── scavenger_quests
        ├─< scavenger_quests ─< photos (quest_id, ON DELETE SET NULL)
        ├─< audio_guestbook
        └─< qr_canvas_configs

email_bounces  (PRIMARY KEY email; no foreign key —
                joined on lower(events.host_email))
```

Every event-owned table cascades on delete (`001_initial_schema.sql:61,78,94,122,135,148,162,177`).
`photos.quest_id` is the one exception, `ON DELETE SET NULL` (`:96`).

### Triggers

- `update_updated_at_column()` on `events` and `qr_canvas_configs` (`:200-208`)
- `update_photo_likes_count()` — `AFTER INSERT OR DELETE ON photo_likes`, with a
  `GREATEST(0, likes_count - 1)` floor (`:211-226`)
- `update_photo_comments_count()` — same shape for comments (`:229-244`)

### Migration inventory

25 files, `001` through `025`:

```
001_initial_schema                       014_qr_frame_styles
002_seed_data                            015_photo_reactions
003_host_accounts_and_subscriptions      016_stripe_billing
004_fix_constraints_and_indexes          017_stripe_webhook_events
005_performance_and_fk_cleanup           018_subscription_grace
006_pro_photographer_ingest              019_session_revocation
007_originals_and_demo_accounts          020_storage_trigger_bulk_purge_guard
008_storage_accounting_and_retention     021_photos_is_quarantined
009_subscription_and_slug_integrity      022_event_public_showcase_optin
010_storage_bytes_check_constraint       023_guest_token_revocation
011_host_delete_cascade                  024_retention_notice_and_event_deletion
012_guest_cascade_indexes                025_email_bounces
013_qr_center_icon
```

---

## 5. Critical Data Flows

### 5.1 Guest uploads a photo

1. `POST /api/photos` (`server/routes/photos.ts:353`).
2. Two limiters in series on that same line: `uploadIpLimiter` (600/min venue-wide,
   `server/middleware/rateLimit.ts:51-57`) then `uploadLimiter` (20/min per device,
   `server/middleware/rateLimit.ts:38-45`).
3. The per-device key is taken from request body, query string, or the `x-device-fingerprint`
   header, falling back to a normalised IP via `ipKeyGenerator` so a client cannot rotate through an
   IPv6 `/64` (`server/middleware/rateLimit.ts:23-31`).
4. Body validated by `validateBody(CreatePhotoSchema)` (`server/routes/photos.ts:353`).
5. A photo pending moderation, or still disposable-locked, is written under `QUARANTINE_DIR` rather
   than `UPLOADS_DIR`, because `express.static` at `server/index.ts:106` serves everything under
   `UPLOADS_DIR` with no auth check and API-level filtering does nothing against someone holding the
   raw file URL (`server/lib/storage.ts:11-19`, `server/lib/config.ts:172-177`).

The rate-limit design is explicitly reasoned about the venue case: 80 guests behind one NAT means a
per-IP budget is really a per-wedding budget, and the moment everybody shoots at once — the first
dance — is exactly when guests would start seeing "Too many uploads"
(`server/middleware/rateLimit.ts:6-20`).

### 5.2 Host logs in

1. `POST /api/auth/login` (`server/routes/auth.ts:172`) behind `authLimiter`, 25 attempts per 15
   minutes per IP (`server/middleware/rateLimit.ts:61-67`).
2. An unknown email is compared against `DUMMY_PASSWORD_HASH`, a bcrypt hash of a fixed string
   computed once at module load, so the miss path costs roughly the same as a real comparison
   instead of returning in ~1 ms against bcrypt's ~90 ms (`server/middleware/auth.ts:71-77`).
3. `generateToken` signs `{ userId, email, role, fullName, tokenVersion }`
   (`server/middleware/auth.ts:8-20,52-58`).
4. Every subsequent authenticated request runs `requireAuth`
   (`server/middleware/auth.ts:107-137`): algorithm pinned to HS256 (`:117`), payload shape checked
   by `isSessionTokenPayload` (`:118`), then `isSessionTokenCurrent` (`:122`).
5. `isSessionTokenCurrent` compares the token's `tokenVersion` against `users.token_version` and
   **fails closed** — a database error returns `false`, so a blip cannot become a window where
   revoked tokens are honoured (`server/middleware/auth.ts:94-104`).
6. A revoked session gets a distinct response, `SESSION_REVOKED`, because the client needs to tell
   "signed out elsewhere" from "expired" (`server/middleware/auth.ts:123-127`).

### 5.3 Album expiry → notice → deletion

1. `refreshExpiryDates()` recomputes `events.expires_at` for every event from the host's currently
   active subscription (`server/lib/retention.ts:108`), batched into a single
   `UPDATE … FROM unnest(...)` rather than one statement per row (`server/lib/retention.ts:153`).
2. A floor of `NOW() + GRACE_PERIOD_DAYS` is applied, so moving an account to a shorter plan cannot
   retroactively produce an already-past deadline — losing a plan is a billing outcome, losing the
   photographs without warning is not (`server/lib/retention.ts:131-137`).
3. `findAlbumsNeedingNotice()` selects albums with `expires_at` inside the lead window and
   `retention_notified_at IS NULL`, excluding any address with an uncleared hard bounce
   (`server/lib/retentionNotice.ts`).
4. `sendRetentionNotices()` stamps `retention_notified_at` only after a confirmed send, one album at
   a time (`server/lib/retentionNotice.ts`).
5. `loadCandidates()` reads `retention_notified_at` and the joined bounce row
   (`server/lib/retention.ts:162-185`).
6. Eligibility requires the stamp set **and** aged past `RETENTION_NOTICE_DAYS`
   (`server/lib/retention.ts:294-298`); everything else past grace lands in `awaitingNotice`
   (`:299`).
7. `purgeEventMedia()` deletes full, original and thumbnail objects for each photo, plus audio, then
   zeroes `storage_bytes` in one statement under a transaction-local GUC instead of
   `ALTER TABLE … DISABLE TRIGGER`, which would take `ACCESS EXCLUSIVE` on the whole `photos` table
   (`server/lib/retention.ts:189-250`).

---

## 6. Realtime / Sockets

`WsEventManager` (`server/ws/wsServer.ts:54`), initialised before any Express middleware
(`server/index.ts:32`). State it holds: `clientMeta`, `eventRooms`, `heartbeatInterval`,
`messageRates`, `hostCheckCache`, `reactionQueues`, `reactionFlushTimers`
(`server/ws/wsServer.ts:55-62`).

Protections present, each with the reason recorded in the file:

| Protection | Value | Line | Why |
|---|---|---|---|
| Per-connection message budget | 20 per 10 s | `:26-27` | `JOIN_EVENT_ROOM` in a tight loop turned each frame into a `pool.query`, exhausting the pool until every HTTP endpoint timed out (`:21-24`) |
| Host-ownership check cache | 60 s | `:35` | — |
| Per-client send buffer cap | 512 KB | `:43` | `client.send()` queues onto `bufferedAmount` when a stalled mobile connection cannot drain, and nothing capped that backlog (`:37-42`) |
| Reaction batching | 200 ms / 50 max | `:46-47` | — |

Auth imports `isSessionTokenPayload` and `isSessionTokenCurrent` from the HTTP middleware, so socket
auth and request auth share one definition of a valid session (`server/ws/wsServer.ts:6`).

---

## 7. SaaS Tiering

### Tiers and weights

`BackendPlanTier = 'free' | 'celebration_pass' | 'deluxe_keepsake' | 'pro_planner'`
(`server/middleware/tierGate.ts:6`), ordered 0–3 by `TIER_WEIGHTS`
(`server/middleware/tierGate.ts:8-13`). Comparison via `meetsTier`
(`server/middleware/tierGate.ts:18-20`).

### Allowances

`server/lib/planLimits.ts:26-52`:

| Tier | Storage | Max photos | Retention | Pooled |
|---|---|---|---|---|
| `free` | 0.5 GB | 50 | 7 days | no |
| `celebration_pass` | 10 GB | unlimited | 90 days | no |
| `deluxe_keepsake` | 25 GB | unlimited | 365 days | no |
| `pro_planner` | 100 GB | unlimited | **null — indefinite** | yes |

`FREE_TIER_MAX_PHOTOS = 50` is also declared separately at `server/middleware/tierGate.ts:15`.

### Where tier is read

- `getEffectiveTierForEvent(eventId)` joins `events` to `subscriptions` where `status = 'active'`,
  ordered by `created_at DESC` (`server/middleware/tierGate.ts:29-42`).
- `getEffectiveTierForUser(userId)` exists because `GET /api/events` previously resolved the tier
  once per event, sequentially, inside a `for` loop — every row in that response belongs to the same
  authenticated host, so all those queries asked an identical question
  (`server/middleware/tierGate.ts:44-55`).
- `limitsFor(tier)` falls back to `free` for an unknown tier (`server/lib/planLimits.ts:54-56`).

The event's denormalised `plan_tier` column is **explicitly not trusted** for entitlement; the
`subscriptions` table is the single source of truth, and events with no linked host or no active
subscription fall back to `free` (`server/middleware/tierGate.ts:22-28`).

Observed live on this database during the audit session: the album `kiril-i-madalina-2026` carries
`plan_tier = free` while its active subscription resolves `pro_planner`, and retention correctly
follows the subscription — `expires_at` is null, i.e. indefinite.

The client keeps a display-only copy of the plan numbers at `src/config/plans.ts`, with the server
copy declared authoritative (`server/lib/planLimits.ts:3-8`).

---

## 8. Security Posture

Only what is configured in code. No recommendations in this section.

### Response headers

CSP is written out explicitly rather than taking helmet's defaults, because two defaults break this
app: `upgrade-insecure-requests` would rewrite the LAN URLs the QR codes hand out and make them
unreachable, and `cross-origin-resource-policy: same-origin` would stop the SPA on `:6500` loading
`/uploads` media served from `:6501` (`server/index.ts:44-59`).

Directives (`server/index.ts:67-80`):

```
default-src   'self'
script-src    'self'
style-src     'self' 'unsafe-inline'
img-src       'self' data: blob: [R2_PUBLIC_URL]
media-src     'self' data: blob: [R2_PUBLIC_URL]
connect-src   'self' ws: wss: [R2_PUBLIC_URL]
font-src      'self' data:
object-src    'none'
frame-ancestors 'none'
base-uri      'self'
form-action   'self'
```

`'unsafe-inline'` is required for styles because the app sets inline `style` attributes for theme
accent colours and animation transforms; scripts need no such exemption, since the Vite build emits
a single external module and no inline script (`server/index.ts:56-59`).

- `crossOriginResourcePolicy: cross-origin` (`server/index.ts:82`)
- `frameguard: { action: 'deny' }`, matching `frame-ancestors 'none'` — helmet's default is
  `SAMEORIGIN`, which would be the weaker of the two for a browser falling back to
  `X-Frame-Options`, and disagreeing headers are their own bug (`server/index.ts:83-86`)
- HSTS only when `NODE_ENV === 'production'`, because pinning it while a domain is still served over
  http would lock browsers out until certificates are in place (`server/index.ts:87-89`)

### Network trust

- `trust proxy` is configurable and **defaults closed**, so a client reaching the process directly
  cannot spoof its rate-limit identity via `X-Forwarded-For` (`server/index.ts:26-29`,
  `server/lib/config.ts:167`)
- CORS origins parsed from a comma-separated list; with none configured the value is `false`, not
  `'*'` (`server/index.ts:40-42`, `server/lib/config.ts:190`)

### Authentication

- JWT algorithm pinned to `HS256` in both `requireAuth` and `optionalAuth`, against an `alg: none`
  downgrade (`server/middleware/auth.ts:117,145`)
- Token-purpose discrimination: a session token never sets `purpose` and always carries `email`;
  single-purpose tokens are the inverse. Without this, a 5-minute export-zip download token — which
  carries a real `userId` in a URL query string, where it reaches proxy logs and browser history —
  decoded cleanly as a session payload and passed every ownership check for its lifetime
  (`server/middleware/auth.ts:22-39`)
- `token_version` revocation, checked per request, failing closed
  (`server/middleware/auth.ts:94-104`)
- `optionalAuth` also runs the revocation check, because those routes widen what they return for a
  recognised host — `GET /api/photos` shows pending photos to the owner — so treating a signed-out
  token as an anonymous guest is the point (`server/middleware/auth.ts:146-152`)
- bcrypt cost factor 10 (`server/middleware/auth.ts:62`)
- Login failure reasons are deliberately not echoed back: distinguishing "expired" from "malformed"
  tells an attacker which half of the token to work on (`server/middleware/auth.ts:132-135`)

### Rate limiting

Seven limiters in `server/middleware/rateLimit.ts`:

| Limiter | Window | Max | Key | Line |
|---|---|---|---|---|
| `uploadLimiter` | 60 s | 20 | device | `:38` |
| `uploadIpLimiter` | 60 s | 600 | IP | `:51` |
| `authLimiter` | 15 min | 25 | IP | `:61` |
| `reactionLimiter` | 60 s | 30 | device | `:71` |
| `commentLimiter` | 60 s | 20 | device | `:89` |
| `commentIpLimiter` | 60 s | 300 | IP | `:105` |
| `guestActionLimiter` | 60 s | 30 | device | `:122` |
| `apiLimiter` | 60 s | 3000 | IP | `:138` |

Device keys are client-supplied and therefore rotatable, which is stated as precisely why the IP
backstops remain (`server/middleware/rateLimit.ts:14-17`, `:98-104`).

### Secrets and storage

- All secrets read from environment with startup validation (`server/lib/config.ts:165-266`)
- Quarantine directory structurally outside the public static mount
  (`server/lib/config.ts:172-177`)
- Plaintext FTP refuses to start in production without `FTP_ALLOW_PLAINTEXT`
  (`server/lib/config.ts:208-212`)

---

## 9. Test Coverage Reality

**Coverage measured 12 September 2026** (`npm run test:coverage`, v8 provider):

| Metric | Result | Standard |
|---|---|---|
| Statements | 75.54% (3664/4850) | 80% |
| Branches | 67.61% (2514/3718) | 80% |
| Functions | 70.76% (673/951) | 80% |
| Lines | 77.89% (3456/4437) | 80% |

**The suite is below the project's own 80% minimum on every metric.** The
`coverage.include` list at `vitest.config.ts:78-88` covers `server/lib`,
`server/middleware`, `server/routes` and most of `src`, so this is a real
figure and not an artefact of a narrow scope.

Lowest-covered modules, statements:

```
  2.7%  src/api/ingestApi.ts
  0.0%  src/components/host/HostProfileModal.tsx
 15.4%  server/lib/mailer.ts
 26.7%  server/lib/stripe.ts
 36.4%  src/services/realtimeSocket.ts
 43.5%  src/services/pdfPrintService.ts
 43.8%  src/components/host/HostDashboard.tsx
 47.3%  src/components/camera/CameraCaptureModal.tsx
 53.6%  src/services/realtimeMessages.ts
```

`src/services/mockData.ts` reports 0% and is **not** dead: it is a lazy demo
chunk reached only through the dynamic import at
`src/services/storageSyncService.ts:121`.

| Category | Count |
|---|---|
| Unit spec files (`tests/unit/*.spec.ts*`) | 92 |
| Integration | 1 |
| E2E | 1 (`tests/e2e.test.ts`) |
| Helpers | 1 |

Runner configuration: `vitest.config.ts` (coverage block at `vitest.config.ts:76`),
`vitest.r2.config.ts` for real-R2 storage tests (`package.json:37`), and `tests/e2e.test.ts` run
directly through tsx rather than through vitest (`package.json:39`).

Test commands (`package.json:34-39`):

```
test              test:unit && test:e2e
test:unit         vitest run
test:unit:serial  vitest run --no-file-parallelism
test:storage:r2   vitest run --config vitest.r2.config.ts
test:coverage     vitest run --coverage
test:e2e          tsx tests/e2e.test.ts
```

Last full run during this session: **92 files / 704 tests passing**, e2e **27/27**.

`npm run typecheck` is three separate invocations — `tsconfig.json` (which includes only `src` and
`shared`), `tsconfig.server.json`, and `tsconfig.test.json` (`package.json:9`). Running
`tsc --noEmit -p tsconfig.json` alone checks the frontend and nothing else.

---

## 10. Shipped vs Planned

Neither `CLAUDE.md` nor `CODING_ROADMAP.md` exists in this repository, so the skill's named sources
are unavailable. The equivalent record is `OPEN_ITEMS.md`, which carries **45 `##` sections**. The
most recent, verbatim:

```
3140  ## Fixed (2026-09-11, orphan sweep could not see quarantined R2 objects)
3222  ## Done (2026-09-11, orphan cleanup executed, leak fixed at source, M14 closed)
3304  ## Decided and implemented (2026-09-11, D1 retention, D2 erasure, R2 lifecycle)
3431  ## Done (2026-09-11, R2 quarantine lifecycle rule)
3461  ## Added (2026-09-11, mailer — D1's missing half)
3558  ## Notice email — copy rewritten, and the link it carried was unusable
3648  ## Scheduler logs — already wired; a compose volume was not
3728  ## A retention window on the maintenance reports
3784  ## `--once` for the maintenance scheduler
3849  ## `notify:verify` — proving the mailer before customers do
3934  ## Bounce handling — a bounced warning is not a warning
4016  ## Current state — 11 September 2026
```

Feature claims live in `README.md:8` ("Ключови възможности"), pricing at `README.md:45`, quick start
at `README.md:54`, test suite at `README.md:101`, project structure at `README.md:116`.

Reference documentation in `docs/`: `API_REFERENCE.md`, `ARCHITECTURE.md`,
`CLOUDFLARE_R2_SETUP_GUIDE.md`, `DATABASE_SCHEMA.md`, `DEPLOYMENT.md`,
`G2_CAPACITY_BENCHMARK_RUNBOOK.md`, `HTTPS_AND_PERMISSIONS.md`, `I18N_LOCALIZATION_GUIDE.md`,
`LOCAL_DOCKER_SETUP.md`, `OPERATIONS.md`, `PRO_PHOTOGRAPHER_INGEST.md`, `QR_PRINT_GUIDE.md`,
`SECURITY.md`, `STORAGE_MIGRATION.md`, `TEST_SPEC_COVERAGE.md`.

### Operational CLI surface

From `package.json:13-33`:

```
migrate                 tsx server/lib/migrate.ts
notify:verify           tsx scripts/notify-verify.ts
bounce:list             tsx scripts/bounces.ts list
bounce:record           tsx scripts/bounces.ts record
bounce:clear            tsx scripts/bounces.ts clear
notify:report           tsx scripts/retention-notify.ts
notify:send             NOTICE_SEND=true …
retention:report        tsx scripts/retention-sweep.ts
retention:sweep         RETENTION_ENFORCED=true …
maintenance             tsx scripts/maintenance-scheduler.ts
maintenance:once        … --once
db:purge-test-data      tsx scripts/purge-test-data.ts
grace:report            tsx scripts/subscription-grace-sweep.ts
grace:sweep             GRACE_ENFORCED=true …
storage:recount         tsx scripts/storage-recount.ts
loadtest                tsx scripts/load-test.ts
storage:orphans         tsx scripts/storage-orphans.ts
storage:orphan-report   tsx scripts/storage-orphan-sweep.ts
storage:orphan-sweep    SWEEP_CONFIRM=true …
r2:lifecycle            tsx scripts/r2-lifecycle.ts
r2:lifecycle:apply      LIFECYCLE_APPLY=true …
ingest:watch            tsx scripts/ingest-watcher.ts
tunnel                  node start-tunnel.cjs
```

Every destructive operation is opt-in behind an environment variable: `NOTICE_SEND`,
`RETENTION_ENFORCED`, `GRACE_ENFORCED`, `SWEEP_CONFIRM`, `LIFECYCLE_APPLY`.

---

## 11. Risks & Debt

### Code markers

**Zero `TODO`, `FIXME`, `HACK` or `XXX` markers exist** in application code. Verified by three
separate Grep passes over `server/`, `src/` and `scripts/`; all returned "No matches found". The only
matches anywhere in the tree are inside `node_modules/`.

Under the skill's rule 5, the honest verdict for this section is therefore:

> INSUFFICIENT EVIDENCE from code markers — files inspected: all `.ts`, `.tsx` and `.sql` under
> `server/`, `src/` and `scripts/`.

Debt in this project is recorded as prose in `OPEN_ITEMS.md` rather than as inline markers.

### Constraints stated in code comments

These are recorded in source as deliberate current limitations, not as defects:

- **No SMTP means no deletion.** Without `SMTP_HOST` no notice can be sent, and because the
  retention sweep will not delete an album until its host has been warned, `RETENTION_ENFORCED=true`
  deletes nothing while it is unset (`server/lib/config.ts:160-162`).
- **Stripe is deliberately not fail-fast**, unlike R2 and `JWT_SECRET`. The app is fully usable
  without payments configured, and the self-serve tier-write stays available as a fallback. Setting
  `STRIPE_SECRET_KEY` is therefore a security switch as well as a feature flag: it makes payment
  mandatory and closes the unpaid fallback in the same step (`server/lib/config.ts:214-225`).
- **Stripe price IDs are meaningful as a set.** With all three present, the webhook derives the
  purchased tier from the Price actually paid, which is authoritative, and treats
  `metadata.tier` as a cross-check. With any missing, the tier comes from metadata alone, which is
  editable from the Stripe Dashboard and therefore a weaker claim (`server/lib/config.ts:228-238`).
- **Plaintext FTP** refuses to start in production unless `FTP_ALLOW_PLAINTEXT` is set
  (`server/lib/config.ts:208-212`).

### Structural

**Resolved 12 September 2026** — see §13.

- ~~`server/routes/events.ts` at 1067 lines and `server/routes/photos.ts` at 1009 lines both exceed
  the 800-line ceiling~~ — both split into composed sub-routers; no server file now exceeds 588
  lines.
- Three non-source files sit at the repository root (`1`, `617`, `{{.Destination}}`), identified in
  §1. **Removed** — see §13.

Not previously recorded, found while measuring: **`src/components/host/HostDashboard.tsx` at 986
lines also exceeded the 800-line ceiling.** Split as well — see §13. `src/i18n/index.ts` (1281) is
now the only file over the ceiling, and is a translation table rather than logic.

---

## 12. Open Questions — all resolved 12 September 2026

Every item below was raised as `UNVERIFIED` on 11 September and has since been established by
reading. The original question is kept so the answer can be checked against what was asked.

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Is root `server.ts` intentional or dead? | **Dead.** Unreferenced by any config, and in no tsconfig `include` — `tsconfig.json` covers `src`+`shared`, `tsconfig.server.json` covers `server`+`scripts`+`shared`. It was never even typechecked. | `tsconfig.json:29`, `tsconfig.server.json:11` |
| 2 | Are `1`, `617`, `{{.Destination}}` safe to delete? | **Yes.** No reference in `package.json`, `Dockerfile`, `docker-compose.yml`, `vercel.json`, or any `.ts`/`.tsx` file. | grep over the tree |
| 3 | What does `npm run test:coverage` report? | **75.54% statements, 67.61% branches, 70.76% functions, 77.89% lines** — below the 80% standard on all four. | §9 |
| 4 | Does `src/config/plans.ts` agree with `server/lib/planLimits.ts`? | **Yes, on every number.** Storage 500 MB / 10 / 25 / 100 GB matches; the limits rendered from i18n (`50 photos`, `7 days`, `3 months`, `1 full year`, `Ongoing access`) match `maxPhotos` and `retentionDays`. | `src/config/plans.ts:41,63,86,108`, `src/i18n/index.ts:984-1020`, `server/lib/planLimits.ts:27-50` |
| 5 | Is `events.plan_tier` read for any non-entitlement purpose? | **No — fully vestigial.** Every handler overwrote `planTier` from `getEffectiveTierForEvent`/`ForUser` before responding, and the client prefers `planTier` over `plan_tier`. It was still shipped on the wire as a second, staler answer. | `server/routes/events.ts:149,355,378,530`, `server/routes/auth.ts:99,276,307`, `src/services/eventNormalization.ts:101,143` |
| 6 | Is the 800-line standard advisory for route files? | Treated as binding. Both files are now split — §13. | §13 |
| 7 | Is `email_bounces` address-keying the intended long-term shape? | **Yes, stated in the migration:** "A bounce is a property of the address, not of one album — a host may own several events, and all of them are equally unwarned. So the record is keyed by address." | `database/migrations/025_email_bounces.sql:19-21` |
| 8 | Is the duplicated `50` intentional? | **No.** It was written out three times, and only `limitsFor(tier).maxPhotos` was ever enforced; the `tierGate.ts` copy had zero consumers outside a test. Now derived from one shared constant. | §13 |
| 9 | Is `questsRouter` mounted at `/api` deliberately? | **Deliberate.** The router declares two different URL shapes — `/events/:id/quests` and `/quests/:id` — so mounting at `/api` is what yields both. | `server/routes/quests.ts:42,112`, `server/index.ts:115` |
| 10 | What do the four handlers at `:737`, `:806`, `:871`, `:898` serve? | `POST /:id/reactions`, `PUT /:id/qr-config`, `POST /:id/export-token`, `GET /:id/export-zip`. | now in `events/reactions.ts`, `events/qr.ts`, `events/export.ts` |
| 11 | Has `src/i18n/index.ts` accumulated dead entries? | **Yes — 25 of 603 keys (4.1%) were unreferenced.** The `bg` and `en` tables were otherwise in perfect sync at 603 keys each, and there are no dynamically built keys (zero template-literal `t()` call sites), so an unreferenced key is genuinely dead. Removed. | §13 |

---

## 13. Remediation — 12 September 2026

Applied against the findings above. Verified after every change with
`npm run typecheck` (three configs), `npm run test:unit` (92 files / 704 tests)
and `npm run test:e2e` (27 tests). All green at each step.

### Single source of truth for the free-tier photo cap

`50` was declared in three places — `server/middleware/tierGate.ts:15`,
`server/lib/planLimits.ts:30` and `src/config/tierGating.ts:107` — where the
server enforces the cap and the client renders an approaching-the-limit warning
from its own copy. A new `shared/planCaps.ts` holds it once; `shared/` is in
both `tsconfig.json` and `tsconfig.server.json`, so neither half can drift from
it. `PLAN_LIMITS.free.maxPhotos` and both former declarations now read from it.

### Stale `plan_tier` no longer reaches the client

The denormalized column was in `HOST_EVENT_COLUMNS` and in four `SELECT` /
`RETURNING` lists in `auth.ts`, so responses carried both the authoritative
`planTier` and the stale `plan_tier`. The client accepts `plan_tier` as a
fallback, which made the stale value one missing assignment away from driving
feature gating. Removed from all five outbound column lists; the `INSERT` writes
are kept, so the column still records what an album was created on.

### `||` to `??` on the per-guest photo cap

`server/routes/photos.ts:449` read `context.maxPhotosPerGuest || 50`. The column
is nullable and only `null` means "no limit set", but `||` also swallowed `0` —
the one value meaning the opposite — and turned it into 50. Now `??`, against
the named `DEFAULT_MAX_PHOTOS_PER_GUEST`.

### 25 dead translation keys removed

50 lines (25 keys across 2 languages). Both tables remain in sync, at 578 keys
each.

### `events.ts` split — 1073 lines to 35

| File | Lines | Routes |
|---|---|---|
| `server/routes/events.ts` (composer) | 35 | — |
| `server/routes/events/crud.ts` | 588 | 8 |
| `server/routes/events/export.ts` | 270 | 3 |
| `server/routes/events/shared.ts` | 146 | — |
| `server/routes/events/qr.ts` | 123 | 2 |
| `server/routes/events/reactions.ts` | 59 | 1 |

All 14 routes preserved; handler bodies moved byte-identical. Each module
declares `const eventsRouter = Router()` and re-exports it under a distinct
name, which is what let the bodies move unedited.

### `photos.ts` split — 1013 lines to 32, and the 372-line upload handler decomposed

| File | Lines | Routes |
|---|---|---|
| `server/routes/photos.ts` (composer) | 32 | — |
| `server/routes/photos/upload.ts` | 587 | 1 |
| `server/routes/photos/engagement.ts` | 236 | 3 |
| `server/routes/photos/feed.ts` | 204 | 2 |
| `server/routes/photos/shared.ts` | 170 | — |
| `server/routes/photos/moderation.ts` | 112 | 2 |

All 8 routes preserved. `POST /api/photos` was 372 lines in a single function;
it is now orchestration over named steps — `resolveGuestForUpload`,
`checkPerGuestCap`, `decodeAndValidateImages`, `persistPhotoFiles`,
`insertPhotoAtomically`, `recordQuestCompletion`, `broadcastNewPhoto` — each
under 60 lines of code, using the `{ ok: true } | { ok: false }` convention
already established by `server/lib/ingestPipeline.ts`.

**`ingestPipeline.ts` was deliberately left alone.** It runs a structurally
similar tail for photographer frames, and its own comment already names the
overlap ("same gap as the guest upload path (server/routes/photos.ts)",
`server/lib/ingestPipeline.ts:87-89`). Unifying the two was considered and
declined at first, then **reversed later the same day and carried out** — see
"The guest and photographer upload paths now share their tail" below.

### Ordering constraint introduced by the splits

Express matches routes in registration order. Both composers preserve the
original order and say so in a comment, because no route in one sub-router
shadows one in another *today* — `/:id` is a single segment and cannot match
`/:id/usage` — but that is a property of the current paths, not a guarantee.

### Dead root files removed

`1` (0 bytes), `617` (a captured hook-event payload), `{{.Destination}}` (a
shell fragment saved as a filename by a mis-quoted Go template) and `server.ts`
(unreferenced by any config and absent from every tsconfig `include`, so never
even typechecked) are gone from the repository root. Copies were taken first.

### `HostDashboard.tsx` split — 986 lines to 307

| File | Lines |
|---|---|
| `src/components/host/HostDashboard.tsx` | 307 |
| `src/components/host/dashboard/OverviewTab.tsx` | 391 |
| `src/components/host/dashboard/TabNav.tsx` | 141 |
| `src/components/host/dashboard/QuestsTab.tsx` | 124 |
| `src/components/host/dashboard/context.tsx` | 124 |
| `src/components/host/dashboard/ExportTab.tsx` | 89 |
| `src/components/host/dashboard/dateFields.ts` | 65 |
| `src/components/host/dashboard/questIcons.ts` | 9 |

`HostDashboard` keeps every piece of state and every action that writes it, and
still renders the tab shell and the tier gates, so what a plan unlocks stays
readable in one place. The tabs read what they need through
`HostDashboardProvider` rather than props: the Overview tab alone needs about
thirty values, and `rules/ecc/web/patterns.md` calls for exactly that shape —
"Parent owns state, children consume via context. Prefer this over prop
drilling for complex widgets."

Nothing below the provider holds state of its own, so there is still exactly
one writer. The markup moved unedited.

`dateFields.ts` is the useful by-product: `formatDateDDMMYYYY`, `formatTime24h`,
`maskDateInput`, `maskTimeInput` and `parseDateAndTime` are pure and now
testable without mounting the dashboard. They exist because a native
`<input type="datetime-local">` renders in the OS locale regardless of the
page's language, and this app's hosts expect DD.MM.YYYY and 24-hour time.

### The guest and photographer upload paths now share their tail

Reversing the decision recorded earlier in this section. `server/lib/photoWrite.ts`
(266 lines) holds the three rules both paths have to get identically right, and
both now call it:

| Concern | Why sharing it matters |
|---|---|
| `savePhotoVariants` | DB-05 — files are written before the row that points at them can commit, so every path is tracked and removed if the insert does not land. An orphan is invisible once the row is gone, and billed forever. |
| `insertPhotoUnderQuota` | SEC-D1 — the allowance is re-checked under an event-scoped lock, in the same transaction as the INSERT. Every earlier check ran unlocked, and decoding and resizing take real time. |
| `broadcastPhotoAdded` | MED-03/SEC-M5 — a quarantined photo is never broadcast with its real URLs; hosts get a signed host-scoped preview token, guests get nothing until approval or reveal. |

What stayed with each caller is what genuinely differs: guest identity
resolution (fingerprint and token, versus one dedicated photographer row),
the filenames, and the INSERT column list. Filenames are unchanged on both
paths — `wedding-photo-<ts>-<rand>` and `pro-<ts>-<rand>` — so nothing about
what lands in the bucket moved.

**A latent orphan bug was fixed in the merge.** `ingestPipeline.ts` wrote its
three files with `Promise.all` and collected the storage paths from the resolved
array. A rejection never produces that array, so if any one of the three writes
failed, the ones that had already succeeded were never recorded and never
cleaned up — orphaned in R2 with nothing pointing at them. The guest path wrote
sequentially and so never had the hole. `savePhotoVariants` uses
`Promise.allSettled` and deletes whatever succeeded before propagating the
error, which is correct for both.

`ingestPipeline.ts` went from 269 lines to 235 and no longer contains a
transaction, a lock, or a cleanup closure.

### Version control

The repository had no `.git` at all. Initialized at the post-remediation tree.
`.gitignore` already covered `.env`, `node_modules`, `dist`, `coverage`, `logs`
and `uploads`; three gaps were closed first so nothing sensitive or generated
entered history:

- `uploads-quarantine/` — 6.7 MB of real guest photos held back from the public
  mount pending moderation or a disposable reveal, ignored for the same reason
  `uploads/` is;
- `.claude-flow/`, `.impeccable/` — local agent state, which may carry tokens;
- `.npm-cache/` — an npm cache written into the project by a sandboxed install.

Verified before committing: `.env` untracked, `.env.example` placeholders only,
no live key patterns in any tracked file, and the live `JWT_SECRET` (256 chars)
distinct from the example placeholder. 310 files tracked.

A fourth piece of root debris, `900` (0 bytes), was found and removed — same
class as `1` and `617`, created during the remediation session itself.

### i18n review

| Severity | Finding |
|---|---|
| HIGH | Unguarded `localStorage` in `I18nManager`. `detectLanguage()` runs from the constructor, the constructor runs at module scope, and the module is imported by `App.tsx` and 35 other files. `getItem` throws a `SecurityError` when site data is blocked — a private window, Safari with cookies disabled, an embedded webview — so the failure mode was not a broken language switcher but the app failing to initialise. The rest of the codebase already wraps `localStorage`; this was the one place that did not, and the one place it mattered most. **Fixed.** |
| LOW | The lookup chain used `\|\|`, so a key deliberately translated to the empty string fell through into another language's text. **Fixed** (`??`). Nothing is blank today. |
| — | `src/i18n/index.ts` was 1281 lines, the last file over the 800-line ceiling. Split into `translations/bg.ts` (623), `translations/en.ts` (596) and a 92-line runtime. |

Tests added for interpolation, a missing placeholder value, and storage being
unavailable. The storage test was first written against `Storage.prototype`,
which does not reach jsdom's `localStorage` instance and passed with the fix
reverted; it now replaces the accessors on the object the code actually calls,
and was confirmed to fail without the guard.

### Tier gating review

**No entitlement defects.** Eight of the nine features in `FEATURE_GATES` have
server enforcement at an identical tier:

| Feature | Client tier | Server enforcement |
|---|---|---|
| `scavenger_quests` | celebration_pass | `requireEventTier` — `quests.ts:77` |
| `audio_guestbook` | deluxe_keepsake | `requireEventTier` — `audio.ts:37` |
| `qr_print_studio` | celebration_pass | `requireEventTier` — `events/qr.ts:69` |
| `zip_export` | celebration_pass | `requireEventTier` — `events/export.ts:78,105` |
| `photo_moderation` | celebration_pass | `TIER_GATED_EVENT_FIELDS.isModerationEnabled` |
| `disposable_camera` | deluxe_keepsake | `TIER_GATED_EVENT_FIELDS.isDisposableMode` |
| `custom_themes` | celebration_pass | `wantsCustomTheme` — `events/crud.ts:325-350` |
| `multi_events` | pro_planner | `subscriptions.event_limit` (pro_planner 10, all others 1) under `acquireUserEventCreationLock` |
| `live_tv` | celebration_pass | **none — presentation only** |

`live_tv` is a slideshow over photos the client has already legitimately
fetched from `GET /api/photos`; there is no distinct server resource to gate,
so it is a UI-mode paywall rather than an enforced entitlement. Recorded, not
fixed — enforcing it would mean inventing an endpoint.

Also confirmed sound: the dunning grace window (the webhook holds
`status = 'active'` with a `past_due_grace_expiry` deadline, so a host is
carried through a failed card and `subscription-grace-sweep.ts` downgrades on
expiry), and the SEC-D5 partial unique index on `subscriptions (user_id) WHERE
status = 'active'`, which makes the one-active-row invariant the tier lookups
assume actually hold.

Two fixes:

- **`TIER_WEIGHTS` was written out twice**, in `server/middleware/tierGate.ts`
  and `src/config/tierGating.ts` — the same drift risk as the photo cap, with a
  worse failure: the client decides what to show behind a paywall and the server
  decides what to allow, so a disagreement either sells a feature that is then
  refused, or hides one the customer paid for. Now in `shared/planCaps.ts`.
- **`requireEventTier` returned 500 for a malformed `eventId`.** The value went
  unvalidated to Postgres, which threw 22P02, caught as "Internal server error
  validating tier" — the caller's bad input reported as a server fault. Never a
  bypass, since the gate fails closed, but the wrong status and it buried real
  500s. Now a 400 before any query. Reachable: `POST /api/audio` takes its
  `eventId` from the request body, with no `requireUuidParams` ahead of it.

### Not done

- **Coverage is unchanged at 75.54%**, still below the 80% standard. Explicitly
  scoped out. §9 lists the lowest-covered modules; `server/lib/photoWrite.ts` is
  new and has no direct unit tests of its own, though both callers are covered.
- **No file now exceeds the 800-line ceiling.** The largest is
  `src/components/camera/CameraCaptureModal.tsx` at 694.

---

## Appendix A — Dependency inventory

### Runtime (`package.json:44-73`)

```
@aws-sdk/client-s3  ^3.1118.0     archiver            ^8.0.0
@types/nodemailer   ^8.0.1        bcryptjs            ^3.0.3
canvas-confetti     ^1.9.4        clsx                ^2.1.1
cors                ^2.8.6        cross-env           ^10.1.0
dotenv              ^17.4.2       express             ^5.2.1
express-rate-limit  ^8.6.2        ftp-srv             ^4.6.3
helmet              ^8.3.0        html2canvas         ^1.4.1
jsonwebtoken        ^9.0.3        jspdf               ^2.5.2
lucide-react        ^1.16.0       multer              ^2.2.0
nodemailer          ^10.0.6       pg                  ^8.23.0
qrcode.react        ^4.2.0        react               ^18.3.1
react-dom           ^18.3.1       sharp               ^0.35.4
stripe              ^22.6.1       tailwind-merge      ^3.0.2
ws                  ^8.21.3       zod                 ^4.4.3
```

`@types/nodemailer` is listed under `dependencies` rather than `devDependencies`
(`package.json:46`).

### Development (`package.json:74-107`)

TypeScript 5.7, Vite 6.2, Vitest 4.1, ESLint 8.57, jsdom 30, Testing Library, tsx 4.23, Tailwind
3.4, plus `js-yaml` and `@types/js-yaml` (`package.json:82,99`).

---

## Appendix B — Audit session evidence

Commands and tools used to produce this report:

- `Read` on: `package.json`, `server/index.ts`, `server/lib/config.ts` (160-266),
  `server/middleware/auth.ts`, `server/middleware/rateLimit.ts`, `server/middleware/tierGate.ts`
  (1-55), `server/lib/planLimits.ts`, `server/lib/storage.ts` (1-60), `server/ws/wsServer.ts`
  (1-70), `server/lib/retention.ts` (155-250), `server/lib/retentionNotice.ts`,
  `server/lib/mailer.ts`, `server/lib/emailBounces.ts`, `src/router/index.ts`,
  `src/context/AppContext.tsx` (1-80), `database/migrations/001_initial_schema.sql`,
  `database/migrations/024_retention_notice_and_event_deletion.sql` (1-30),
  `database/migrations/025_email_bounces.sql`, `scripts/retention-notify.ts`,
  `scripts/maintenance-scheduler.ts`, `scripts/notify-verify.ts`, `scripts/bounces.ts`,
  `tests/unit/maintenanceScheduler.spec.ts`, `tests/unit/retentionNotices.spec.ts`,
  `tests/globalSetup.ts`
- `Glob` on `server/**/*.ts` (40 files) and `src/**/*.{ts,tsx}` (76 files)
- `Grep` for `TODO|FIXME|HACK|XXX` across `server/`, `src/`, `scripts/` — no matches
- `Grep` for `Router\.(get|post|put|patch|delete)\(` across `server/routes/` — 43 handlers
- `Grep` for `localStorage\.(setItem|getItem).*[Tt]oken` across `src/` — 6 matches
- Live database queries against the running Postgres for the tiering observation in §7
