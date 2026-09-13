# Open Items

Everything known to be unfinished in WedMoments, excluding billing.

Produced 2026-08-30 by working through the app against a running stack — every
claim below was checked against the code or reproduced on the live server, not
inferred. Line references are accurate as of that date.

Nothing here is a known-broken feature. Every bug found during the review has
been fixed and covered by a test (see [Fixed, for reference](#fixed-for-reference),
so you don't re-investigate). What remains is **two decisions** and **six gaps**,
plus a [Gotchas](#gotchas) section for behaviour that is easy to trip over and
won't announce itself.

---

## Decisions

These are yours to make. Neither is a defect; both are things the code currently
declines to do on purpose, and leaving them undecided is the actual risk.

### D1 — Retention is built but switched off

`sweepExpiredAlbums(enforce = false)` (`server/lib/retention.ts:164`) reports
expired albums and deletes nothing. `RETENTION_ENFORCED` is absent from `.env`,
so nothing is being swept today. The 30-day grace period after expiry is at
`server/lib/retention.ts:20`.

The default is deliberate: these are irreplaceable wedding photos, and deletion
should never be a side effect of a maintenance task. But while it stays off,
storage grows without bound, and the margins in `STORAGE_AND_FINANCIAL_PLAN.md`
assume it is running.

**Still open as of 2026-09-13, and the stakes have changed.** When this was
written there was no mailer, so `RETENTION_ENFORCED=true` would have deleted
nothing regardless — the sweep refuses to touch an album whose host has not
been warned. That is no longer a safety net: `sendRetentionNotices` now stamps
`retention_notified_at` after a confirmed send, so with SMTP configured and
notices more than 14 days old, enforcement **permanently deletes wedding
photos**. The only thing still making it a no-op is that `SMTP_HOST` is unset.
Read `npm run notify:report` as well as `npm run retention:report` before
deciding.

To turn on:

1. `npm run retention:report` — read what it would delete. Do this first, and
   more than once, across a few weeks.
2. Set `RETENTION_ENFORCED=true` and schedule `npm run retention:sweep`.
3. Add an R2 lifecycle rule as a backstop, in case the sweep stops running and
   nobody notices.

Step 1 is free and reversible. Worth doing now even if you defer the rest — the
report is the only way to find out whether the expiry dates are sane *before*
they start deleting things.

### D2 — There is no way to delete an event — **RESOLVED (a route now exists)**

`DELETE /api/events/:id` is implemented at `server/routes/events/crud.ts:522`.
It requires auth and ownership, takes a `confirmSlug` body that must match the
stored slug, and — the part that matters — calls `purgeEventMedia()` *before*
deleting the row, because the cascade removes the only record of which stored
objects belong to the album. The warning below is what the implementation
follows.

The original entry follows, as written. Note its file reference predates the
router split: `server/routes/events.ts` is now a 35-line composer.

---

`server/routes/events.ts` (727 lines) has no `.delete` handler. A host cannot
remove an event, ever. Individual photos can be deleted
(`server/routes/photos.ts:583`); whole events cannot.

That may be intentional — a wedding album is arguably permanent, and the absence
means no user can trigger the storage leak that produced 15 GB of orphans during
testing. But right now it is an omission rather than a decision, and there is no
GDPR erasure path.

**If you add it, storage must be purged before the rows.** Deleting the event
cascades its photo rows, and with them the only record of which files to remove.
`purgeEventMedia()` (`server/lib/retention.ts`) already does this correctly —
call it, don't reimplement it. `npm run storage:orphans` will show you if you
got it wrong.

---

## Gaps

### G1 — The UI has almost no test coverage — **CLOSED (2026-09-13)**

All 27 components now have direct test suites, and the whole project clears its
own 80% standard on all four coverage metrics: 85.66% statements, 80.29%
branches, 82.26% functions, 87.41% lines, across 1187 tests in 117 files. See
REPO_AUDIT.md §18 for the final pass, which also found a real defect — the audio
upload rate limit was shared by an entire venue rather than applied per phone —
and a port-allocation guard that had been failing open.

The original entry follows, as written.

---

20 of 27 components have no direct test. Server-side paths are well covered now
(156 tests across 23 files); the UI is where the next regression will come from.

Uncovered, roughly ordered by how much damage a silent break would do:

| Component | Why it matters |
|---|---|
| `src/components/projector/LiveProjectorScreen.tsx` | On a screen in front of every guest |
| `src/components/camera/CameraCaptureModal.tsx` | The primary guest action |
| `src/components/host/ModerationQueue.tsx` | Paid feature; failure means unmoderated photos ship |
| `src/components/host/HostDashboard.tsx` | 775 lines, the host's entire surface |
| `src/components/ingest/PhotographerIngestPortal.tsx` | Paid feature, external users |
| `src/components/host/QRCanvasStudio.tsx` | Paid feature |
| `src/components/audio/AudioGuestbook.tsx` | Media permissions, easy to break silently |
| `src/components/gallery/LightboxModal.tsx` | Core viewing path |
| `src/components/host/PricingPlansModal.tsx` | Becomes billing-critical |
| `src/components/guest/GuestOnboardingModal.tsx` | First thing a guest sees |

Also uncovered: `HostAuthPage`, `HostEventsList`, `PhotographerIngestPanel`,
`LandingHomePage`, `PublicWeddingsShowcase`, `Navbar`, `BottomNav`,
`WeddingHero`, `EventNotFound`, `LoadingSpinner`.

Already covered: `ErrorBoundary`, `LockedFeatureBadge`, `LiveFeed`,
`ReactionBar`, `StorageMeter`, `ScavengerHunt`.

Worth noting: **every bug found in this review was in code that had no test until
one was written for it.** That is not a coincidence.

### G2 — No trustworthy capacity number — **ANSWERED, with one part still open (2026-09-13)**

Run against live Cloudflare R2 on 2026-09-13. Full method, rig and tables in
`docs/G2_CAPACITY_BENCHMARK_RUNBOOK.md` §Results.

| Concurrency | Uploads | Throughput | p50 | p95 | Failures |
|---|---|---|---|---|---|
| 5 | 60 | 0.95/s | 4.90 s | 8.41 s | 0 |
| 10 | 150 | 0.96/s | 10.07 s | 15.34 s | 0 |
| 20 | 120 | 0.96/s | 19.24 s | 30.53 s | 0 |

**Zero failures anywhere, and no rate limiting** — 57 uploads/min against a
600/min per-IP ceiling, so the limiter never engaged.

Throughput is identical across a 4× concurrency range while latency scales
linearly: a saturated resource with a queue in front of it. Little's Law
(`concurrency ÷ throughput`) predicts the measured p50 within 3–8% at every
step. The resource was then identified directly, by pushing buffers through
the storage adapter with sharp, Postgres and HTTP removed from the path —
**8.7 MB/s to R2**, against the load test's implied 9 MB/s. The application
adds essentially nothing to the wire time; nothing local was near binding
(CPU 17–49% of 16 cores *including* the co-resident generator, 12 Postgres
connections against a pool of 40).

So the honest answer is not "N receptions per instance" but arithmetic:

```
uploads/sec  =  uplink MB/s  ÷  9.1 MB per upload
```

which reproduces every row measured (8.7 ÷ 9.1 = 0.96).

**The lever:** 8.5 MB of that 9.1 MB payload is the retained full-resolution
original — 93%. Capacity and the storage bill are both dominated by that one
product decision.

**Still open:** the service's own ceiling. The network here saturates so far
below it that CPU and pool never came under pressure, so "what binds on a fast
uplink" is unmeasured and needs the app on real hosting with the generator
elsewhere. What the run removes is the uncertainty about what to look for.

The original entry follows, as written.

---


The load test runs clean — roughly 4,000 uploads across ~30 runs at concurrency
5–40, at 12 MP and 2 MP, **zero failures**. No 429s, no 500s, no pool exhaustion,
and storage accounting matched bytes written on every run. What it cannot tell you
is how many weddings one instance carries.

Uploads are storage-bound, and the Docker Desktop volume on Windows drifts 25–50%
between measurements minutes apart — the same disk benchmark read 83.4 MB/s and
then 62.5 MB/s twenty minutes later. Measured throughput for identical code
ranged **2.46 to 13.44 uploads/sec**.

What *is* stable is p50 latency, reproducible within ±10% across repetitions and
across two different generator placements:

| Concurrency | p50 |
|---|---|
| 5 | ~0.52 s |
| 10 | ~0.68 s |
| 20 | ~1.3–2.2 s |
| 40 | ~3.1–3.9 s |

Roughly linear past c=10 — the signature of a saturated resource. **The knee is
around 10 concurrent uploads.** CPU peaked at 789% of the 1600% available and
repeatedly dropped to 0.1% mid-run; the database never exceeded 8%. The
application is not the constraint here. The disk is.

A number worth quoting needs `STORAGE_PROVIDER=r2` and the generator on a
separate host. `scripts/load-test.ts` now prints this caveat itself, so the
figure can't be misread later.

### G3 — Two files over the 800-line limit — **CLOSED (2026-09-13)**

No file in the repository now exceeds 800 lines. `src/i18n/index.ts` is 120
lines (a runtime over per-language tables in `src/i18n/translations/`) and
`src/services/storageService.ts` is 285. The two oversized route files found
later in the same pass — `server/routes/events.ts` (1073) and
`server/routes/photos.ts` (1013) — were split into composed sub-routers, and
`HostDashboard.tsx` (986) into a context provider with tab consumers.

### G4 — Purge leaves empty directories behind — **CLOSED**

`purgeEventMedia()` now calls `storageAdapter.removeEventDirectory()`
(`server/lib/retention.ts:326`), which `rmdir`s both the uploads and quarantine
sides. `rmdir` only succeeds on a genuinely empty directory, so a directory
that still holds files is deliberately left alone: a non-empty one after a
purge means a file delete failed, and what is still in there is someone's
wedding. Covered by `tests/unit/localStorageAdapter.spec.ts`.

### G5 — Docs don't reflect the current state — **CLOSED (2026-09-13)**

Brought up to date against the code:

- `docs/ARCHITECTURE.md` — the FTP ingest server, the shared photo-write path
  (`server/lib/photoWrite.ts`), the composed sub-routers and the retention/mail
  subsystem were all missing from both the topology diagram and the Layer 2
  list. A whole ingest path absent from an architecture document is the kind of
  omission that makes the document worse than none.
- `docs/OPERATIONS.md` — said "two sweeps"; there are three, and the one it
  omitted is the notice sweep that the other two are downstream of. Now states
  plainly that `RETENTION_ENFORCED=true` deletes nothing while SMTP is unset,
  and that once SMTP is configured it permanently deletes wedding photos.
- `docs/TEST_SPEC_COVERAGE.md` — said 57 spec files as of 2026-09-05; there are
  118 and 1241 tests. Coverage figures and the newer spec groups added.
- `STORAGE_AND_FINANCIAL_PLAN.md` — new §11 covering the three findings that
  bear on the cost model: the silent storage-leak class, the capacity figure
  still not being measurable (§6's per-instance assumption is unvalidated), and
  storage misconfiguration now failing fast rather than costing nothing while
  losing everything.

Every file path and every `npm run` command cited across `docs/`, `README.md`
and `STORAGE_AND_FINANCIAL_PLAN.md` was checked to exist.

The original entry follows, as written.

---


`docs/` and `STORAGE_AND_FINANCIAL_PLAN.md` don't mention this session's
findings: the three storage-leak bugs, the WebSocket regression, the sharp
threadpool change, or the disk-bound load-test result.

`STORAGE_AND_FINANCIAL_PLAN.md` has been corrected where it was factually wrong
(the free-tier claim around line 88 now agrees with the audit section that had
contradicted it 180 lines later), but it hasn't been rewritten around what was
learned.

### G6 — Storage falls back to local disk silently — **CLOSED**

`createStorageAdapter()` (`server/lib/storage.ts:173`):

```ts
if (CONFIG.STORAGE_PROVIDER === 'r2' && CONFIG.R2_ACCOUNT_ID && CONFIG.R2_ACCESS_KEY_ID) {
  return new R2StorageAdapter();
}
return new LocalStorageAdapter();
```

Any of these ends up writing to container-local disk with **no warning logged**:

- `STORAGE_PROVIDER` misspelled, or set to `S3`, `cloudflare`, `R2` (it is
  case-sensitive)
- the variable named `STORAGE_DRIVER` instead — an easy mistake, because older
  drafts of `STORAGE_AND_FINANCIAL_PLAN.md` used that name
- R2 credentials absent or typo'd

In production on an ephemeral container filesystem, that means **every wedding
photo is lost on the next redeploy**, and nothing anywhere says so. The app looks
completely healthy.

Worth fixing before the R2 deployment: if `STORAGE_PROVIDER` is set to anything
other than `local`, and the R2 adapter cannot be constructed, crash at startup
rather than falling back. `server/lib/config.ts` already does exactly this for
`JWT_SECRET` — same pattern.

**CLOSED.** `server/lib/config.ts:96-135` now throws at startup for an
unrecognised `STORAGE_PROVIDER`, for `r2` with any of `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` missing, and for `r2` without
`R2_PUBLIC_URL` — the last because without it every photo uploads successfully
and is then permanently unloadable in a browser, which is the same silent
failure in a different costume.

### The recurring bug pattern

Three of the five bugs fixed this session were the same mistake: **delete the
row, leak the bytes.** Each photo is stored three ways since migration 007 —
`storage_path` (display), `original_storage_path`, and `thumbnail_url` — and each
buggy site deleted a subset.

It is a nasty class because it is invisible. Once the row is gone nothing
references the file, so nothing 404s, no test fails, and the quota counter says
the space was freed. It only shows up on the storage bill.

**Any new code path that removes media must delete all three**, and
`toStoragePath()` (`server/lib/storage.ts`) exists to normalise the URL-valued
column. `npm run storage:orphans` is how you find out whether you got it right.

---

## Fixed, for reference

Don't re-investigate these. Each has a regression test that was **proven to fail
when the bug is reintroduced** — not merely written and observed to pass.

| Bug | Where | Consequence had it shipped |
|---|---|---|
| Photo delete removed only the display copy | `server/routes/photos.ts:583` | Original (~90% of the bytes) and thumbnail orphaned, while `storage_bytes` was decremented in full. Delete-and-reupload accumulated unbilled storage indefinitely. |
| `purgeEventMedia` never deleted thumbnails | `server/lib/retention.ts` | Every expired album leaked its thumbnails permanently — billed on R2, unreachable once the rows were gone. |
| WebSocket upgrades refused from the app's own origin | `server/ws/wsServer.ts` | `CORS_ORIGIN` lists port 6500 (Vite); the app serves on 6501. Live feed, projector wall and reactions were **entirely dead** in the Docker deployment. HTTP kept working, which is why it went unnoticed. |
| `sharp.concurrency()` left at 16 | `server/lib/images.ts` | 40 concurrent uploads requested 640 threads on 16 cores. p95 at c=5 was ~1.9 s; now ~0.75 s. |
| Load test deleted its event without purging storage | `scripts/load-test.ts` | The source of the 15 GB of orphans. Each run now purges first and reports what it freed. |

Tests live in `tests/unit/purgeAndOrigin.spec.ts` (6 tests).

---

## Gotchas

Things that cost time to rediscover. None of these are bugs; they are all
"the system behaves this way and won't tell you".

### Test ports are hand-allocated and collide silently

Vitest runs spec files **in parallel**, so any spec that starts a real HTTP
server needs a port no other spec claims. There is no central registry, so
check this table before adding one:

| Port | Spec |
|---|---|
| 6589 | `tests/e2e.test.ts` |
| 6590 | `tests/run-all-tests.ts` |
| 6593 | `moderationAndReveal.spec.ts` |
| 6594 | `exportDownload.spec.ts` |
| 6595 | `storageQuota.spec.ts` |
| 6596 | `ingestRoutes.spec.ts` |
| 6597, 6598 | `purgeAndOrigin.spec.ts` |
| 6599 | `serverRoutes.spec.ts` |

**The failure mode is confusing:** the spec passes when run on its own and fails
in the full suite, reporting `Hook timed out in 10000ms` on `beforeAll`. The real
cause is buried further down as `EADDRINUSE`. If you see a `beforeAll` timeout
that only happens in the full suite, check the port first.

### Environment variables that change behaviour without saying so

| Variable | If unset or wrong |
|---|---|
| `STORAGE_PROVIDER` | Silently writes to local disk — see G6. Case-sensitive, must be exactly `r2`. |
| `CORS_ORIGIN` | Lists port **6500** (Vite dev server); the app serves on **6501**. Same-origin WebSockets are now allowed explicitly regardless, but anything else added here must include the real serving origin. |
| `RETENTION_ENFORCED` | Absent → sweep reports only, deletes nothing. See D1. |
| `AUTO_MIGRATE` | Defaults on; migrations run at boot (`server/index.ts:82`). Set `false` to disable — but then a schema change ships without its migration and endpoints 500 on missing columns. This has happened before: migration 006 went unapplied against an existing Docker volume and `GET /api/photos` 500'd on every call. |
| `UV_THREADPOOL_SIZE` | Set to 16 in the `Dockerfile`. Node defaults to **4** regardless of CPU count, which throttles sharp badly. If you change base images, carry this over. |
| `DB_POOL_MAX` | Defaults to 40. The original 20 caused pool exhaustion and 500s during upload bursts. |

### Demo accounts

Seeded by migration 007 and authenticated through the normal login route — they
are real accounts, not a bypass.

- `demo.couple@wedmoments.bg` — role `couple`
- `demo.planner@wedmoments.bg` — role `planner`
- Password for both: `WedMomentsDemo2026!`

Verified working against the running server on 2026-08-30 (`POST /api/auth/login`
→ 200).

### Camera and microphone need a secure context

`getUserMedia` only works on `https://` or `localhost`. Opening the app over a
LAN IP such as `http://192.168.0.35:6501` on an Android phone silently gives no
camera and no microphone — the permission prompt never appears, so it reads as a
permissions bug rather than a transport one.

For phone testing you need a tunnel (Cloudflare Tunnel works, verified). Full
detail in `docs/HTTPS_AND_PERMISSIONS.md`. `src/utils/mediaSupport.ts`
distinguishes `insecure_context` from `unsupported_browser` so the UI can say
which it is.

---

## Verification commands

Known-good as of 2026-08-30.

```bash
npx vitest run                      # 23 files, 156 tests, all passing
npx tsc --noEmit -p tsconfig.json   # clean

npm run storage:orphans             # report-only; add -- --delete to reclaim
npm run storage:recount             # rebuild storage_bytes from actual files
npm run retention:report            # what retention WOULD delete; deletes nothing

docker exec wedmoments-app npm run loadtest -- --concurrency 10 --uploads 150
```

The load test writes real photos and cleans up after itself. If you interrupt a
run, check `npm run storage:orphans` afterwards.

---

## Pre-Production Architecture & Code Review Findings (2026-09-04)

Comprehensive deep-dive inspection of the codebase produced on 2026-09-04 by Senior Software Engineering Pre-Production Review.

---

### 1. Critical & High-Priority Issues Found

#### [CRITICAL] Issue P1 — Broken Plan Upgrade Pipeline (Frontend Confetti vs Backend 403 Gate)
- **Files Involved**:
  - `src/components/host/PricingPlansModal.tsx:29-43`
  - `src/App.tsx:117-119`
  - `src/services/storageService.ts:600-618`
  - `server/middleware/tierGate.ts:28-41`
  - `server/routes/events.ts:322-354`
- **What is wrong**:
  When a host selects "Celebration Pass" (49 €) or "VIP Deluxe" (89 €) in `PricingPlansModal.tsx`, the client triggers confetti, sets `event.planTier = newTier` in `localStorage`, and issues `PUT /api/events/:id` with `{ planTier: newTier }`.
  However:
  1. `UpdateEventSchema` in `server/routes/events.ts` intentionally ignores `planTier` because `tierGate.ts` reads directly from the `subscriptions` table.
  2. No checkout / payment gateway integration or server upgrade API exists (`POST /api/subscriptions/upgrade`).
  3. The `subscriptions` table row remains `tier = 'free'`.
- **Why it matters**:
  Any user who attempts to use paid features (photo moderation, retro disposable camera mode, custom themes, audio guestbook, ZIP memory export, or uploading >50 photos) is immediately blocked with `403 Forbidden` (`TIER_REQUIRED` or `TIER_LIMIT_REACHED`). On page refresh, `refreshEventFromBackend()` resets the client tier back to `free`.
- **Severity**: **CRITICAL**
- **Suggested Fix**:
  1. Create a server-side endpoint `POST /api/subscriptions/upgrade` (or integrate Stripe/payment webhooks) to update the `subscriptions` row in PostgreSQL.
  2. In development/demo environments, add a direct database tier upgrade handler so hosts can switch plans cleanly.
  3. Ensure `PricingPlansModal` awaits API confirmation before updating local state.

---

#### [CRITICAL] Issue P2 — Mobile `localStorage` Quota Crash on Base64 Photo/Audio Ingestion
- **Files Involved**:
  - `src/services/storageService.ts:697-738`
  - `src/services/offlineQueueService.ts:55-78`
  - `src/components/camera/CameraCaptureModal.tsx:278-308`
- **What is wrong**:
  `CameraCaptureModal.tsx` passes raw uncompressed image data URLs (`originalUrl: dataUrl`, 5–15 MB each) into `storageService.addPhoto()`. The `storageService` attempts to save the photo list containing full data URLs into `localStorage.setItem('wedmoments_photos_' + eventId, ...)`.
  Similarly, `offlineQueueService.enqueue('photo', uploadPayload)` attempts to serialize the full Base64 payload into `localStorage`.
- **Why it matters**:
  Standard mobile browsers (iOS Safari, Android Chrome) enforce a hard 5 MB quota on `localStorage` across the entire origin. The very first or second high-resolution photo will trigger `QuotaExceededError`. The offline queue catches the error and silently drops the upload (`[OfflineQueue] localStorage quota exceeded, item dropped.`), resulting in permanent guest photo loss when connectivity drops.
- **Severity**: **CRITICAL**
- **Suggested Fix**:
  1. Never store full-resolution `originalUrl` data URLs in `localStorage`. Store only lightweight downscaled thumbnails or ephemeral object URLs.
  2. Migrate `offlineQueueService` and offline media caching to **IndexedDB**, which provides hundreds of megabytes of structured binary storage on mobile devices.

---

#### [HIGH] Issue P3 — Un-debounced Keystroke HTTP Storm & Slug Race Condition in Host Dashboard
- **Files Involved**:
  - `src/components/host/HostDashboard.tsx:450-525`
  - `server/routes/events.ts:303-416`
  - `src/router/index.ts:102-134`
- **What is wrong**:
  Form inputs in `HostDashboard.tsx` (`hostName`, `title`, `slug`, `venueName`, `welcomeMessage`) invoke `onUpdateEvent()` on every single `onChange` event without debouncing.
  Typing a 20-character venue name fires 20 simultaneous `PUT /api/events/:id` HTTP requests. Out-of-order network arrival causes earlier keystrokes to overwrite later ones.
  Additionally, updating the event date uses legacy query param formatting (`window.history.replaceState({}, '', '/?event=' + newSlug)`), bypassing the application router.
- **Why it matters**:
  Causes backend connection pool spikes, race conditions, corrupt event slugs, and broken client routing history.
- **Severity**: **HIGH**
- **Suggested Fix**:
  1. Wrap host form inputs in local React state and debounce server synchronization (e.g. 500ms debounce), or provide an explicit "Save Changes" action.
  2. Route slug and date changes through `router.navigate('host', newSlug)`.

---

#### [HIGH] Issue P4 — In-Process FTP Daemon Transmits Ingest Keys in Cleartext Without TLS
- **Files Involved**:
  - `server/ftp/ftpServer.ts:74-84, 120-130`
  - `server/lib/config.ts:54-60`
- **What is wrong**:
  When `FTP_ENABLED=true` is enabled for in-camera photographer tethering, `ftp-srv` starts on port 2121. Unless `FTP_TLS_CERT` and `FTP_TLS_KEY` are explicitly provided in `.env`, it operates in plain, unencrypted FTP mode. Photographer ingest keys (`wm_ing_...`) are sent in cleartext across the local venue Wi-Fi on the `PASS` command.
- **Why it matters**:
  Any attendee or rogue device running a packet capture tool on the venue network can intercept the photographer ingest key and inject unauthorized photos into the live feed and TV projector.
- **Severity**: **HIGH**
- **Suggested Fix**:
  1. Require TLS for FTP by default in production, or prominently display a security banner in the host ingest dashboard when plain FTP is active.
  2. Direct photographers to use the HTTPS VIP Ingest Portal (`/e/:slug/ingest`) on unsecured Wi-Fi.

---

#### [HIGH] Issue P5 — Non-Atomic Event Slug Collision Check on Concurrent Registration
- **Files Involved**:
  - `server/routes/events.ts:226-236`
  - `server/routes/auth.ts:66-72`
- **What is wrong**:
  Slug uniqueness is checked using an application-level `SELECT id FROM events WHERE slug = $1`, followed by an `INSERT`. If two events with the same host name are registered simultaneously, both check queries return no existing row, and the second insert fails with an unhandled PostgreSQL unique constraint error (`23505`) resulting in an internal 500 error.
- **Why it matters**:
  Intermittent 500 errors during registration spikes or simultaneous onboarding.
- **Severity**: **HIGH**
- **Suggested Fix**:
  Catch PostgreSQL error code `23505` (`idx_events_slug` violation) and retry with an incremental nanoid/timestamp suffix.

---

### 2. Medium & Low Priority Items

#### [MEDIUM] Issue P6 — Ephemeral Reaction Flood on Big Screen Projector
- **Files Involved**:
  - `server/routes/events.ts:456-483`
  - `src/components/projector/LiveProjectorScreen.tsx:71-84`
- **What is wrong**:
  Guests can rapidly tap or spam reaction buttons (hearts, cheers, claps). While rate limiting exists per IP, a room with 100+ guests spamming reactions can flood the WebSocket channel and cause DOM thrashing and frame drops on the TV projector browser.
- **Suggested Fix**: Client-side throttle (max 5 reactions/sec per guest) and batch WebSocket reaction deliveries.

#### [MEDIUM] Issue P7 — Audio Recording Base64 Payload Overhead
- **Files Involved**:
  - `server/routes/audio.ts:70-83`
  - `src/components/audio/AudioGuestbook.tsx`
- **What is wrong**:
  Voice messages (60–120s WebM audio) are encoded as Base64 JSON payloads, inflating payload sizes by 33%.
- **Suggested Fix**: Stream audio recordings as binary `multipart/form-data` (`upload.single('audio')`), mirroring the raw photo upload endpoint.

#### [LOW] Issue P8 — Production Bundle Overhead from Unused Mock Fixtures
- **Files Involved**:
  - `src/services/mockData.ts`
  - `src/components/host/ModerationQueue.tsx`
- **What is wrong**:
  Mock data arrays (`INITIAL_PHOTOS`, `INITIAL_GUESTS`) remain bundled in the production build even when `VITE_SEED_DEMO_DATA=false`.
- **Suggested Fix**: Dynamically import mock fixtures only when `?demo=1` is present.

---

### 3. Missing Test Suites

The following test suites should be added to `tests/unit/` and `tests/run-all-tests.ts`:

1. **`tests/unit/tierGatingIntegration.spec.ts`**:
   - Verify that all paid routes (`PUT /api/events/:id` with moderation, disposable mode, custom themes; `POST /api/audio`; `POST /api/events/:id/export-token`) return `403 TIER_REQUIRED` for `free` plan and `200/201` for `celebration_pass` / `deluxe_keepsake`.
2. **`tests/unit/indexedDbQueue.spec.ts`**:
   - Verify offline media queuing, persistent offline storage across reloads, and automatic background flushing upon network restoration.
3. **`tests/unit/slugConcurrency.spec.ts`**:
   - Concurrently create 10 events with identical host names and assert 0 failed requests and 10 unique slugs.
4. **`tests/unit/photographerIngestKey.spec.ts`**:
   - Test key creation, SHA-256 validation, batch multipart upload, and rejection after revocation (`DELETE /api/ingest/keys/:id`).

---

### 4. Recommended Remediation Order

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 1: Tier Gating & Subscription Upgrade Pipeline (Issue P1)            │
│  ├── Implement POST /api/subscriptions/upgrade route in backend             │
│  └── Connect PricingPlansModal to persist active subscriptions in Postgres  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 2: Mobile Storage & IndexedDB Offline Queue (Issue P2)                │
│  ├── Strip raw Base64 originalUrls from localStorage                        │
│  └── Implement IndexedDB storage adapter for offline photo/audio queue      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 3: Host Dashboard Debouncing & Slug Concurrency (Issues P3 & P5)     │
│  ├── Debounce host branding inputs by 500ms                                 │
│  └── Add retry-on-conflict handler for atomic slug generation               │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 4: Ingest & FTP Security Hardening (Issue P4)                         │
│  └── Add TLS enforcement / plaintext warning for camera FTP ingestion      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 5: Automated Test Suite Expansion                                    │
│  └── Implement tier gating, slug concurrency, and ingest key test specs     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 5. Critical Files to Protect (Touch With Extra Care)

1. `server/middleware/tierGate.ts` — Authoritative backend tier verification logic.
2. `server/lib/db.ts` — Connection pool and query execution.
3. `database/migrations/008_storage_accounting_and_retention.sql` — PostgreSQL triggers managing `events.storage_bytes`.
4. `server/ws/wsServer.ts` — Event room separation and host/guest message isolation.
5. `server/lib/downloadToken.ts` — Signed HMAC tokens for memory-safe ZIP export streaming.

---

## Full-Stack Security & Vulnerability Audit (Multi-Agent Swarm Review — 2026-09-04)

Deep-dive multi-agent security inspection across Authentication, Authorization, Media Pipelines, FTP Daemons, Database Concurrency, Triggers, WebSockets, and Frontend DOM security.

---

### Domain 1: Authentication, Authorization & Identity Security

#### [CRITICAL] SEC-A1 — Cross-Tenant Media Exfiltration & IDOR via Relative Storage Paths
- **Files**: `server/routes/photos.ts:317-353, 398-408`, `server/routes/events.ts:654-716`
- **Vulnerability**: In `POST /api/photos`, if a client supplies an internal storage path (e.g. `/uploads/events/<victim-id>/photo.jpg`) instead of a `data:` URL, `decodeDataUrl` returns `null`. The handler skips buffer saving, retains the supplied relative path as `displayStoragePath`, and commits it under the attacker's `eventId`. When the attacker calls `GET /api/events/<attacker-id>/export-zip`, the server streams and packages the victim event's private photos into the attacker's archive without tenant ownership verification.
- **Severity**: **CRITICAL** (CWE-639, CWE-200)
- **Remediation**: Strictly enforce that `fullUrl` and `originalUrl` in `POST /api/photos` MUST begin with `data:image/` (or be a validated raw multipart upload) and reject client-supplied `/uploads/` paths. In `export-zip`, verify that each photo's `storage_path` begins with `/uploads/events/${eventId}/`.

---

#### [HIGH] SEC-A2 — Guest Identity Spoofing & BOLA / IDOR Across Guest APIs
- **Files**: `server/routes/photos.ts:274-295, 469-553`, `server/routes/audio.ts:41-67`, `server/routes/quests.ts:124-162`, `server/routes/guests.ts:31-49`
- **Vulnerability**: Endpoints accept arbitrary unauthenticated `guestId` UUIDs from request bodies without session verification:
  1. **Comment/Like Impersonation**: Attackers can submit comments or likes using another guest's UUID; the server resolves that guest's name from PostgreSQL and attributes the action to them.
  2. **Guest Quota Depletion**: Supplying a victim's `guestId` counts uploads against their `max_photos_per_guest` cap.
  3. **Photographer Profile Tampering**: `ingestPipeline.ts:85` defines the official photographer as `device_fingerprint = 'photographer'`. An unauthenticated guest can send `POST /api/guests` with `deviceFingerprint: "photographer"` and overwrite the official photographer's profile name and table number.
- **Severity**: **HIGH** (CWE-284, CWE-639)
- **Remediation**: Issue a cryptographically signed guest session cookie/token on initial onboarding; bind all mutations (likes, comments, uploads, quests) to the verified session. Disallow client modification of reserved fingerprints (`'photographer'`, `'system'`).

---

#### [HIGH] SEC-A3 — Global Rate Limiting Bypass via `X-Forwarded-For` Spoofing (`trust proxy = 1`)
- **Files**: `server/index.ts:23`, `server/middleware/rateLimit.ts:23-32, 59-67`
- **Vulnerability**: Unconditional `app.set('trust proxy', 1)` allows remote clients to forge `X-Forwarded-For` headers when the server is directly exposed or upstream proxies do not overwrite client headers.
- **Severity**: **HIGH** (CWE-345, CWE-770)
- **Remediation**: Make `trust proxy` configurable via environment variable (`CONFIG.TRUST_PROXY`) and implement account-level progressive delays on failed login attempts.

---

#### [HIGH] SEC-A4 — Cross-Site WebSocket Hijacking (CSWSH) via Permissive Origin Check Fallback
- **Files**: `server/ws/wsServer.ts:39-58`, `server/lib/config.ts:41-42`
- **Vulnerability**: In `wsServer.ts:51`, if `CONFIG.CORS_ORIGIN` is unset or `false`, the origin validator executes `if (!CONFIG.CORS_ORIGIN) return true;`, allowing cross-origin WebSocket upgrades from any arbitrary third-party website (`https://malicious-site.com`).
- **Severity**: **HIGH** (CWE-346, CWE-1385)
- **Remediation**: Change fallback to fail closed (`if (!CONFIG.CORS_ORIGIN) return false;`), strictly requiring matching authority against `req.headers.host`.

---

#### [HIGH] SEC-A5 — Missing JWT Algorithm Pinning, Stateless Revocation & Query Parameter Leakage
- **Files**: `server/middleware/auth.ts:24-30, 52`, `server/lib/downloadToken.ts:29, 42`, `server/ws/wsServer.ts:94-97`
- **Vulnerability**: 
  1. `jwt.verify()` calls omit `{ algorithms: ['HS256'] }`.
  2. Tokens are valid for 7 days without database-backed revocation or `token_version` checks on password changes.
  3. WebSocket connection URLs pass host JWT tokens in query parameters (`?token=...`), leaking credentials into access logs, proxy logs, and browser history.
- **Severity**: **HIGH** (CWE-327, CWE-613, CWE-598)
- **Remediation**: Pin `algorithms: ['HS256']`, add `token_version` validation in `requireAuth`, and authenticate WebSockets via an initial post-handshake message.

---

#### [MEDIUM] SEC-A6 — Account Enumeration & Bcrypt Timing Side-Channel
- **Files**: `server/routes/auth.ts:38-40, 139-153`
- **Vulnerability**: Registration explicitly confirms existing emails (`409 Email already registered`). Login returns immediately (~1ms) on missing emails vs ~90ms when running `bcrypt.compare`, enabling timing-based user enumeration.
- **Severity**: **MEDIUM** (CWE-204, CWE-208)
- **Remediation**: Execute a dummy bcrypt comparison on non-existent emails to normalize execution time.

---

#### [MEDIUM] SEC-A7 — Silent Bcrypt Password Truncation at 72 Bytes
- **Files**: `server/routes/auth.ts:18, 25`, `server/middleware/auth.ts:33-41`
- **Vulnerability**: Zod permits passwords up to 128 characters, but `bcrypt` silently truncates input at 72 bytes. Characters past byte 72 are ignored.
- **Severity**: **MEDIUM** (CWE-326)
- **Remediation**: Pre-hash passwords with SHA-256 before passing to `bcrypt`, or cap password schema to 72 characters.

---

#### [MEDIUM] SEC-A8 — Unpartitioned Global `STORAGE_KEYS.EVENT` Leaks Host Email Across Albums
- **Files**: `src/services/storageService.ts:30, 510-534`
- **Vulnerability**: `STORAGE_KEYS.EVENT` uses a single unpartitioned key (`wedmoments_event`). When multiple albums are browsed on the same device, cached host emails and user IDs persist across different wedding albums.
- **Severity**: **MEDIUM** (CWE-200)
- **Remediation**: Partition event storage keys by event ID/slug (`wedmoments_event_${eventId}`).

---

### Domain 2: Media, File Upload, Storage & Sharp Processing Security

#### [CRITICAL] SEC-M1 — Heap Memory Exhaustion DoS via In-Memory Multipart Batch Ingest
- **Files**: `server/routes/ingest.ts:23-26`, `server/routes/photos.ts:20-23`
- **Vulnerability**: `multer.memoryStorage()` with `files: 200` and `MAX_UPLOAD_SIZE_MB = 50` permits a single request to load up to **10 GB** of binary buffer data directly into Node.js heap memory, triggering an instant process OOM crash.
- **Severity**: **CRITICAL** (CWE-400, CWE-770)
- **Remediation**: Limit batch multipart ingest to a maximum of 10–20 files per request and stream uploads to disk or temporary storage.

---

#### [HIGH] SEC-M2 — Sharp Decompression Bomb & Memory Duplication in `buildDerivatives`
- **Files**: `server/lib/images.ts:47-70`
- **Vulnerability**: `buildDerivatives` uses `{ failOn: 'none' }`, omits `limitInputPixels`, and executes **two concurrent resize pipelines** via `Promise.all` on the uncompressed raw buffer. A 100MP image requires >1.2 GB of RAM during concurrent processing.
- **Severity**: **HIGH** (CWE-400)
- **Remediation**: Set `limitInputPixels: 40_000_000`, validate image metadata dimensions (max 8000x8000), generate thumbnails sequentially from the display buffer, and use `failOn: 'warning'`.

---

#### [HIGH] SEC-M3 — Missing Magic Byte Validation & Arbitrary File Upload in Audio Guestbook
- **Files**: `server/routes/audio.ts:27-89`, `server/lib/storage.ts:232-276`
- **Vulnerability**: `POST /api/audio` decodes `audioUrl` and saves it via `saveBase64ToStorage` without validating magic bytes or verifying audio streams. `saveBase64ToStorage` relies solely on substring matching (`header.includes('webm')`), allowing arbitrary files to be stored.
- **Severity**: **HIGH** (CWE-434)
- **Remediation**: Validate audio magic bytes on the decoded buffer before saving to disk/R2.

---

#### [MEDIUM] SEC-M4 — Disguised Non-Image / Audio Injection into Photos Table
- **Files**: `server/routes/photos.ts:323-380`, `server/lib/validation.ts:23-42`
- **Vulnerability**: `photos.ts` uses `validateMagicBytes()` (which accepts audio formats) instead of `isImageMagicBytes()`. When Sharp fails to decode an audio file submitted to `/api/photos`, the error is swallowed in `try/catch` and committed to the `photos` table.
- **Severity**: **MEDIUM** (CWE-434)
- **Remediation**: Use `isImageMagicBytes()` strictly in `photos.ts` and abort the upload if derivative generation fails.

---

#### [MEDIUM] SEC-M5 — Unauthenticated Public Access to Moderated & Pre-Reveal Disposable Photos
- **Files**: `server/index.ts:43`, `server/routes/photos.ts:354-408`
- **Vulnerability**: `app.use('/uploads', express.static(CONFIG.UPLOADS_DIR))` serves all files publicly. Photos pending moderation (`status = 'pending'`) or locked under disposable mode (`is_locked = true`) are saved directly under `/uploads/events/:eventId/` and are accessible if the URL is known.
- **Severity**: **MEDIUM** (CWE-284)
- **Remediation**: Store pending/locked uploads in a quarantined directory (`uploads/quarantine/`) and move them to public storage only upon host approval or reveal deadline expiry.

---

#### [LOW] SEC-M6 — Directory Path Flaw in `LocalStorageAdapter.delete`
- **Files**: `server/lib/storage.ts:48-52, 58-61`
- **Vulnerability**: If `storagePath === '/uploads/'`, `filePath === uploadsRoot` evaluates to true, attempting an `unlink` on the root uploads folder.
- **Severity**: **LOW** (CWE-22)
- **Remediation**: Ensure `filePath.startsWith(uploadsRoot + path.sep)` and verify `(await stat(filePath)).isFile()`.

---

### Domain 3: In-Process FTP Daemon & Hardware Ingestion Security

#### [HIGH] SEC-F1 — Plaintext Ingest Key Transmission over Venue Wi-Fi (FTP Without Forced TLS)
- **Files**: `server/ftp/ftpServer.ts:74-84, 120-130`, `server/lib/config.ts:54-60`
- **Vulnerability**: In-process FTP defaults to unencrypted plain FTP on port 2121 unless certificates are supplied. Photographer ingest keys (`wm_ing_...`) are sent in cleartext across open venue Wi-Fi networks on the `PASS` command.
- **Severity**: **HIGH** (CWE-319)
- **Remediation**: Require FTPS (AUTH TLS) in production and display a clear warning banner in the host studio when unencrypted FTP is active.

---

#### [HIGH] SEC-F2 — Event Listener Leak & Race Condition on Multiple FTP Logins
- **Files**: `server/ftp/ftpServer.ts:103-105`
- **Vulnerability**: `connection.on('STOR', ...)` is bound inside the `ftpServer.on('login', ...)` callback. Re-authentications accumulate multiple `'STOR'` listeners, causing concurrent duplicate ingest calls, database duplicates, and `ENOENT` exceptions on file deletion.
- **Severity**: **HIGH** (CWE-400, CWE-362)
- **Remediation**: Call `connection.removeAllListeners('STOR')` prior to attaching the handler, or attach once upon connection creation.

---

#### [HIGH] SEC-F3 — Disk Exhaustion via Orphaned Staging Files on Aborted Transfers
- **Files**: `server/ftp/ftpServer.ts:36-41, 59-61`
- **Vulnerability**: `handleStoredFile` returns immediately if `err !== null` without deleting the partial file in `ftp-staging/<eventId>/`.
- **Severity**: **HIGH** (CWE-400)
- **Remediation**: Ensure `fs.promises.unlink(serverPath)` executes inside a `finally` block for all aborted/errored transfers.

---

#### [MEDIUM] SEC-F4 — Event Loop Freezing via Synchronous `fs.readFileSync`
- **Files**: `server/ftp/ftpServer.ts:44`
- **Vulnerability**: `fs.readFileSync(serverPath)` blocks the single-threaded Node.js event loop while reading 20–50MB DSLR raw frames from disk.
- **Severity**: **MEDIUM** (CWE-400)
- **Remediation**: Replace with `await fs.promises.readFile(serverPath)`.

---

#### [MEDIUM] SEC-F5 — Missing Rate Limiting on In-Process FTP Authentication
- **Files**: `server/ftp/ftpServer.ts:87-98`
- **Vulnerability**: FTP login attempts have no rate limiting or failed attempt lockouts, allowing rapid offline/online dictionary attacks against ingest keys.
- **Severity**: **MEDIUM** (CWE-307)
- **Remediation**: Implement IP-based connection throttling and temporary bans after 5 failed authentication attempts.

---

### Domain 4: Database Integrity, Concurrency & Tier Gate Security

#### [HIGH] SEC-D1 — TOCTOU Concurrency Flaw Bypasses Plan Storage Quota & Photo Limits
- **Files**: `server/routes/photos.ts:261-269, 338-344`, `server/lib/ingestPipeline.ts:67-70`, `server/middleware/tierGate.ts:110-191`
- **Vulnerability**: Storage quota and photo count checks read current usage via non-isolated `SELECT` queries before writing files. During an upload burst (50+ guests uploading simultaneously), concurrent requests pass validation before any row is inserted, allowing a Free Tier event (capped at 50 photos) to store hundreds of photos without upgrading.
- **Severity**: **HIGH** (CWE-367, CWE-841)
- **Remediation**: Enforce limits atomically within a database transaction using row locks (`SELECT storage_bytes FROM events WHERE id = $1 FOR UPDATE`) or a PostgreSQL `BEFORE INSERT ON photos` trigger that raises an exception when the plan limit is exceeded.

---

#### [HIGH] SEC-D2 — Storage Accounting Trigger Flaw on Event Reassignment & Missing Constraints
- **Files**: `database/migrations/008_storage_accounting_and_retention.sql:42-71`
- **Vulnerability**:
  1. Trigger `update_event_storage_bytes()` fails to decrement `OLD.event_id` when media is moved between events.
  2. No `CHECK (storage_bytes >= 0)` constraint exists on `events`, `photos`, or `audio_guestbook`.
  3. Every insert fires an `UPDATE` on `events`, causing `RowExclusiveLock` serialization bottlenecks on high-concurrency bursts.
- **Severity**: **HIGH** (CWE-682)
- **Remediation**: Deploy Migration `009` to handle `OLD.event_id` updates, add `CHECK (storage_bytes >= 0)`, and optimize counter updates.

---

#### [HIGH] SEC-D3 — Cross-Tenant Guest Mutation & Foreign Key Isolation Gaps
- **Files**: `server/routes/photos.ts:470-498, 518-537`, `server/routes/quests.ts:137-155`, `server/routes/audio.ts:45-67`
- **Vulnerability**: Validating `guestId` in likes, comments, and quests checks only `WHERE id = $guestId` without verifying `event_id = target_event_id`. Guests from Event A can manipulate records in Event B. Additionally, invalid guest IDs trigger automatic unauthenticated guest creation on every comment/quest request, opening a table bloat vector.
- **Severity**: **HIGH** (CWE-284, CWE-639)
- **Remediation**: Require `WHERE id = $guestId AND event_id = $eventId` on all lookups and reject unknown IDs with `400 Bad Request`.

---

#### [MEDIUM] SEC-D4 — Missing Transactions in Multi-Step Mutations (Orphaned Storage & State Drift)
- **Files**: `server/routes/photos.ts:355-425`, `server/routes/events.ts:234-260`, `server/routes/auth.ts:167-174`
- **Vulnerability**: Multi-query operations (event creation + expiry update, photo insert + quest completion) are not wrapped in database transactions (`BEGIN ... COMMIT`). If a server crashes or query fails mid-sequence, partial records and orphaned storage files remain permanently.
- **Severity**: **MEDIUM** (CWE-662)
- **Remediation**: Wrap all multi-step operations in database client transactions (`const client = await pool.connect(); try { await client.query('BEGIN'); ... }`).

---

#### [MEDIUM] SEC-D5 — Non-Unique Active Subscriptions Causing Cartesian Joins
- **Files**: `database/migrations/003_host_accounts_and_subscriptions.sql:22-35`, `server/lib/retention.ts:69-75`, `server/middleware/tierGate.ts:114-139`
- **Vulnerability**: `subscriptions` lacks a unique partial index on active subscriptions per user. Multiple active rows result in duplicated candidate rows during retention sweeps and arbitrary tier selection in `getUploadContext`.
- **Severity**: **MEDIUM** (CWE-682)
- **Remediation**: Add `CREATE UNIQUE INDEX idx_subscriptions_user_active ON subscriptions (user_id) WHERE status = 'active';`.

---

#### [HIGH] SEC-D6 — Database Connection Pool Exhaustion via WebSocket `JOIN_EVENT_ROOM` Flooding
- **Files**: `server/ws/wsServer.ts:111-150`
- **Vulnerability**: Incoming `JOIN_EVENT_ROOM` frames trigger asynchronous PostgreSQL queries (`pool.query('SELECT host_user_id...')`) without frame rate limiting. A client sending 1000 frames/sec quickly exhausts the 40-connection database pool, causing all HTTP endpoints to hang.
- **Severity**: **HIGH** (CWE-400, CWE-770)
- **Remediation**: Validate UUID formats, throttle incoming WebSocket message rates (max 20 msg/10s per socket), and cache host ownership verification.

---

#### [LOW] SEC-D7 — Zombie Events Left on Host Account Deletion
- **Files**: `database/migrations/003_host_accounts_and_subscriptions.sql:41`
- **Vulnerability**: `events.host_user_id` is defined with `ON DELETE SET NULL`, leaving orphaned unmanageable events in the public gallery when a user account is deleted.
- **Severity**: **LOW** (CWE-284)
- **Remediation**: Implement an account deletion procedure that purges storage and deletes or archives associated events.

---

### Domain 5: Frontend DOM, XSS, Mobile Resilience & Real-Time Security

#### [MEDIUM] SEC-W1 — Potential Protocol Execution via Unsanitized Lightbox `download` Anchor
- **Files**: `src/components/gallery/LightboxModal.tsx:45-52`
- **Vulnerability**: `handleDownload` assigns `photo.fullUrl` directly to an `<a>` element's `href` and triggers `.click()`. An unmoderated photo payload with `javascript:` can execute scripts.
- **Severity**: **MEDIUM** (CWE-79)
- **Remediation**: Whitelist URL schemes (`https://`, `http://`, `data:image/`, `blob:`) before assigning to `link.href`.

---

#### [MEDIUM] SEC-W2 — 35-Megapixel Canvas Allocation Crash on Mobile Safari
- **Files**: `src/services/pdfPrintService.ts:105-126`, `src/components/host/QRCanvasStudio.tsx:389-403`
- **Vulnerability**: 300-DPI A2 rasterization allocates a 34.8M pixel canvas (~140MB GPU memory), exceeding mobile Safari's 4096px canvas limit and triggering immediate browser tab crashes.
- **Severity**: **MEDIUM** (CWE-400)
- **Remediation**: Detect mobile user agents and cap canvas dimensions to 4096px and 12M pixels on mobile devices.

---

#### [MEDIUM] SEC-W3 — Mobile WebProcess Crash via Synchronous Bulk Image Processing
- **Files**: `src/components/camera/CameraCaptureModal.tsx:274-325`
- **Vulnerability**: Selecting 20+ photos in bulk accumulates dozens of 10MB Base64 strings in memory concurrently, exceeding mobile RAM limits (300MB+) and triggering OS process termination.
- **Severity**: **MEDIUM** (CWE-400)
- **Remediation**: Cap bulk uploads to 10 photos per batch, yield to the event loop between file reads, and release object URLs immediately.

---

#### [MEDIUM] SEC-W4 — Moderation Bypass via Comments/Likes on Unapproved or Locked Photos
- **Files**: `server/routes/photos.ts:469-553`
- **Vulnerability**: Likes and comments do not verify `status = 'approved'` or disposable lock deadlines. Sending comments on a pending/rejected photo broadcasts `COMMENT_ADDED` over WebSockets to all guests in the live room.
- **Severity**: **MEDIUM** (CWE-284, CWE-200)
- **Remediation**: Verify `status IN ('approved', 'featured')` and enforce disposable lock windows in comment/like routes.

---

## Complete Vulnerability Matrix & Remediation Index

> **Status column added 2026-09-05.** The original table carried no status at
> all, so on its own it read as an open backlog even though Phases 0-6 below
> fixed every item except SEC-M5. Cross-checked against those phase tables.
> SEC-M5 itself was fixed later the same day — see the MED-03/SEC-M5 write-up
> at the end of this document.

| ID | Vulnerability | Domain | Severity | File Reference | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-A1** | Cross-Tenant Media Exfiltration / IDOR | Auth / API | **CRITICAL** | `server/routes/photos.ts:317` | **FIXED (Phase 0)** |
| **SEC-M1** | In-Memory Multipart Ingest Heap OOM DoS | Media / Uploads | **CRITICAL** | `server/routes/ingest.ts:23` | **FIXED (Phase 0)** |
| **SEC-A2** | Guest Identity Spoofing & BOLA in Guest APIs | Auth / Identity | **HIGH** | `server/routes/photos.ts:274` | **FIXED (Phase 2)** |
| **SEC-A3** | Global Rate Limiting Bypass via `trust proxy` | Auth / Network | **HIGH** | `server/index.ts:23` | **FIXED (Phase 0-4)** |
| **SEC-A4** | Cross-Site WebSocket Hijacking (CSWSH) | Real-Time / WS | **HIGH** | `server/ws/wsServer.ts:51` | **FIXED (Phase 6)** |
| **SEC-A5** | JWT Algorithm Pinning & Stateless Revocation | Auth / Crypto | **HIGH** | `server/middleware/auth.ts:24` | **FIXED (Phase 2)** |
| **SEC-M2** | Sharp Decompression Bomb & Memory Multiplier | Media / Sharp | **HIGH** | `server/lib/images.ts:47` | **FIXED (Phase 5)** |
| **SEC-M3** | Arbitrary Audio File Upload (Missing Magic Bytes) | Media / Audio | **HIGH** | `server/routes/audio.ts:27` | **FIXED (Phase 5)** |
| **SEC-F1** | Plaintext FTP Credential Transmission | Hardware / FTP | **HIGH** | `server/ftp/ftpServer.ts:74` | **FIXED (Phase 4)** |
| **SEC-F2** | FTP `STOR` Event Listener Leak & Race Condition | Hardware / FTP | **HIGH** | `server/ftp/ftpServer.ts:103` | **FIXED (Phase 4)** |
| **SEC-F3** | FTP Staging Disk Leak on Aborted Transfers | Hardware / FTP | **HIGH** | `server/ftp/ftpServer.ts:36` | **FIXED (Phase 4)** |
| **SEC-D1** | TOCTOU Storage Quota Concurrency Bypass | Database / Gates | **HIGH** | `server/middleware/tierGate.ts:110` | **FIXED (Phase 3)** |
| **SEC-D2** | Storage Accounting Trigger Defect & Row Locks | Database / Schema | **HIGH** | `database/migrations/008_...` | **FIXED (Phase 5)** |
| **SEC-D3** | Cross-Tenant Guest Operations & Table Bloat | Database / Multi-tenant | **HIGH** | `server/routes/photos.ts:470` | **FIXED (Phase 0)** |
| **SEC-D6** | Database Pool Exhaustion via WS Room Flooding | Real-Time / DB | **HIGH** | `server/ws/wsServer.ts:111` | **FIXED (Phase 5)** |
| **SEC-A6** | User Enumeration & Bcrypt Timing Side-Channel | Auth / Crypto | **MEDIUM** | `server/routes/auth.ts:139` | **FIXED (Phase 5)** |
| **SEC-A7** | Bcrypt Silent Password Truncation at 72 Bytes | Auth / Crypto | **MEDIUM** | `server/middleware/auth.ts:33` | **FIXED (Phase 5)** |
| **SEC-A8** | Global `STORAGE_KEYS.EVENT` Email Leak | Client Storage | **MEDIUM** | `src/services/storageService.ts:30` | **FIXED (Phase 5)** |
| **SEC-M4** | Disguised Non-Image Payload Ingestion | Media / Validation | **MEDIUM** | `server/routes/photos.ts:323` | **FIXED (Phase 5)** |
| **SEC-M5** | Static `/uploads` Exposure of Moderated Photos | Media / Static | **MEDIUM** | `server/index.ts:43` | **FIXED (2026-09-05)** — quarantine directory built; see MED-03/SEC-M5 write-up at end of document |
| **SEC-F4** | Synchronous `fs.readFileSync` in FTP Ingest | Hardware / FTP | **MEDIUM** | `server/ftp/ftpServer.ts:44` | **FIXED (Phase 4)** |
| **SEC-F5** | Unthrottled FTP Key Brute-Force | Hardware / FTP | **MEDIUM** | `server/ftp/ftpServer.ts:87` | **FIXED (Phase 4)** |
| **SEC-D4** | Missing Transaction Boundaries in Multi-Step Writes | Database / ACID | **MEDIUM** | `server/routes/photos.ts:355` | **FIXED (Phase 5)** |
| **SEC-D5** | Non-Unique Active Subscriptions Cartesian Join | Database / Schema | **MEDIUM** | `database/migrations/003_...` | **FIXED (Phase 3)** |
| **SEC-W1** | Unsanitized Lightbox `download` Scheme | Frontend / DOM | **MEDIUM** | `src/components/gallery/LightboxModal.tsx:45` | **FIXED (Phase 5)**, refined 2026-09-05 (FE-11) |
| **SEC-W2** | Mobile Safari 35MP Canvas Allocation Crash | Frontend / Canvas | **MEDIUM** | `src/services/pdfPrintService.ts:105` | **FIXED (Phase 6)** |
| **SEC-W3** | Mobile WebProcess Crash in Bulk Processing | Frontend / Memory | **MEDIUM** | `src/components/camera/CameraCaptureModal.tsx:274` | **FIXED (Phase 6)** |
| **SEC-W4** | Moderation Bypass via Comments on Locked Photos | Real-Time / Moderation | **MEDIUM** | `server/routes/photos.ts:469` | **FIXED (Phase 5)** |
| **SEC-M6** | Directory Path Check in Storage Adapter | Storage / Adapter | **LOW** | `server/lib/storage.ts:48` | **FIXED (Phase 6)** |
| **SEC-D7** | Zombie Events on Host Deletion | Database / Lifecycle | **LOW** | `database/migrations/003_...` | **FIXED (Phase 6)** |

---

## Verification pass on the above (2026-09-04)

Every SEC-* claim above was independently re-checked against the actual code (not
re-derived from this doc). 33 of 35 confirmed exactly as described. Corrections:

- **SEC-A4** severity is overstated — should be **MEDIUM**, not HIGH. The CSWSH
  bypass only exposes what any guest link already sees; host-only actions still
  require a separately-verified JWT.
- **SEC-A5**'s citation of `server/lib/downloadToken.ts:29,42` as evidence is
  wrong — that token is an intentionally narrow 5-minute single-purpose token,
  not the leak. The actual leaking token is the 7-day session JWT passed in the
  WebSocket connection query string (`wsServer.ts:94`).
- **SEC-D2**'s "trigger fails to decrement `OLD.event_id`" framing describes
  dead code — nothing in the codebase ever reassigns a photo's `event_id`.
  The `CHECK (storage_bytes >= 0)` gap in the same finding is real and is the
  part worth fixing.
- **SEC-D4**'s citation of `server/routes/auth.ts:167-174` is wrong — that's a
  single INSERT, nothing to partially-fail. The `events.ts` create+expiry gap
  in the same finding is real but low-impact (self-healing on retry).
- **SEC-W3** claims the bulk-upload memory pressure comes from `Promise.all`
  concurrency. It doesn't — `CameraCaptureModal.tsx` processes bulk files in a
  sequential `for...await` loop. The real gap is no cap on selected-file
  *count*, not on concurrency.

## Fixed (2026-09-04, Phase 0)

Regression-tested in `tests/unit/crossTenantSecurity.spec.ts` (11 tests) — each
one confirmed to fail against the pre-fix code before the fix was reapplied.

| Bug | Where | Consequence had it stayed |
|---|---|---|
| SEC-A1 — `fullUrl` accepted any string, not just a `data:` URL | `server/routes/photos.ts` (`CreatePhotoSchema`, and the `!displayData` guard) | A caller could plant another event's real `/uploads/...` path as their own photo's `storage_path`, then pull those bytes out through their own `export-zip`. Closed at both the schema and the handler guard; `events.ts` export-zip's local-disk fallback also now scopes to the exporting event's own subfolder as defense in depth. |
| SEC-M1 — photographer ingest accepted 200 files × 50MB per request | `server/routes/ingest.ts` | 10GB of buffers in memory for one request, behind only a valid ingest key. Capped to 20 files (`MAX_INGEST_FILES`). |
| SEC-D3 — guestId lookups for likes, comments, quest completions, audio guestbook entries, and photo uploads were not scoped by `event_id` | `server/routes/photos.ts` (like, comment, upload guest resolution), `server/routes/quests.ts`, `server/routes/audio.ts` | A guestId harvested from one event could act as that guest in a different event — impersonation, cross-tenant quota depletion, and a wrong guest's name/avatar showing up on another event's photo. Every guest lookup now scopes by `WHERE id = $1 AND event_id = $2`; an out-of-scope id is treated as not found (falls through to minting a fresh guest, same as an unknown id always did). |

Remaining Phase 0 item **not yet done**: none — SEC-A1, SEC-M1, SEC-D3 close out
Phase 0 as scoped. Phase 1 (P1, subscription upgrade pipeline) is next.

## Fixed (2026-09-04, Phase 1)

| Bug | Where | Consequence had it stayed |
|---|---|---|
| P1 — plan upgrade never reached the database | `server/routes/subscriptions.ts` (new), `src/services/storageService.ts` (`upgradePlanTier`), `src/components/host/PricingPlansModal.tsx`, `src/context/AppContext.tsx` | Host clicks a plan, sees confetti, gets locked out of every paid feature anyway, tier silently reverts to free on next load. `PUT /api/events/:id` ignored `planTier` (never in its field map) and no upgrade endpoint existed at all. |

Fix, by explicit decision (no real payment gateway — that stays out of scope
per this doc's own framing): `POST /api/subscriptions/upgrade` writes the
`subscriptions` row directly, authenticated, no client-trusted tier value
anywhere else. `PricingPlansModal` now awaits the call — confetti only fires
on confirmed success, and a failure shows an inline error instead of a fake
upgrade. **Before this reaches paying users, replace the endpoint's trigger**
with a verified payment webhook (Stripe or otherwise) instead of a direct
client call — the route file says the same thing at the top.

Regression tests: `tests/unit/subscriptionUpgrade.spec.ts` (5 tests) — covers
auth rejection, invalid tier rejection, persistence (GET /api/events reflects
the new tier immediately, not just the POST response), downgrade back to
free, and the Pro Planner event-limit bump (1 → 10).

## Fixed (2026-09-04, Phase 2)

| Bug | Where | Consequence had it stayed |
|---|---|---|
| P2 — offline queue in localStorage | `src/services/offlineQueueService.ts` (rewritten onto IndexedDB) | A raw capture's uncompressed `originalUrl` (5-15MB) serialized into the queued payload could exceed the origin's entire 5MB localStorage quota by itself; the old code caught `QuotaExceededError` and silently dropped the guest's photo. |
| SEC-A5 — JWT algorithm not pinned; session token in WS query string | `server/middleware/auth.ts`, `server/lib/downloadToken.ts`, `server/ws/wsServer.ts`, `src/services/storageService.ts` | `jwt.verify()` accepted any algorithm the token claimed. The 7-day host session token traveled in the WebSocket connection URL — access logs, proxy logs, browser history. |
| SEC-A2 — guestId alone treated as proof of identity | `server/lib/guestAuth.ts` (new), `server/routes/photos.ts`, `server/routes/quests.ts`, `server/routes/audio.ts`, `server/routes/guests.ts` | Every photo/comment response includes its `guestId` — public, not secret. Anyone viewing an event's feed could like, comment, deplete quota, or (via a reserved `deviceFingerprint`) overwrite the official photographer's profile, all attributed to a harvested guestId. |

**SEC-A5 fix**: `{ algorithms: ['HS256'] }` pinned on every `jwt.verify()` call.
WebSocket auth moved from `?token=` in the connection URL to an `AUTH` message
sent right after the socket opens — the server processes it before any
`JOIN_EVENT_ROOM` on the same connection. `downloadToken.ts`'s own token was
already correctly scoped (5-minute TTL, single purpose) and needed no
behavior change, only the same algorithm pin.

**SEC-A2 fix**: `issueGuestToken`/`verifyGuestToken` (`server/lib/guestAuth.ts`)
— a signed, long-lived token binding a browser to the specific guest row it
created or resolved. Issued by `POST /api/guests`, and by every route that
resolves a guest server-side (photo upload, comment, quest completion, audio
entry) in their **HTTP response only** — never in a WebSocket broadcast, which
every other guest in the room receives (this was caught by the fork test
before it ever shipped: the first draft put the token in the same object used
for both). Likes, comments, quest completions, and audio entries now require
a token matching the claimed guestId; a mismatch is treated as absent, same
as an unknown guestId. `RESERVED_DEVICE_FINGERPRINTS` (`'photographer'`,
`'system'`) rejected at both `POST /api/guests` and `POST /api/photos`.

**Client wiring**: `Guest.guestToken` persisted per event alongside the rest
of the guest record; every mutating call (`toggleLikePhoto`, `addComment`,
`completeQuest`, `addAudioEntry`, `addPhoto`) reads it from the stored current
guest and sends it. `storageService.syncGuestFromServer()` adopts a
server-minted id+token together if they ever diverge from what's stored
locally, so a stale/mismatched token self-heals instead of failing forever.

Regression tests: `tests/unit/offlineQueue.spec.ts` (rewritten for the async
IndexedDB API, 8 tests, includes enqueuing/flushing a payload too large for
the old localStorage ceiling), `tests/unit/guestIdentityAndWsAuth.spec.ts` (8
new tests — reserved fingerprints on both endpoints, a broadcast inspected
for the absence of `guestToken`, and all three WS auth cases). The WS
`?token=` regression was verified the same way as Phase 0: reverted, watched
it fail (`isHost` came back `true` from a query-string token again), reapplied.
Existing specs (`serverRoutes.spec.ts`, `crossTenantSecurity.spec.ts`,
`moderationAndReveal.spec.ts`) updated to send `guestToken` and to join over
an `AUTH` message instead of `?token=`. Full suite: 26 files, 182 tests.

## Fixed (2026-09-04, Phase 3)

| Bug | Where | Consequence had it stayed |
|---|---|---|
| SEC-D5 — no unique constraint on active subscriptions | `database/migrations/009_subscription_and_slug_integrity.sql` | Nothing stopped a second `active` subscription row per user; which one `getEffectiveTierForEvent`/`getUploadContext` picked (`ORDER BY created_at DESC LIMIT 1`) would depend on insert order rather than being well-defined. |
| P5 — slug uniqueness was check-then-insert | `server/routes/events.ts`, `server/routes/auth.ts`, `server/lib/errors.ts` (new `isUniqueViolation`) | Two events landing on the same slug in the same window — a registration burst, or two hosts typing the same URL — 500'd on the second one instead of getting a working account/event. |
| P3 — every keystroke in host settings fired a PUT | `src/hooks/useDebouncedField.ts` (new), `src/components/host/HostDashboard.tsx` | A 20-character venue name fired 20 concurrent PUT requests; out-of-order arrival meant an earlier keystroke could overwrite a later one. Date-change also used a legacy `/?event=slug` URL format instead of the router. |
| SEC-D1 — upload quota was check-then-insert | `server/middleware/tierGate.ts` (new `acquireEventUploadLock`), `server/routes/photos.ts`, `server/lib/ingestPipeline.ts` | A burst of concurrent uploads for the same event could all read the same stale photo-count/byte-total, all pass, and all insert — overshooting the free tier's 50-photo cap (or any tier's storage cap) by however many landed in the race window. |

**P5 fix**: the SELECT-then-INSERT slug check is gone. The INSERT is retried
(up to 5 attempts, a fresh suffix each time) specifically on Postgres
`23505` against the `events_slug_key` constraint — the only version of this
check that is actually atomic. `auth.ts`'s registration retries the whole
transaction (a rollback undoes the user/subscription rows too, so retrying
from scratch cannot violate the email-uniqueness check that ran first).

**P3 fix**: `useDebouncedField` — local state updates immediately so typing
stays responsive, the commit callback fires once 500ms after the last
keystroke. Applied to `hostName`, `title`, `slug`, `venueName`,
`welcomeMessage`. The slug field's live URL-bar preview (and the
date-change handler's slug update) now go through `router.navigate('host',
slug)` instead of raw `window.history.replaceState` with the legacy
`/?event=` format.

**SEC-D1 fix**: the existing cheap pre-check (before image processing) is
unchanged — it's just an optimization that rejects the obvious case early
without wasting a decode/resize. Immediately before the INSERT, a second
client acquires `pg_advisory_xact_lock(hashtext(eventId))` inside a
transaction, re-reads the upload context through *that* client, and
re-validates the allowance — so only one upload for a given event is ever
inside the check-and-insert at a time; uploads for different events never
contend. Applied to both `photos.ts`'s JSON upload path and
`ingestPipeline.ts` (shared by the batch ingest endpoint and the FTP
server), which are the two paths a real burst hits.

Regression tests: `tests/unit/slugConcurrency.spec.ts` (3 tests — a forced
explicit-slug collision on `POST /api/events`, a forced collision on
registration via a mocked `Date.now`, and a 10-way concurrent burst with
identical host names), `tests/unit/useDebouncedField.spec.ts` (4 tests),
`tests/unit/concurrentUploadQuota.spec.ts` (1 test — pre-seeds an event to 2
photos short of the free-tier cap, fires 5 concurrent uploads, asserts
exactly 2 succeed and the final count is exactly 50, never more). Both the
slug-collision and quota-race fixes were verified the same way as earlier
phases: reverted, watched the test fail (500 on collision; 5-for-5 success
overshooting the cap to 53 with the lock removed), reapplied. Full suite: 29
files, 190 tests.

Note: `tests/unit/migrate.spec.ts` has shown transient failures under full
suite runs and occasionally standalone (order/timing-dependent — schema
migration ledger state briefly out of sync during heavy parallel DB use).
Confirmed unrelated to Phase 0-3 changes across every prior full-suite run
this session; worth a separate look if it keeps recurring, but out of scope
here.

## Fixed (2026-09-04, Phase 4 — FTP hardening)

All five in `server/ftp/ftpServer.ts`, one pass, since they're all in the
same small file and touching it once was cheaper than five separate passes.

| Bug | Consequence had it stayed |
|---|---|
| SEC-F1/P4 — plain FTP only warned about, never refused | A production deploy with `FTP_ENABLED=true` and no TLS cert/key would silently serve plaintext FTP; the warning is a log line, easy to miss in container logs, and by the time anyone saw it the server was already accepting connections. |
| SEC-F2 — `STOR` listener stacked on re-auth | A connection re-authenticating (re-issuing USER/PASS without reconnecting) added another listener each time; one uploaded file then triggered the ingest pipeline once per login on that session — duplicate DB rows, and an `ENOENT` on the second unlink attempt. |
| SEC-F3 — aborted transfer's staged file never cleaned up | `handleStoredFile` returned on the `err` branch before reaching the `try/finally` that unlinked the file — every aborted transfer left its partial file in `ftp-staging/<eventId>/` permanently. |
| SEC-F4 — synchronous file read | `fs.readFileSync` on a 20-50MB DSLR frame blocked the single Node event loop for every other connection, HTTP and FTP alike, while it read. |
| SEC-F5 — no login throttle | Nothing stopped rapid-fire guessing against a photographer ingest key sent over the FTP `PASS` command. |

**SEC-F1/P4 fix**: `shouldRefusePlaintextStart(tlsConfigured, isProduction,
allowPlaintext)` — a pure function, so the decision is testable without
touching real env vars or sockets. `startFtpServer()` calls it before ever
constructing the `FtpSrv` instance; refusing logs an error and returns
without listening. New `FTP_ALLOW_PLAINTEXT` env var (default `false`) is
the explicit override for a deliberately trusted network.

**SEC-F2 fix**: `connection.removeAllListeners('STOR')` immediately before
`connection.on('STOR', ...)`, every login — a connection can only ever have
one.

**SEC-F3 fix**: the whole body of `handleStoredFile` (including the `err`
branch) now runs inside one `try/finally`, so the unlink in `finally` fires
for every path, not just the successful-read branch.

**SEC-F4 fix**: `fs.readFileSync` → `await fs.promises.readFile`.

**SEC-F5 fix**: an in-memory per-IP map (failures, blocked-until, last-seen)
— `MAX_LOGIN_FAILURES` (5) failures within the tracking window blocks that
IP for `LOGIN_BLOCK_MS` (60s); a successful login clears its record; a
size-triggered sweep drops entries older than an hour so the map can't grow
unbounded on a long-running server.

The `login` handler body was extracted into a standalone `handleLogin()`
(taking a minimal `FtpConnectionLike` instead of ftp-srv's real connection
class) specifically so SEC-F2 and SEC-F5 are testable against a real Node
`EventEmitter` mock instead of a real FTP client/socket — no new test
dependency needed.

Regression tests: `tests/unit/ftpServer.spec.ts` (14 tests) — the pure
`shouldRefusePlaintextStart` truth table, login-throttle unit tests, five
`handleLogin` cases against a real `EventEmitter`-based mock connection
(including one that logs in 3 times and asserts `listenerCount('STOR') ===
1`, not 3), and `handleStoredFile`'s cleanup-on-error path. SEC-F2 and
SEC-F3 were verified the same way as every fix this session: reverted,
watched the test fail (3 listeners; file left behind), reapplied. Full
suite: 30 files, 204 tests.

## Fixed (2026-09-04, Phase 5)

| Bug | Where | Consequence had it stayed |
|---|---|---|
| SEC-M2 — sharp had no input-pixel cap | `server/lib/images.ts` | A decompression-bomb image (huge pixel dimensions, small file) decoded fully into memory across three concurrent `sharp` pipelines before anything rejected it — OOM/DoS on a single upload. |
| SEC-M3 — `/api/audio` trusted the client's claimed MIME type | `server/routes/audio.ts` | A `data:` URL's declared `audio/webm` (or an already-hosted external URL) was accepted with zero byte inspection; arbitrary content could be hosted under this event's storage path. |
| SEC-M4 — photos endpoint used the combined image+audio magic-byte validator | `server/routes/photos.ts` | An image-only endpoint accepted audio-signature bytes as a "photo," and a header-only JPEG that `sharp` could not actually decode was still kept and served instead of rejected. |
| SEC-M5 — no quarantine directory for pending/locked photos | `server/lib/storage.ts` (not touched) | Deferred at the time — see note below. Fixed 2026-09-05, see end of document. |
| SEC-W1 — lightbox download built an `<a href>` straight from `photo.fullUrl` | `src/components/gallery/LightboxModal.tsx` | Defense-in-depth gap: with SEC-A1 open, a non-`http(s)`/`/`-scheme URL planted as `fullUrl` would be handed straight to a download link. |
| SEC-W4 — like/comment endpoints didn't check photo/event moderation state | `server/routes/photos.ts` | A guest who had a photo's ID (e.g., from a stale page) could like or comment on a still-pending or reveal-locked photo, bypassing the host's moderation queue and the event's reveal-time gate. |
| SEC-D6 — WS `JOIN_EVENT_ROOM` re-ran an uncached host-ownership query per message, no rate limit | `server/ws/wsServer.ts` | A malicious or buggy client could flood the socket with messages, each triggering a fresh DB round-trip — cheap client-side amplification into DB load. |
| P6 — one `REACTION_SENT` WS broadcast per tap | `server/ws/wsServer.ts`, `server/routes/events.ts` | A burst of reaction taps (a popular photo, many guests) meant one WS broadcast per tap to every connected client — no batching, needless message-count amplification. |
| SEC-A3 — (see Phase 0-4; `parseTrustProxy` covered here for completeness) | `server/index.ts` | Already-fixed trust-proxy parsing; this phase only added its regression coverage (`tests/unit/authHardening.spec.ts`). |
| SEC-A6 — login timing leaked whether an email exists | `server/routes/auth.ts` | A non-existent email skipped the bcrypt compare entirely, returning far faster than a real one — a timing side-channel for account enumeration. |
| SEC-A7 — bcrypt silently truncates at 72 bytes | `server/routes/auth.ts` (Zod schema) | Two different passwords sharing the same first-72-byte prefix (common with multi-byte UTF-8 passwords, where 72 bytes can be fewer than 72 characters) would hash identically and both work as login. |
| SEC-A8 — client cached one global `wedmoments_event` localStorage key | `src/services/storageService.ts` | A guest or host who'd viewed two different events on the same device/browser had the second event's cached data silently clobber the first's. |
| SEC-D2 — no DB-level guard on `storage_bytes` going negative | `database/migrations/010_storage_bytes_check_constraint.sql` | Nothing but application code stopped a buggy delete/decrement path from driving an event's, photo's, or audio entry's byte counter negative — a `CHECK` constraint is the only guarantee that survives a bug anywhere in the call chain. |
| SEC-D4 — event creation split into INSERT + separate `UPDATE ... SET expires_at` | `server/routes/events.ts` | A crash or error between the two statements left an event row inserted with no `expires_at` set — an event that should have expired never would, or vice versa depending on which write landed. |
| P7 — audio guestbook required a two-step dance (raw upload, then JSON `POST /api/audio` with the resulting URL) that SEC-M3's fix had broken | `server/routes/audio.ts`, `src/api/audioApi.ts`, `src/services/offlineQueueService.ts`, `src/services/storageService.ts`, `src/context/AppContext.tsx`, `src/components/audio/AudioGuestbook.tsx` | Recording a voice message no longer worked end-to-end once SEC-M3 required a real, byte-validated `data:` URL that the actual client never sent. |

**SEC-M2 fix**: `MAX_INPUT_PIXELS = 40_000_000` threaded into every `sharp(...)`
constructor in `buildDerivatives()` and `isDecodableImage()` via
`limitInputPixels`.

**SEC-M3 fix / P7 rewrite**: `POST /api/audio` is now Multer-based
(`memoryStorage`, `CONFIG.MAX_UPLOAD_SIZE_MB` limit), taking a real
multipart file under the `audio` field instead of a JSON `audioUrl`/`data:`
string. `validateMagicBytes` runs against the actual uploaded bytes before
`saveBuffer` is ever called. `requireEventTier('deluxe_keepsake')` is placed
*after* `upload.single('audio')` so the tier check sees the parsed
`eventId`. This also fixed a self-inflicted regression: the original
SEC-M3 patch (JSON-only, requiring a byte-valid `data:` URL) had silently
broken the real `AudioGuestbook.tsx` flow, which never sent a `data:` URL to
begin with — it did a separate raw upload first. The rewrite removes that
two-step dance entirely on both ends: `audioApi.create()` now builds
`FormData` with the blob directly; `storageService.addAudioEntry()` takes a
`Blob` and does the optimistic-local-preview / server-reconcile /
offline-queue dance that photos already had; `offlineQueueService.flushQueue()`
branches on `item.type === 'audio'` to rebuild `FormData` from a queued
blob; `AudioGuestbook.tsx`'s ~25-line manual fetch-then-POST dance collapsed
to one `onAddAudioEntry(recordedBlob, ...)` call.

**SEC-M4 fix**: `photos.ts`'s JSON `POST /` now uses `isImageMagicBytes`
(image-only) instead of the combined `validateMagicBytes`, and
`buildDerivatives()` is called and must succeed *before* any `saveBuffer` —
a photo sharp can't actually decode is now a 400, not a silently-kept file.

**SEC-M5**: skipped by explicit decision — the real fix is a storage-layout
change (a quarantine directory for photos pending moderation or still
reveal-locked, promoted into the public path only once approved/revealed).
That's a meaningful architecture change this late in the pass; documented
here as a known gap rather than rushed.

**Update (2026-09-05)**: built — see the MED-03/SEC-M5 write-up at the end
of this document for the full implementation.

**SEC-W1 fix**: `handleDownload` now refuses to build a download link unless
`photo.fullUrl` matches `/^(https?:|\/)/i` — defense-in-depth on top of
SEC-A1's server-side close.

**SEC-W4 fix**: the like and comment handlers in `photos.ts` now `SELECT
p.status, p.is_locked, e.reveal_at` (joined to `events`) before doing
anything else, and 403 (`This photo is not available yet.`) unless status is
`approved`/`featured` **and** either the photo isn't locked or the event's
reveal time has passed.

**SEC-D6 / P6 fix**: a per-connection sliding-window rate limit (20
messages / 10s) rejects excess WS messages outright. `JOIN_EVENT_ROOM`
validates the `eventId` shape first (`isValidUuid`) and looks up
host-ownership through a 60s-TTL cache instead of a fresh query every
message. Reactions no longer broadcast individually — `queueReaction()`
buffers per-event for up to 200ms (or 50 reactions, whichever first) and
flushes as one `REACTIONS_BATCH` message.

**SEC-A6 fix**: a real, precomputed bcrypt hash (`DUMMY_PASSWORD_HASH`) is
compared against on every login attempt for a nonexistent email, so the
bcrypt cost is paid identically whether or not the account exists.

**SEC-A7 fix**: the registration/password Zod schema `.refine()`s on the
UTF-8 byte length of the password (not character length), rejecting
anything over 72 bytes before it ever reaches bcrypt.

**SEC-A8 fix**: `STORAGE_KEYS.EVENT` changed from one shared string to a
per-event function (`wedmoments_event_${eventId}`); a separate
`ACTIVE_EVENT_ID` pointer key tracks which per-event slot is "current" on
this device.

**SEC-D2 fix**: idempotent `DO $ ... EXCEPTION WHEN duplicate_object ...`
migration adding `CHECK (storage_bytes >= 0)` to `events`, `photos`, and
`audio_guestbook`. Checked all three tables for existing negative values
(none) before applying.

**SEC-D4 fix**: the subscription lookup now also selects `tier`; `expiry` is
computed *before* the INSERT and included as a column in the same INSERT
statement — the separate `UPDATE events SET expires_at=...` call is gone,
closing the split-transaction gap.

Regression tests added/updated this phase: `tests/unit/mediaValidation.spec.ts`
(new — SEC-M2/M3/M4, 8 tests), `tests/unit/authHardening.spec.ts` (new —
SEC-A3/A6/A7), `tests/unit/moderationAndReveal.spec.ts` (SEC-W4, 2 new
tests), `tests/unit/serverAuth.spec.ts` (SEC-A6 decoy-hash exposure),
`tests/unit/storageService.spec.ts` (SEC-A8 per-event partitioning, P7 Blob
contract), `tests/unit/apiClient.spec.ts` (P7 Blob contract),
`tests/unit/crossTenantSecurity.spec.ts` and `tests/unit/serverRoutes.spec.ts`
(audio tests updated to the multipart contract). SEC-M2, SEC-A6, and SEC-A7
were toggle-verified (revert, confirm the specific test fails, reapply).

Note on test methodology: native `FormData`/`Blob` built in this
Vitest+jsdom environment does not survive a real `fetch()` round-trip in a
form Multer/busboy can parse (`req.file`/`req.body` come back empty
server-side) — confirmed via an isolated minimal-Multer debug spec with no
app code involved. Every multipart-uploading spec in this suite (matching
the pre-existing pattern in `tests/unit/ingestRoutes.spec.ts`) now hand-builds
the multipart wire format as a `Buffer` with explicit `--boundary` strings
instead of relying on native `FormData`.

Full suite: 34 files, 230 tests, all passing. `tests/unit/migrate.spec.ts`'s
known pre-existing timing flake (see Phase 3 note) did not reoccur this run.

## Fixed (2026-09-04, Phase 6)

The remaining LOW/MEDIUM cluster from the original punch list.

| Bug | Where | Consequence had it stayed |
|---|---|---|
| SEC-A4 — WS origin check fell back to allow-all | `server/ws/wsServer.ts` | With `CORS_ORIGIN` unset (the out-of-the-box default), any third-party page could open a WebSocket connection to this server — CSWSH. Verification pass downgraded this from the doc's HIGH to MEDIUM: a guest link's data was already visible to anyone with the link, so the real exposure was narrower than claimed, but still real. |
| SEC-M6 — `LocalStorageAdapter.delete`/`getAbsolutePath` treated the uploads root itself as a valid target | `server/lib/storage.ts` | `storagePath === '/uploads/'` resolved to the uploads directory itself (`filePath === uploadsRoot` was explicitly allowed); a delete call reaching that path attempted to unlink the whole directory. |
| SEC-W2 — QR/PDF poster rasterization had no mobile-specific cap | `src/services/pdfPrintService.ts` | An A2 poster at 300 DPI is 4960×7016px — under the existing 40M total-pixel desktop cap, but over mobile Safari's ~4096px-per-side canvas limit, so exporting one crashed the tab outright instead of just rendering slower. |
| SEC-W3 — bulk photo selection had no cap on file count | `src/components/camera/CameraCaptureModal.tsx` | Selecting 20+ photos piled up that many full-size `data:` URLs in memory via a sequential loop before any finished compressing — enough to get the tab killed by the OS on mobile RAM budgets. (Verification pass found the doc's claimed root cause — `Promise.all` concurrency — was wrong; the loop was already sequential. The real gap was the missing count cap.) |
| P8 — mock fixture arrays bundled into every build | `src/services/mockData.ts`, `src/services/storageService.ts` | `INITIAL_GUESTS`/`INITIAL_PHOTOS`/etc. were statically imported into `storageService.ts` and shipped in the production bundle regardless of demo mode. Investigating this surfaced a second, more serious bug in the same code: the per-getter fallback (`targetId === INITIAL_EVENT.id ? INITIAL_GUESTS : []`) fired for **any** fresh visitor with empty localStorage, not just demo mode — `getEvent()` returns the hardcoded demo event id whenever no active event is set yet, which `AppContext.tsx` reads as its very first, pre-route-resolution state. Every real first-time guest briefly got the fictional Bulgarian sample wedding's guests/photos in initial React state before the real event loaded. |
| SEC-D7 — `events.host_user_id` was `ON DELETE SET NULL` | `database/migrations/011_host_delete_cascade.sql` | No account-deletion feature exists in the app today (confirmed by search — this FK was unreachable in practice), but the policy was wrong regardless: deleting a host would have orphaned their events, live and public, with nobody able to manage them. |

**SEC-A4 fix**: the `!CONFIG.CORS_ORIGIN` fallback now returns `false`
instead of `true`. Same-origin requests are unaffected — they're already
allowed by the Host-header check earlier in `isAllowedOrigin`, which runs
first; only cross-origin requests with no allow-list configured are newly
refused.

**SEC-M6 fix**: `delete()` now requires `filePath.startsWith(uploadsRoot +
path.sep)` (dropping the `=== uploadsRoot` allowance) and confirms the
target `fs.promises.stat().isFile()` before unlinking — catches both the
root-directory case and any other directory under uploads.
`getAbsolutePath()` got the same containment tightening.

**SEC-W2 fix**: the scale computation was extracted into a pure
`computeRasterScale(spec, onScreenWidth, isMobile)` (so it's testable
without a live DOM node or `html2canvas`). On top of the existing 40M
total-pixel desktop cap, a mobile-only second pass caps both the longest
side to 4096px and the total to 12M pixels — whichever constraint bites
first.

**SEC-W3 fix**: `MAX_BULK_UPLOAD_FILES = 10`. A selection over the cap is
silently truncated to the first 10 and a translated notice
(`camera.bulk_limit_notice`, added to both locales) tells the guest how many
were dropped.

**P8 fix**: `storageService.ts` now statically imports only `INITIAL_EVENT`
(a single small object, used unconditionally as the default event shape).
The sample guests/photos/quests/audio/QR-config arrays are loaded via a
dynamic `import('./mockData')` inside a new `seedDemoData()`, called only
when `demoRequested` is true — a separate chunk fetched only when demo mode
is actually used. This also fixes the fresh-visitor leak: every per-event
getter's fallback is now unconditionally `[]` (or, for
`getQRCanvasConfig`, a generic non-demo default object), so a real guest
with no cache never sees fixture data, demo or otherwise.

**SEC-D7 fix**: `events_host_user_id_fkey` switched from `ON DELETE SET
NULL` to `ON DELETE CASCADE` — every child table under `events` (photos,
guests, quests, audio, ingest keys, QR config) already cascades from
`events` itself, so this makes user deletion clean up everything under
their account in one statement instead of leaving zombie events behind.
Asked before implementing (matching how P1's billing question and SEC-M5's
quarantine-directory question were handled earlier in this pass) since it's
a real data-destruction policy choice, not just a bug fix; cascade-delete
was the explicit choice made over documenting-as-gap.

Regression tests added: `tests/unit/wsThrottleAndReactions.spec.ts` (SEC-A4,
2 new tests — real WS handshakes with a fresh `WsEventManager` instance,
`CONFIG.CORS_ORIGIN` toggled at runtime since it's a plain mutable object),
`tests/unit/storageAdapter.spec.ts` (SEC-M6, 2 new tests — one of which
caught the old code trying to `unlink()` a real directory and throwing
`EPERM` on revert, direct proof of the flaw), `tests/unit/pdfPrintService.spec.ts`
(SEC-W2, 3 new tests against the extracted pure function), `tests/unit/cameraCaptureModal.spec.tsx`
(new file, SEC-W3, 2 tests — a real `fireEvent.change` on the hidden gallery
`<input multiple>` with 16 fake `File` objects), `tests/unit/storageService.spec.ts`
(P8, 2 new tests), `tests/unit/hostAccountCascade.spec.ts` (new file, SEC-D7,
1 test — registers a host through a real server, deletes the user row
directly, asserts the event row is gone too). Every fix in this phase was
toggle-verified: reverted, confirmed the specific test fails for the right
reason, restored.

All items from the original OPEN_ITEMS.md punch list (P1-P8, SEC-A1 through
SEC-W4) are now either fixed or explicitly documented as a deferred known
gap (SEC-M5's quarantine directory). The Gaps (G1-G6), Decisions (D1/D2),
and "Missing Test Suites" sections above predate this security pass and
remain open as separate, non-security backlog items.

---

## Multi-Agent Comprehensive Swarm Review (2026-09-04 — Full Architecture Audit)

A second multi-agent swarm review was fanned out across 4 specialized engineering disciplines:
1. **API & Authentication Security** (Session tokens, BOLA/IDOR, tier gating, rate limits, token forging)
2. **Media, Storage & Ingest Pipelines** (Sharp bounds, EXIF privacy, quarantine, R2 storage, FTP daemon, ZIP streaming)
3. **Database & Realtime Systems** (Row locks, connection pools, concurrency, transaction atomicity, triggers, WS backpressure)
4. **Frontend Architecture & Mobile UX** (IndexedDB lifecycle, React state sync, mobile Safari canvas limits, memory leaks, i18n)

---

### Master Open Items & Vulnerabilities Summary

> **Corrected 2026-09-05** — every row below was originally left marked
> **OPEN** even after Phases 7 and 8 (further down this document) fixed
> nearly all of them, and this table was never updated to match. That made
> the document self-contradictory: the narrative said "fixed," the summary
> said "open." Statuses below now reflect the actual code, cross-checked
> against the Phase 7/8 fix tables and, for FE-11 and SEC-05, against the
> code and git-blame-equivalent evidence directly (FE-11 was fixed without a
> phase writeup; SEC-05's retention-recompute half was found still-open
> during this correction pass and fixed today — see its own entry below).
> MED-03 was the only genuinely open item as of that correction; it was
> fixed later the same day — see the write-up at the end of this document.

| ID | Finding Title | Domain | Severity | File Reference | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | JWT Purpose Confusion & Host Privilege Escalation via Download Tokens | Auth / Crypto | **CRITICAL** | `server/middleware/auth.ts:52` | **FIXED (Phase 7)** |
| **SEC-02** | Uncounted Storage Depletion & Quota Bypass via Raw Uploads (`/upload/raw`) | Storage / Quota | **CRITICAL** | `server/routes/photos.ts:97` | **FIXED (Phase 7)** — endpoint removed |
| **DB-01** | Row-Lock Contention & Write Amplification via `FOR EACH ROW` Storage Triggers | Database / WAL | **CRITICAL** | `migrations/008_...:42` | **FIXED (Phase 7)** |
| **DB-02** | Missing Advisory Lock & Transaction Boundary in Audio Ingestion Allows Quota Bypass | Concurrency / Storage | **CRITICAL** | `server/routes/audio.ts:92` | **FIXED (Phase 7)** |
| **FE-01** | Poster Raster Scale Calculation Math Error on Mobile (Tiny 255px blurry exports) | Frontend / Canvas | **CRITICAL** | `src/services/pdfPrintService.ts:77` | **FIXED (Phase 7)** |
| **MED-01** | ZIP Export Unbounded Stream Flooding, EMFILE Exhaustion, Zip64 Missing & Deflate OOM | Export / Media | **HIGH** | `server/routes/events.ts:693` | **FIXED (Phase 8)** |
| **MED-02** | EXIF & GPS Location Data Leaked in Public Guest API (`originalUrl`) | Privacy / Metadata | **HIGH** | `server/routes/photos.ts:183` | **FIXED (Phase 7)** |
| **MED-03** | Quarantine Gap (SEC-M5): Unmoderated & Rejected Media Permanently Exposed on Disk/R2 | Storage / Moderation | **HIGH** | `server/routes/photos.ts:401` | **FIXED (2026-09-05)** — quarantine storage + host preview tokens; see write-up at end of document |
| **MED-04** | Ingest Multipart Batch Buffer Flooding (`MAX_INGEST_FILES = 20`) & Heap Spikes | Media / Memory | **HIGH** | `server/routes/ingest.ts:27` | **FIXED (Phase 8)** |
| **SEC-03** | Guest Identity Takeover & Token Minting via Predictable Device Fingerprint | Guest Auth / BOLA | **HIGH** | `server/routes/photos.ts:301` | **FIXED (Phase 7)** |
| **SEC-04** | Storage Path & Tenant Isolation Bypass in ZIP Export Stream (`appendFromStorage`) | IDOR / Tenant Isolation | **HIGH** | `server/routes/events.ts:711` | **FIXED (Phase 7)** |
| **SEC-05** | Unrestricted Self-Upgrade & Stale Retention Expiration (`events.expires_at`) Data Loss | Subscriptions / Retention| **HIGH** | `server/routes/subscriptions.ts:37` | **PARTIALLY FIXED (2026-09-05)** — see below |
| **DB-03** | Broken Keyset Pagination in Photo Feed Skips Photos When Priority is Used | SQL Queries / Feed | **HIGH** | `server/routes/photos.ts:238` | **FIXED (Phase 7)** |
| **DB-04** | WebSocket Slow-Consumer Memory Buildup & OOM Risk | Real-Time / WS | **HIGH** | `server/ws/wsServer.ts:304` | **FIXED (Phase 8)** |
| **DB-05** | Orphaned Media Files on Storage (R2 / Disk) Upon Transaction Rollback / Quota Rejection | Storage / Atomicity | **HIGH** | `server/routes/photos.ts:402` | **FIXED (Phase 7)** |
| **DB-06** | Multi-Event Limit Bypass via Concurrent `POST /api/events` Requests | Concurrency / Limits | **HIGH** | `server/routes/events.ts:217` | **FIXED (Phase 7)** |
| **FE-02** | IndexedDB Connection Premature Teardown (`db.close()`) & Aborted Transactions on iOS | Client Storage / IDB | **HIGH** | `src/services/offlineQueueService.ts:36` | **FIXED (Phase 7)** |
| **FE-03** | State De-synchronization & Gallery Duplication on Queue Flush / Backend Sync | React State / Sync | **HIGH** | `src/services/storageService.ts:434` | **FIXED (Phase 7)** |
| **FE-04** | Transient Blob URLs Stored in LocalStorage for Audio Guestbook (`ERR_FILE_NOT_FOUND`) | Client Storage | **HIGH** | `src/services/storageService.ts:1051` | **FIXED (Phase 8)** |
| **FE-05** | Accidental Wedding Slug Mutation on Host Date Picker Change (Breaks Printed QR Codes) | UI Logic / Routing | **HIGH** | `src/components/host/HostDashboard.tsx:527` | **FIXED (Phase 7)** |
| **FE-06** | Mobile Browser Heap Exhaustion (OOM Jetsam) during Bulk Photo Uploads | Mobile Performance | **HIGH** | `src/components/camera/CameraCaptureModal.tsx:226` | **FIXED (Phase 8)** |
| **SEC-06** | Missing Rate Limiting on Fingerprint Lookup & IP Limiter Bypass via Header Rotation | Network / Rate Limit | **MEDIUM** | `server/routes/guests.ts:77` | **FIXED (Phase 8)** |
| **SEC-07** | Disposable Mode & Moderation Bypass in Audio Guestbook & Showcase Feed | Moderation / Logic | **MEDIUM** | `server/routes/audio.ts:36` | **FIXED (Phase 8)** |
| **MED-05** | In-Process FTP Daemon: Unbounded Staging Writes, Heap DOS via `readFile` | Hardware / FTP | **MEDIUM** | `server/ftp/ftpServer.ts:100` | **FIXED (Phase 8)** |
| **MED-06** | R2 Adapter Silent Stream Drop in ZIP Export | Storage / Resiliency | **MEDIUM** | `server/lib/storage.ts:158` | **FIXED (Phase 8)** |
| **DB-07** | Unbounded Memory Leaks in `hostCheckCache` and `eventRooms` Maps | Memory / WS | **MEDIUM** | `server/ws/wsServer.ts:52` | **FIXED (Phase 8)** |
| **DB-08** | Non-Atomic Read-Then-Write Upserts in `qr-config` and `subscriptions/upgrade` | Concurrency / SQL | **MEDIUM** | `server/routes/events.ts:565` | **FIXED (Phase 8)** |
| **DB-09** | N+1 Database Write Roundtrips in `refreshExpiryDates()` | Database / Performance| `server/lib/retention.ts:68` | **FIXED (Phase 8)** |
| **DB-10** | Missing Foreign Key Cascade Indexes on `photo_likes`, `photo_comments`, `audio_guestbook` | DB Indexing | **MEDIUM** | `migrations/001_...:120` | **FIXED (Phase 8)** |
| **DB-11** | 32-Bit Advisory Lock Hash Collisions in `acquireEventUploadLock` | Concurrency / Locks | **MEDIUM** | `server/middleware/tierGate.ts:213` | **FIXED (Phase 8)** |
| **FE-07** | Browser History Stack Pollution during Slug Typing (25 Back Button Taps) | Frontend / History | **MEDIUM** | `src/components/host/HostDashboard.tsx:504` | **FIXED (Phase 7)** |
| **FE-08** | Silent Draft Loss on Component Unmount in `useDebouncedField` | React Hooks | **MEDIUM** | `src/hooks/useDebouncedField.ts:35` | **FIXED (Phase 8)** |
| **FE-09** | Hardcoded Bulgarian Strings in `PublicWeddingsShowcase` View | i18n | **MEDIUM** | `src/components/home/PublicWeddingsShowcase.tsx:286` | **FIXED (Phase 8)** |
| **MED-07** | Redundant Sharp Pipelines (3x Decode) & Pre-Orientation EXIF Dimension Inversion | Media / Sharp | **LOW** | `server/lib/images.ts:53` | **FIXED (Phase 8)** |
| **DB-12** | TOCTOU Slug Collision Race in `PUT /api/events/:id` | SQL Concurrency | **LOW** | `server/routes/events.ts:381` | **FIXED (Phase 8)** |
| **DB-13** | Inconsistent Fallback Event Creation in `POST /api/auth/login` | SQL / Logic | **LOW** | `server/routes/auth.ts:202` | **FIXED (Phase 8)** |
| **DB-14** | Storage Recount Script Omits Thumbnail Footprint | Accounting / Scripts | **LOW** | `scripts/storage-recount.ts:41` | **FIXED (Phase 8)** |
| **FE-10** | Hardcoded `'bg-BG'` Locale in QR Canvas Poster Live Preview | i18n / Date Format | **LOW** | `src/components/host/QRCanvasStudio.tsx:377` | **FIXED (Phase 8)** |
| **FE-11** | Lightbox Download Button Ignores Data and Blob URLs | Frontend / Lightbox | **LOW** | `src/components/gallery/LightboxModal.tsx:45` | **FIXED** — code and `tests/unit/lightboxModal.spec.tsx` confirm it, no phase writeup found |
| **DB-15** | Missing Timer Teardown on WebSocket Server Close (`reactionFlushTimers`) | WS / Lifecycle | **INFO** | `server/ws/wsServer.ts:54` | **FIXED (Phase 8)** |

**SEC-05 detail**: this finding bundled two separate claims. "Unrestricted
self-upgrade" is not a bug — it's the documented, deliberate scope of P1 (no
payment gateway exists yet; see `STORAGE_AND_FINANCIAL_PLAN.md` §8 and the
route file's own comment). "Stale retention expiration" was real and, as of
today, is fixed: `POST /api/subscriptions/upgrade` now calls
`refreshExpiryDates(userId)` after writing the new tier, so `events.expires_at`
moves to match the new plan's window immediately instead of waiting for the
next manual `retention:report`/`retention:sweep` run. Scoped to the
upgrading user's own events (not a full-table recompute) so a burst of
concurrent upgrades can't turn into a burst of full-table writes — the
unscoped first draft of this fix reproduced exactly that under
`concurrentUpserts.spec.ts`'s 5-concurrent-upgrade test before being scoped.
Regression test: `tests/unit/subscriptionUpgrade.spec.ts` ("recomputes the
event's expires_at..."), toggle-verified.

---

### Detailed Findings by Domain

---

#### 1. Authentication, Identity & Access Control (SEC-01 to SEC-07)

##### [CRITICAL] SEC-01 — JWT Purpose Confusion & Host Privilege Escalation via Download Tokens
- **Files**: `server/middleware/auth.ts:52-70`, `server/lib/downloadToken.ts:27-31`, `server/ws/wsServer.ts:178-188`
- **Flaw**: The application signs session JWTs, download tokens (`{ purpose: 'export-zip', eventId, userId }`), and guest tokens with the same secret (`CONFIG.JWT_SECRET`). `requireAuth` and WebSocket `AUTH` verify algorithm `HS256` but do not verify that `decoded.purpose` is undefined (or equal to `'host'`). Any 5-minute single-purpose download token query param found in proxy logs or browser history can be passed as `Bearer <token>` to hijack administrative APIs (`PUT /api/events/:id`, `DELETE /api/photos/:id`, `POST /api/ingest/keys`).
- **Remediation**: Use separate secrets (`JWT_DOWNLOAD_SECRET`, `JWT_GUEST_SECRET`) or check `if (decoded.purpose !== undefined || !decoded.email) return res.status(401)...`.

##### [CRITICAL] SEC-02 — Uncounted Storage Depletion & Quota Bypass via Raw Uploads
- **Files**: `server/routes/photos.ts:97-153` (`POST /api/photos/upload/raw`), `database/migrations/008_...sql`
- **Flaw**: `/upload/raw` saves files up to 50MB directly to disk/R2 but creates no database row in `photos` or `audio_guestbook`. Because `events.storage_bytes` is updated via table triggers on row insert, unattached raw uploads never increment `storage_bytes` or quota counters, allowing unlimited unbilled storage accumulation.
- **Remediation**: Eliminate unmanaged `/upload/raw` or save uploads into an ephemeral staging directory (`/tmp/staging`) with strict automatic TTL sweeps.

##### [HIGH] SEC-03 — Guest Identity Takeover & Token Minting via Device Fingerprint
- **Files**: `server/routes/photos.ts:301-320, 535`, `server/routes/guests.ts:35-70`
- **Flaw**: When a request to `POST /api/photos` or `POST /api/guests` lacks a valid `guestToken`, the backend queries `guests` by `deviceFingerprint`. If found, it issues a valid, signed `guestToken` for that guest row without verifying ownership, allowing anyone who supplies a known fingerprint to mint a cryptographic token for that guest.
- **Remediation**: Do not re-issue a `guestToken` for an existing guest row unless an existing valid token is supplied. Treat unauthenticated requests as fresh guest rows.

##### [HIGH] SEC-04 — Storage Path & Tenant Isolation Bypass in ZIP Export Stream
- **Files**: `server/routes/events.ts:711-732`, `server/lib/storage.ts:65-79`
- **Flaw**: In `GET /api/events/:id/export-zip`, `appendFromStorage` calls `storageAdapter.getStream(storagePath)`. `LocalStorageAdapter.getStream` only checks if the path is within `uploads/`, not `uploads/events/${id}/`. It returns a stream immediately, skipping the subfolder boundary check on lines 727-730 and allowing cross-tenant file exfiltration if photo rows reference other event paths.
- **Remediation**: Verify `storagePath.startsWith('/uploads/events/' + id + '/')` before invoking `getStream`.

##### [HIGH] SEC-05 — Unrestricted Self-Upgrade & Stale Retention Expiration Data Loss
- **Files**: `server/routes/subscriptions.ts:37-68`, `server/lib/retention.ts:48-84`
- **Flaw**: 
  1. `POST /api/subscriptions/upgrade` allows any authenticated user to set `tier: 'pro_planner'` without payment verification.
  2. The endpoint updates `subscriptions.tier` but does **not update `events.expires_at`** on existing events. Free tier events created with 7-day expiry retain their 7-day deadline and will be purged by retention sweeps even after upgrading to 1-year plans.
- **Remediation**: Connect upgrades to verified payment webhooks and recalculate `events.expires_at` for all host events in the upgrade transaction.

---

#### 2. Media, Processing, Storage & Hardware (MED-01 to MED-07)

##### [HIGH] MED-01 — ZIP Export Unbounded Stream Flooding, EMFILE Exhaustion & Deflate OOM
- **Files**: `server/routes/events.ts:693-759`
- **Flaw**:
  1. Synchronous `for` loop appends thousands of file streams to `archiver` without awaiting backpressure or stream completion, opening thousands of simultaneous file descriptors (`EMFILE`) or concurrent R2 HTTP streams.
  2. Deflate compression level is set to `zlib: { level: 9 }` on pre-compressed JPEGs/WebM files, pinning Node.js CPU cores at 100% for minutes and starving all other weddings.
  3. `forceZip64: true` is omitted, causing archive corruption when payloads exceed 4GB or 65,535 files.
  4. Omits `req.on('close')`, causing the server to continue streaming gigabytes after client disconnection.
- **Remediation**: Stream files sequentially using `archive.once('entry', ...)`, set `zlib: { level: 0 }` (Store mode), enable `forceZip64: true`, and abort on `req.on('close')`.

##### [HIGH] MED-02 — EXIF & GPS Location Data Leakage via Public `originalUrl`
- **Files**: `server/routes/photos.ts:183-248, 420-429`, `server/lib/ingestPipeline.ts:117`
- **Flaw**: Raw uploaded smartphone captures containing embedded GPS latitude/longitude and device metadata are stored as `originalStoragePath` and exposed as `originalUrl` in the public guest feed `GET /api/photos`. Any attendee can download camera originals and extract coordinates of private preparation locations.
- **Remediation**: Return `originalUrl: null` for regular guests (only expose to hosts), or strip GPS tags (`GPSInfo`) before persisting the original.

##### [HIGH] MED-04 — Ingest Multipart Batch Buffer Flooding (`MAX_INGEST_FILES = 20`)
- **Files**: `server/routes/ingest.ts:27-32, 130`, `server/lib/images.ts:53-76`
- **Flaw**: Multer uses `memoryStorage()` with `files: 20` and `50MB` per file, buffering up to 1GB of raw buffers in Node.js RAM per request. Concurrent photographer uploads trigger V8 Heap OOM crashes.
- **Remediation**: Stream multipart uploads to temporary disk files or lower `MAX_INGEST_FILES` and process sequentially.

---

#### 3. Database, Realtime & Concurrency (DB-01 to DB-15)

##### [CRITICAL] DB-01 — Row-Lock Contention & Write Amplification via `FOR EACH ROW` Triggers
- **Files**: `database/migrations/008_storage_accounting_and_retention.sql:42-71`, `server/lib/retention.ts:152`
- **Flaw**: `update_event_storage_bytes()` executes `UPDATE events SET storage_bytes = ...` `FOR EACH ROW`. Deleting 10,000 photos during a retention purge triggers 10,000 sequential UPDATEs on the exact same row in `events`, causing severe WAL bloat, table locking, query timeouts, and pool depletion.
- **Remediation**: Use statement-level triggers (`REFERENCING OLD TABLE`) or disable triggers during batch purges and reset `storage_bytes = 0` via a single update.

##### [CRITICAL] DB-02 — Missing Advisory Lock & Transaction Boundary in Audio Ingestion
- **Files**: `server/routes/audio.ts:92-112`
- **Flaw**: `audio.ts` checks storage allowances with a plain `SELECT` and inserts without transaction locking. 10 concurrent voice message uploads bypass plan storage caps completely.
- **Remediation**: Wrap in a transaction with `acquireEventUploadLock(client, eventId)` and re-check quota before committing.

##### [HIGH] DB-03 — Broken Keyset Pagination in Photo Feed Skips Photos When Priority is Used
- **Files**: `server/routes/photos.ts:238-245`
- **Flaw**: Query orders by `priority DESC, created_at DESC` but cursor checks `WHERE created_at < $cursor`. If a pro photo has `priority = 10` and earlier `created_at`, all subsequent guest photos uploaded after that timestamp are skipped and permanently hidden in pagination.
- **Remediation**: Use composite keyset cursor `WHERE (p.priority, p.created_at) < ($cursorPriority, $cursorCreatedAt)`.

##### [HIGH] DB-04 — WebSocket Slow-Consumer Memory Buildup & OOM Risk
- **Files**: `server/ws/wsServer.ts:304-316`
- **Flaw**: Broadcasts call `client.send(message)` without checking `client.bufferedAmount`. Slow mobile connections cause unbounded buffer accumulation in Node.js RAM.
- **Remediation**: Inspect `client.bufferedAmount > 512KB` and terminate stalled sockets.

##### [HIGH] DB-05 — Orphaned Media Files on Storage Upon Transaction Rollback
- **Files**: `server/routes/photos.ts:402-479`, `server/lib/ingestPipeline.ts:116-183`
- **Flaw**: Files are saved to R2/disk before opening the database transaction. If the quota check fails or database insert throws an error, the uploaded files remain orphaned in cloud storage forever.
- **Remediation**: Catch transaction errors and invoke `storageAdapter.delete()` on all staged paths.

##### [HIGH] DB-06 — Multi-Event Limit Bypass via Concurrent `POST /api/events` Requests
- **Files**: `server/routes/events.ts:217-270`
- **Flaw**: Verifies event limit via uncommitted `SELECT COUNT(*)`. Concurrent requests both read `0` and create multiple events on 1-event plans.
- **Remediation**: Acquire transaction advisory lock `pg_advisory_xact_lock(hashtext('user_events_' || userId))` during creation.

---

#### 4. Frontend Architecture & Mobile Web (FE-01 to FE-11)

##### [CRITICAL] FE-01 — Poster Raster Scale Calculation Flaw on Mobile Devices
- **Files**: `src/services/pdfPrintService.ts:77-94`
- **Flaw**: In `computeRasterScale`, `projectedWidth` is calculated as `spec.widthPx300Dpi * scale`, squaring the scale factor and projecting 4.4 billion pixels. The mobile dimension clamping reduces the scale to ~0.05, producing a tiny 255px blurry canvas instead of a 300-DPI poster.
- **Remediation**: Compute projected canvas size using `onScreenWidth * scale` instead of `spec.widthPx300Dpi * scale`.

##### [HIGH] FE-02 — IndexedDB Premature Connection Teardown & Aborted Transactions on iOS
- **Files**: `src/services/offlineQueueService.ts:36-66`
- **Flaw**: `withStore` calls `db.close()` immediately on `request.onsuccess` before `tx.oncomplete` commits to disk, causing WebKit/iOS Safari to abort readwrite transactions and lose offline media.
- **Remediation**: Close database connections only inside `tx.oncomplete`, `tx.onerror`, and `tx.onabort`.

##### [HIGH] FE-03 — State De-synchronization & Gallery Duplication on Queue Flush
- **Files**: `src/services/storageService.ts:434-443`, `src/services/offlineQueueService.ts:161-225`
- **Flaw**: `flushQueue()` uploads queued photos and deletes them from IndexedDB without notifying `storageService` of the server-assigned UUID. `syncFromBackend` retains the temporary `photo-...` local ID alongside the server ID, duplicating photos in the live feed.
- **Remediation**: Reconcile optimistic local IDs with server IDs upon upload completion.

##### [HIGH] FE-04 — Transient Blob URLs Stored in LocalStorage for Audio Guestbook
- **Files**: `src/services/storageService.ts:1051-1068`
- **Flaw**: `URL.createObjectURL(blob)` strings are saved in `localStorage`. Reloading the page revokes the blob URL, leaving audio entries with broken `ERR_FILE_NOT_FOUND` playback.
- **Remediation**: Store binary audio blobs in IndexedDB and generate object URLs on demand.

##### [HIGH] FE-05 — Accidental Wedding Slug Mutation on Host Date Picker Change
- **Files**: `src/components/host/HostDashboard.tsx:527-538`
- **Flaw**: Adjusting ceremony start time in the date picker automatically runs `generateSlug()`, silently changing the public wedding URL and breaking printed QR codes and guest links.
- **Remediation**: Remove automatic slug generation from the date picker; keep slugs immutable unless explicitly edited in the slug input field.

##### [HIGH] FE-06 — Mobile Browser Heap Exhaustion (OOM Jetsam) during Bulk Uploads
- **Files**: `src/components/camera/CameraCaptureModal.tsx:226-250`, `src/services/compressionService.ts:102-110`
- **Flaw**: `FileReader.readAsDataURL` loads up to 10 full-resolution images as raw Base64 strings in memory concurrently, exceeding mobile RAM limits (250MB+) and triggering tab termination.
- **Remediation**: Use `URL.createObjectURL(file)` and process compression sequentially.

##### [MEDIUM] FE-07 — Browser History Stack Pollution during Slug Typing
- **Files**: `src/components/host/HostDashboard.tsx:504-517`
- **Flaw**: `onChange` in slug input calls `router.navigate('host', slug)` on every keystroke, pushing dozens of history states.
- **Remediation**: Use `window.history.replaceState` or update preview without navigating.

##### [MEDIUM] FE-08 — Silent Draft Loss on Component Unmount in `useDebouncedField`
- **Files**: `src/hooks/useDebouncedField.ts:35-48`
- **Flaw**: Unmounting a field (e.g. switching tabs) clears the debounce timer without committing pending drafts.
- **Remediation**: Flush pending timer in `useEffect` cleanup hook or `onBlur`.

##### [MEDIUM] FE-09 — Hardcoded Bulgarian Strings in `PublicWeddingsShowcase`
- **Files**: `src/components/home/PublicWeddingsShowcase.tsx:286-414`
- **Flaw**: Entire public showcase feed and call-to-action buttons are hardcoded in Bulgarian and ignore the English language toggle.
- **Remediation**: Move all text into `i18n.t(...)` keys in `src/i18n/index.ts`.

---

### Non-Security Open Decisions & Backlog Gaps (Status Tracking)

| ID | Title | Domain | Status | Notes |
|---|---|---|---|---|
| **D1** | Retention Sweep Activation | Ops / Lifecycle | **DECIDED (2026-09-05): report-only for now** | Owner chose to keep `RETENTION_ENFORCED` off and run `npm run retention:report` on a schedule first, per this doc's own recommendation. First report run today: 961 events evaluated (almost entirely test-suite fixture events — `purge-spec-*`, `ftp-spec-*`, etc. — on this local dev database), 18 inside the 30-day grace window, **0 eligible for deletion yet**. Revisit enabling the sweep once the report has been reviewed a few times against real data. |
| **D2** | Event Deletion Route (`DELETE /api/events/:id`) | API / GDPR | **SUPERSEDED — the route exists (2026-09-13 review)** | The 2026-09-05 decision was to keep albums permanent. A delete route was added later (`server/routes/events/crud.ts:522`): it requires auth and ownership, takes a `confirmSlug` body checked against the stored slug, and purges storage *before* deleting the row — the ordering that matters, since the cascade takes away the only record of which objects belong to the album. This closes the GDPR erasure gap the original entry raised. |
| **G1** | UI Component Direct Test Coverage | Quality Assurance | **DONE (2026-09-05)** | All 27 components now have direct test suites. Top 6 highest-damage first (`LiveProjectorScreen`, `ModerationQueue`, `PhotographerIngestPortal`, `AudioGuestbook`, `PricingPlansModal`, `GuestOnboardingModal`, 42 tests), then the remaining 9 lower-risk ones (`HostAuthPage`, `HostEventsList`, `PhotographerIngestPanel`, `LandingHomePage`, `Navbar`, `BottomNav`, `WeddingHero`, `EventNotFound`, `LoadingSpinner`, 51 tests). 93 new tests total. A sample across both batches was mutation-tested (real logic broken, confirmed the test fails, reverted) to confirm the assertions aren't tautological. |
| **G2** | Cloud Capacity Benchmarking | Performance | **RUN 2026-09-13 — answered in part** | Run against live R2. Zero failures at c=5/10/20; throughput flat at 0.96/s while latency scaled linearly, and the saturated resource was identified directly as the host's uplink (8.7 MB/s measured with sharp, Postgres and HTTP removed from the path). Capacity reduces to `uploads/sec = uplink MB/s ÷ 9.1 MB`, and 93% of that payload is the retained original. The service's own ceiling is still unmeasured — the network saturates far below it — and that part needs real hosting with the generator elsewhere. Full tables: `docs/G2_CAPACITY_BENCHMARK_RUNBOOK.md` §Results. |
| **G3** | File Size Limit Refactoring (>800 lines) | Code Quality | **DONE (2026-09-05)** | `src/services/storageService.ts` (grown to 1240 lines) split into a thin composition-root class plus 12 domain modules (guests/photos/quests/audio/QR canvas/event/sync/realtime), each 30-280 lines. `src/i18n/index.ts` intentionally left as-is — a flat dictionary, not a class, and arguably fine at its size (per the original 2026-08-30 note). |
| **G4** | Purge Empty Directory Cleanup | Storage | **DONE (2026-09-05)** | `StorageAdapter.removeEventDirectory()` (optional, local-disk only); `purgeEventMedia()` calls it after the DB transaction commits. Regression tests in `storageAdapter.spec.ts` (empty/non-empty/missing-directory cases) and `retentionPurge.spec.ts` (spy confirming the call happens). Toggle-verified. |
| **G5** | Documentation Sync | Docs | **DONE (2026-09-05)** | `docs/API_REFERENCE.md`, `docs/SECURITY.md`, `docs/DATABASE_SCHEMA.md`, and `STORAGE_AND_FINANCIAL_PLAN.md` updated — removed the `upload/raw` endpoint (gone since Phase 7), corrected the audio endpoint to multipart, added the subscriptions/upgrade endpoint, corrected `events.host_user_id`'s FK behavior (SET NULL → CASCADE, migration 011), added migrations 008-012, and documented guest tokens / session-purpose pinning / WS hardening. See G7 below for a real gap this pass surfaced while verifying the docs against a production build. |
| **G6** | Fail-Fast Startup on Cloud Storage Config | Configuration | **DONE (2026-09-05)** | `server/lib/config.ts` now throws at startup for an unrecognized `STORAGE_PROVIDER` or an `r2` value missing any of `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, matching the existing `JWT_SECRET` pattern. Regression tests in `tests/unit/configValidation.spec.ts` (7 tests, `vi.resetModules()` + dynamic import per case). Toggle-verified. |
| **G7** | Demo fixture bundle-splitting doesn't actually work | Build / Bundle Size | **DONE (2026-09-05)** | P8 (Phase 6) intended `src/services/mockData.ts`'s demo-only arrays (`INITIAL_GUESTS`, `INITIAL_PHOTOS`, etc.) to ship only via a dynamic `import()` gated on `?demo=1`. They didn't: `INITIAL_EVENT` was *also* statically imported from the same file, so Rollup couldn't split the dynamic import into its own chunk and bundled the whole module, fixtures included, into the main chunk regardless of demo mode (confirmed by rebuilding the pre-split single-file code and reproducing the identical warning — this predates the G3 split). Fixed by moving `INITIAL_EVENT` into its own module (`src/services/defaultEvent.ts`) with no other exports; `mockData.ts`, `eventService.ts`, and `storageSyncService.ts` all import it from there instead. Verified: the `vite build` chunk-splitting warning is gone, `dist/assets/` now has a separate `mockData-*.js` chunk, and a string unique to the demo arrays (`Мартин Василев`, a sample guest name) is present in that chunk and absent from the main one — confirmed both before (present) and after (absent) the fix. No app code path changed, so covered by the existing full suite (43 files / 304 tests) rather than a new test. |

## Fixed (2026-09-04, Phase 7)

The 34 findings from the Multi-Agent Comprehensive Swarm Review above were
independently re-verified against live code by 4 parallel fork agents (one
per domain) before anything here was trusted — the same "don't trust the
doc" discipline as every earlier phase. That pass corrected several claims
(severities, wrong line citations, one claim that was actually already-fixed,
one duplicate of SEC-M5). This phase fixes every CRITICAL and HIGH item that
survived verification, plus FE-01 (a real bug discovered in this session's
own Phase 6 fix, fixed immediately regardless of severity). MEDIUM/LOW items
are deferred to a later phase.

| Bug | Where | Consequence had it stayed |
|---|---|---|
| FE-01 — mobile poster raster math squared the DPI width into itself | `src/services/pdfPrintService.ts` | The Phase 6 mobile-cap fix used `spec.widthPx300Dpi * scale` to project the output size, but `scale` already contains `spec.widthPx300Dpi` as a factor — silently collapsed every mobile poster export to ~257px, a blurry thumbnail instead of a print-resolution file. My own Phase 6 test used the same wrong formula, so it validated a self-consistent but wrong invariant and never caught it. |
| SEC-02 — `/upload/raw` wrote to storage with no photos/audio row | `server/routes/photos.ts` (removed), `src/api/photosApi.ts` | `storage_bytes` is only incremented by triggers on photos/audio_guestbook inserts; this endpoint bypassed both, so every byte saved through it was permanently invisible to quota accounting — unlimited unbilled storage. Confirmed dead: P7 (Phase 5) had already moved audio off its only real caller. |
| DB-02 — audio uploads had no advisory lock on the quota re-check | `server/routes/audio.ts` | SEC-D1 (Phase 3) added the locked re-check-and-insert pattern to photos and the FTP/ingest pipeline, but audio.ts's P7 rewrite (Phase 5) happened as a separate pass and never got it — concurrent voice-message uploads could bypass the plan's storage cap entirely. |
| SEC-01 — session JWTs, download tokens and guest tokens share one secret with no purpose check | `server/middleware/auth.ts`, `server/ws/wsServer.ts` | `requireAuth`/`optionalAuth`/WS `AUTH` accepted any validly-signed HS256 token and never checked it was actually a session token. A 5-minute export-zip download token (carries a real `userId`, sent in a URL query string where it can end up in proxy logs or browser history) could be replayed as `Bearer <token>` for full host-session equivalence — every `req.user!.userId === host_user_id` ownership check in the app would pass. |
| SEC-03 — a supplied deviceFingerprint alone minted a fresh guestToken | `server/routes/photos.ts`, `server/routes/guests.ts` | Fingerprints are client-generated and sent as plain, non-secret request fields. Anyone who obtained one (shared device, log, etc.) could mint a durable signed credential for that guest's identity and like/comment/upload as them indefinitely afterward — in `guests.ts`'s `GET /`, this was a pure unauthenticated lookup with zero other proof required. |
| SEC-04 — the ZIP export's event-scoping check was dead code for local storage | `server/routes/events.ts`, `server/lib/storage.ts` | The "last line of defense against exporting another event's files" only ran in the fallback branch, reached when `storageAdapter.getStream()` returned null — for `LocalStorageAdapter`, `getStream()` succeeds for any real file under `/uploads/` generally, not just this event's subfolder, so the primary branch returned early and the scoped check never actually ran. A photo row whose `storage_path` ever pointed cross-event (a bug, a bad insert, a migration artifact) would have streamed out through export-zip untouched. |
| MED-02 — `originalUrl` (raw camera capture, untouched EXIF/GPS) was sent to every guest | `server/routes/photos.ts` | `GET /api/photos` returned `originalUrl` unconditionally; only `status`/`is_locked` were host-gated. Any attendee with the event link could pull the guest feed and extract embedded GPS coordinates from an approved photo's original bytes. |
| DB-01 — bulk retention purge triggered thousands of sequential row-locked UPDATEs | `server/lib/retention.ts` | `update_event_storage_bytes()` is `FOR EACH ROW`; deleting thousands of photos in one purge fired that many individual `UPDATE events` statements against the exact same row — WAL bloat and row-lock contention. Currently dormant since `RETENTION_ENFORCED` is off by default, but real the moment it's turned on. |
| DB-03 — keyset pagination cursor ignored `priority`, silently skipping newer photos | `server/routes/photos.ts` | The feed orders by `priority DESC, created_at DESC` (photographer-sourced frames get `priority=10`), but the cursor only compared `created_at < $cursor`. Once pagination passed a high-priority-but-not-newest photo, every guest photo uploaded after that photo's own timestamp permanently failed the cursor filter and vanished from pagination — not reordered, hidden. |
| DB-05 — files were saved to storage before the quota re-check that could reject them | `server/routes/photos.ts`, `server/lib/ingestPipeline.ts` | Display/thumbnail/original copies are written before the locked, final storage-allowance check runs. A rejection at that check left the just-written files permanently orphaned — disk space or R2 billing with no DB row ever pointing at them. |
| DB-06 — concurrent event creation had no lock on the per-user event-count check | `server/routes/events.ts` | Verified via a plain `SELECT COUNT(*)` with no lock, unlike the upload-quota path SEC-D1 already fixed. Two concurrent `POST /api/events` for the same user could both read the same stale count and both pass a 1-event free-tier plan. |
| FE-02 — IndexedDB connection closed before the transaction actually committed | `src/services/offlineQueueService.ts` | `db.close()` ran as soon as `request.onsuccess` fired, not after `tx.oncomplete` — WebKit/iOS Safari treats a close mid-commit as a reason to abort the transaction outright, silently losing whatever was just written to the offline queue. |
| FE-03 — offline-queued photo uploads never reconciled their temp ID with the server's | `src/services/offlineQueueService.ts`, `src/services/storageService.ts` | `flushQueue()`'s success path only removed the queued item; it never told `storageService` the server-assigned UUID. The next `syncFromBackend()` pull added the server row as a brand-new photo while the local temp-ID row was never cleaned up — a permanent duplicate in the guest's own gallery. Audio didn't have this bug (its sync does a full unconditional overwrite); photos merge, so this needed explicit reconciliation. |
| FE-05 — the ceremony date/time picker silently regenerated the wedding slug | `src/components/host/HostDashboard.tsx` | The slug is the public URL — already texted to guests, printed on QR codes. Adjusting the date ran `generateSlug()` and pushed the new slug straight into `onUpdateEvent`, breaking every already-shared link with no warning. |
| FE-07 — the slug input's live preview pushed a new browser-history entry per keystroke | `src/components/host/HostDashboard.tsx`, `src/router/index.ts` | P3 (Phase 3) debounced the server write but left the live URL-bar preview calling `router.navigate()`, which always used `pushState`. Typing a 20-character slug pushed 20 history entries — a guest hitting back would need 20 taps to leave the page. |

**FE-01 fix**: `computeRasterScale` now tracks `factor = scale / naturalScale`
(how much of the full DPI target the current scale still reaches after any
desktop-cap shrink) and projects `spec.widthPx300Dpi * factor` /
`spec.heightPx300Dpi * factor` instead of re-multiplying by `scale` itself.
Verified the buggy formula reproduces exactly the reported ~257px failure
(confirmed via a standalone calculation before touching the fix) and that
the corrected formula caps the long side at exactly 4096px for a real A2
export.

**SEC-02 fix**: the route, its unused client method (`photosApi.uploadRaw`),
and its `UploadRawResult` type were removed outright. Three test files that
exercised it directly (`tests/unit/serverRoutes.spec.ts`,
`tests/e2e.test.ts`, `tests/run-all-tests.ts` — the latter two run outside
`vitest`, via `npm run test:e2e` and standalone respectively) were updated
to confirm 404 instead, and their downstream photo/audio assertions
(which depended on the removed endpoint's response) were rewired to use a
real sharp-encoded JPEG and real multipart audio bodies matching the actual
current contracts.

**DB-02 fix**: audio.ts's INSERT now runs inside a `pool.connect()`
transaction with `acquireEventUploadLock` and a fresh `getUploadContext`/
`checkUploadAllowance` re-check, identical in shape to the pattern SEC-D1
already established for photos and the ingest pipeline.

**SEC-01 fix**: `isSessionTokenPayload()` (new, exported from
`server/middleware/auth.ts`) rejects any decoded payload that carries a
`purpose` field or lacks `email` — a real session token never sets `purpose`
and always carries `email`; download tokens and guest tokens are the
opposite on both counts. Applied in `requireAuth`, `optionalAuth`, and the
WS `AUTH` message handler.

**SEC-03 fix**: tracked per-request whether the resolved guest identity was
actually proven (a verified token, or a row created fresh in this exact
request) versus merely fingerprint-matched onto a pre-existing row. A
`guestToken` is now only issued in the proven case — Postgres's `xmax = 0`
trick (`RETURNING (xmax = 0) AS inserted`) distinguishes a genuine INSERT
from the `ON CONFLICT` UPDATE branch without a second query. Fingerprint-only
matches still correctly attribute the action to the right guest (quota
continuity, the reason this fallback exists at all) — they just don't walk
away with a credential for an identity they never proved. `GET /api/guests`
(a pure lookup, confirmed zero real client callers) now never returns a
token at all.

**SEC-04 fix**: new `storagePathBelongsToEvent(storagePath, eventId)` in
`server/lib/storage.ts` checks for an `/events/{eventId}/` segment in the
path/URL — works for both local paths and R2's full URLs — and is called at
the top of `appendFromStorage`, before either the primary `getStream()`
attempt or the fallback disk check, so it actually runs for every path
regardless of which branch would otherwise have resolved it.

**MED-02 fix**: `GET /api/photos` now nulls `originalUrl` on every row when
the requester isn't the host, mirroring the existing `isHost` gate already
used for `status`/`is_locked` filtering in the same handler.

**DB-01 fix**: `purgeEventMedia` wraps the bulk delete in one transaction —
`DISABLE TRIGGER` on both `photos` and `audio_guestbook`, the two `DELETE`s,
a single `UPDATE events SET storage_bytes = 0` (correct because every row
for this event is being removed in this one operation), then `ENABLE
TRIGGER` before `COMMIT`. Postgres DDL is transactional, so a failure
anywhere rolls the trigger state back too — no separate cleanup path needed.
Scoped to just this bulk-wipe function; a single photo/audio delete
elsewhere still fires the trigger normally.

**DB-03 fix**: `cursor` is now a composite `"priority:isoTimestamp"` pair,
validated by a regex-backed Zod `.refine()`. The query filters on
`(p.priority, p.created_at) < ($cursorPriority, $cursorCreatedAt)` — a
Postgres row-comparison that matches the `ORDER BY` exactly, so a page
boundary landing between two rows with different priorities can no longer
skip or repeat rows the way a `created_at`-only cursor did.

**DB-05 fix**: both `photos.ts` and `ingestPipeline.ts` now collect every
storage path written during the handler into an array, and call
`storageAdapter.delete()` on all of them at each rejection/error exit from
the locked re-check-and-insert block (event-not-found, quota-rejected, and
the catch-and-rethrow path).

**DB-06 fix**: new `acquireUserEventCreationLock(client, userId)` in
`server/middleware/tierGate.ts` (same `pg_advisory_xact_lock(hashtext(...))`
pattern as the upload lock, keyed with a `user_events_` prefix so it can
never collide with an event-upload lock hashing the same raw id). The
per-user count is re-checked under that lock, inside the same transaction as
the slug-retry insert loop — which needed a `SAVEPOINT` per attempt once it
moved inside one explicit `BEGIN`, since a failed statement aborts the rest
of a Postgres transaction until rolled back and the retry loop deliberately
expects individual attempts to fail on slug collisions.

**FE-02 fix**: `withStore` now resolves on `tx.oncomplete` (only capturing
the request's result value on `request.onsuccess`, not resolving there), so
`db.close()` in the outer `finally` can't run until the transaction has
actually committed.

**FE-03 fix**: `offlineQueueService` gained an `onFlushSuccess` listener
mechanism — `flushQueue()` parses the server's JSON response before removing
the queued item and notifies listeners with it. `storageService`'s
constructor registers a handler that, for photo items, merges the response
into the local array by matching the old temp ID (mirroring the reconcile
logic the direct-upload success path already had) and swaps in the real
server fields, including the new id.

**FE-05 fix**: the date-picker's `onChange` now only calls
`onUpdateEvent({ eventDate: newIso })` — the `generateSlug()` call and the
now-dead `generateEventSlug` import were removed entirely.

**FE-07 fix**: `router.navigate()` gained an optional fourth parameter,
`{ replace?: boolean }`, using `history.replaceState` instead of
`history.pushState` when set. The slug input's live-preview call site is the
only caller that passes it; every other `navigate()` call in the app is
unaffected and still pushes as before.

Regression tests added: `tests/unit/pdfPrintService.spec.ts` (FE-01, 1 new
test plus 2 corrected to use the real output-size formula instead of the
same wrong one the bug used), `tests/unit/serverRoutes.spec.ts` +
`tests/e2e.test.ts` + `tests/run-all-tests.ts` (SEC-02), `tests/unit/authHardening.spec.ts`
(SEC-01, 2 new tests) + `tests/unit/wsThrottleAndReactions.spec.ts` (SEC-01
WS path, 1 new test), `tests/unit/crossTenantSecurity.spec.ts` (SEC-03 — 3
new tests, SEC-04 — 1 new test spying on `storageAdapter.getStream` to prove
a planted cross-event path is never passed to it, MED-02 — 1 new test),
`tests/unit/concurrentUploadQuota.spec.ts` (DB-02 and DB-06, 2 new describe
blocks, same real-concurrent-burst methodology as the existing SEC-D1 test),
`tests/unit/photoFeedPagination.spec.ts` (new file, DB-03, 2 tests),
`tests/unit/orphanedUploadCleanup.spec.ts` (new file, DB-05, 1 test spying
on `storageAdapter.delete`), `tests/unit/retentionPurge.spec.ts` (new file,
DB-01, 1 test — this one caught a real bug in its own toggle-revert: removing
the `ENABLE TRIGGER` statements left `trg_photos_storage_bytes` disabled
*table-wide* in the live dev database, not just for the test's own event;
caught immediately by the test, confirmed via `pg_trigger.tgenabled` on the
live DB, and re-enabled by hand before continuing), `tests/unit/offlineQueue.spec.ts`
(FE-02 — 2 new tests against a hand-built fake `IDBDatabase` for precise
event-ordering control, FE-03 — 2 new tests), `tests/unit/storageService.spec.ts`
(FE-03, 1 new test — needed to drain the shared singleton `offlineQueue`'s
leftover state from earlier tests in the same file before it was reliable),
`tests/unit/router.spec.ts` (FE-07, 2 new tests), `tests/unit/hostDashboard.spec.tsx`
(new file, FE-05, 1 test). Every fix in this phase was toggle-verified:
reverted, confirmed the specific test fails for the right reason, restored.

Full suite: 41 files, 269 tests, all passing, twice in a row (checking for
the DB-contention flakiness noted in earlier phases — none observed).
`npm run typecheck`'s app and server configs are clean; its test config has
pre-existing gaps unrelated to this phase (a DOM `BodyInit` vs. Node
`Buffer` typing mismatch already present in several multipart test helpers
from Phases 5-6, and an unrelated generic-inference issue in
`useDebouncedField.spec.ts`) — first surfaced because this was the first
time this session ran all three `typecheck` configs together rather than
just the app config; noted here rather than fixed, since none of it is this
phase's code and none of it blocks `vitest run`, which transpiles rather
than type-checks.

MEDIUM/LOW items from the swarm review (SEC-06, SEC-07, MED-01, MED-03
[=SEC-M5, already deferred], MED-04 through MED-07, DB-04, DB-07 through
DB-15, FE-04, FE-06, FE-08, FE-09, FE-10) remain open for a later phase.

## Fixed (2026-09-04, Phase 8)

Every MEDIUM/LOW item deferred at the end of Phase 7 (MED-03/SEC-M5 stays
deferred — a confirmed duplicate). Same discipline as every prior phase:
implement, write a real regression test, toggle-verify (revert, confirm the
test fails for the right reason, restore, confirm it passes again), then
move on.

| Bug | Where | Consequence had it stayed |
|---|---|---|
| SEC-06 — no rate limiting on the fingerprint lookup | `server/routes/guests.ts` | `GET /api/guests` had no limiter at all — unbounded fingerprint-guessing against SEC-03's identity-lookup path. |
| SEC-07 — disposable-mode reveal gate didn't cover the audio guestbook | `server/routes/audio.ts` | Photos already respected the host's reveal-at-sunrise gate (SEC-W4); `GET /api/audio` didn't check it at all, so any guest with the event link could listen to every voice message before the reveal moment the host set up disposable mode for. |
| MED-01 — ZIP export: unbounded concurrent streams, deflate on pre-compressed files, no zip64, no abort handling | `server/routes/events.ts` | Four compounding issues: (1) the append loop opened every photo's storage stream back-to-back with no backpressure, so a large export could pile up dozens of R2 connections/file handles at once; (2) `zlib: { level: 9 }` re-compressed already-compressed JPEG/WebM for near-zero size gain, burning CPU on every export; (3) no `forceZip64`, so an export crossing 4GB or 65,535 files would produce a corrupt archive; (4) no `req.on('close')`, so a guest closing the browser mid-download left the handler still reading and streaming the rest of the album into a response nobody would ever receive. |
| MED-04 — ingest batch cap still let 20 files buffer in memory at once | `server/routes/ingest.ts` | `MAX_INGEST_FILES = 20` at up to 50MB each meant a single photographer-ingest request could hold up to 1GB of raw buffers in Node's heap before any of them were processed. |
| MED-05 — FTP staging had no per-file size cap before reading the whole thing into memory | `server/ftp/ftpServer.ts` | ftp-srv writes an incoming STOR to disk with no size limit of its own; `handleStoredFile` then `readFile`'d the entire staged file into one Buffer regardless of size — an oversized or malicious transfer could OOM the process on the read alone. |
| MED-06 — R2 stream errors were indistinguishable from "file not found" | `server/lib/storage.ts` | `getStream()` caught every error the same way and returned `null`, so a real outage (network failure, bad credentials, R2 5xx) looked exactly like a missing file — ZIP export silently dropped the photo with nothing telling the host why their download came back short. |
| MED-07 — EXIF-rotated photos got backwards stored dimensions, plus a 3x redundant decode | `server/lib/images.ts` | `metadata()` reports raw pre-rotation pixel counts ("EXIF orientation is not taken into consideration," per sharp's own types); `buildDerivatives()` used those directly, so a portrait phone photo shot with EXIF orientation 6/8 got its width and height stored swapped relative to what guests actually see. Separately, `display` and `thumbnail` each opened their own fresh `sharp(original, ...)` decode on top of the `metadata()` read — three decodes of the same source per upload. |
| DB-04 — WebSocket broadcasts never checked for a slow consumer | `server/ws/wsServer.ts` | `client.send(message)` ran unconditionally; a stalled mobile connection just kept accumulating buffered bytes in Node's memory with no ceiling. |
| DB-07 — `hostCheckCache` had no sweep, only TTL-gated reads | `server/ws/wsServer.ts` | Expired entries were skipped on read but never removed, so the map only grew — a slow, unbounded memory leak over the life of the process. |
| DB-08 — `qr-config` and `subscriptions/upgrade` used read-then-write upserts | `server/routes/events.ts`, `server/routes/subscriptions.ts` | Both did a plain UPDATE followed by a conditional INSERT with no real unique-constraint conflict target — two concurrent requests could both miss the UPDATE and both attempt the INSERT, one failing with an unhandled `23505`. |
| DB-09 — `refreshExpiryDates()` issued one UPDATE per row | `server/lib/retention.ts` | A retention sweep touching thousands of events meant thousands of sequential round trips to Postgres instead of one batched statement. |
| DB-10 — no indexes on the FK columns cascade-deletes actually walk | `photo_likes.guest_id`, `photo_comments.guest_id`, `audio_guestbook.guest_id` | Deleting a guest (or a cascading event delete) forced a sequential scan of each of these tables to find dependent rows, instead of an index lookup. |
| DB-11 — advisory locks hashed with 32-bit `hashtext()` | `server/middleware/tierGate.ts` | `pg_advisory_xact_lock(hashtext($1))` only has 32 bits of hash space; two unrelated event IDs colliding onto the same lock key would serialize uploads for events that have nothing to do with each other. |
| DB-12 — slug collisions on `PUT /api/events/:id` had no retry | `server/routes/events.ts` | A TOCTOU gap between checking slug availability and the UPDATE meant a genuine race could still hit `events_slug_key`, surfacing as an unhandled 500 instead of a transparent retry. |
| DB-13 — login's event-auto-creation fallback had no slug-retry either | `server/routes/auth.ts` | The same class of race as DB-12, on a different code path (login's fallback event creation), also missing the retry loop and the `expires_at` follow-up write. |
| DB-14 — the storage-recount script omitted thumbnails from its measured total | `scripts/storage-recount.ts` | `storage_bytes` reconciliation undercounted every photo by its thumbnail's size, so a recount run could silently under-report actual usage against plan quotas. |
| DB-15 — WebSocket server shutdown didn't clear pending reaction-flush timers | `server/ws/wsServer.ts` | `shutdown()` closed the socket server but left `reactionFlushTimers` running; a timer could still fire and try to broadcast to connections that were supposed to be gone. |
| FE-04 — a dead `blob:` URL could persist across a reload | `src/services/storageService.ts` | `addAudioEntry` writes a fresh `blob:` object URL into the locally-cached entry immediately, before the server upload reconciles it with a real URL. A reload before that reconciliation landed left the cached entry pointing at a `blob:` URL that the browser had already invalidated — permanently broken playback until the next full resync. |
| FE-06 — bulk photo uploads could hold every original in memory at once | `src/components/camera/CameraCaptureModal.tsx`, `src/services/storageService.ts` | `addPhoto()` resolves as soon as the optimistic local copy is saved and fires the real upload in the background, by design — but nothing paced how many of those background uploads could be in flight at once. A 10-file bulk batch fired 10 back-to-back, each holding its own full-resolution base64 original alive in its request closure until that request settled — enough concurrently-resident originals to get a mobile tab OOM-killed on venue Wi-Fi. |
| FE-08 — `useDebouncedField` dropped a pending edit on unmount | `src/hooks/useDebouncedField.ts` | The unmount cleanup only cleared the debounce timer; it never flushed the value that timer would have committed. Switching tabs or navigating away mid-debounce silently discarded the user's last keystrokes. |
| FE-09 — the public showcase feed's UI chrome was hardcoded Bulgarian | `src/components/home/PublicWeddingsShowcase.tsx` | Headings, badges, captions-fallback, and both CTA buttons ignored the language toggle entirely — an English-language visitor saw Bulgarian UI text around the (legitimately Bulgarian) sample wedding content. |
| FE-10 — the QR poster's live date preview hardcoded `bg-BG` | `src/components/host/QRCanvasStudio.tsx` | `toLocaleDateString('bg-BG', ...)` always rendered the Bulgarian month name in the poster preview regardless of the app's active language. |

**SEC-06 fix**: added `uploadLimiter` to `GET /api/guests`, matching every
other lookup-style endpoint in the app.

**SEC-07 fix**: `GET /api/audio` gained the same `optionalAuth` +
disposable-mode/`reveal_at` gate block already used for photos — queries the
event's `host_user_id`/`is_disposable_mode`/`reveal_at`, and returns `[]`
early for a non-host request before the reveal moment.

**MED-01 fix**: four changes to the export-zip handler, all in
`server/routes/events.ts`. (1) Every `archive.append()`/`archive.file()`
call now goes through a `appendAndWait()` helper that resolves only once
archiver's own `'entry'` event confirms that specific entry finished
processing (its internal queue already runs at concurrency 1 — the gap was
the caller opening the *next* storage stream before the current one had
even been handed off), so the loop can no longer race ahead of what
archiver has actually consumed. (2) `store: true` on every entry instead of
`zlib: { level: 9 }` — since photos and audio are already-compressed
formats, this skips deflate entirely rather than spending CPU for near-zero
gain. (3) `forceZip64: true` on the archive constructor. (4) `req.on('close')`
sets an `aborted` flag and calls `archive.abort()`; both photo and audio
append loops check it each iteration and stop early instead of continuing
to read from storage for a response nobody will receive.

**MED-04 fix**: `MAX_INGEST_FILES` dropped from 20 to 10, halving the
worst-case in-memory buffer footprint per request.

**MED-05 fix**: `handleStoredFile` now `fs.promises.stat()`s the staged
file and refuses (logs + lets the existing `finally` unlink it) anything
over `CONFIG.MAX_UPLOAD_SIZE_MB`, before ever calling `readFile`.

**MED-06 fix**: `R2StorageAdapter.getStream()` now inspects the caught
error's `name`/`$metadata.httpStatusCode` — only `NoSuchKey`/`NotFound`/404
resolves to `null`; everything else (network failure, auth, 5xx) is
re-thrown so the caller — and ultimately the export route's own error
handling — finds out instead of silently treating it as "no such file."

**MED-07 fix**: `buildDerivatives()` now reads `metadata.autoOrient.width`/
`.height` instead of the raw `metadata.width`/`.height` — sharp's own
`autoOrient` field is exactly "any changed metadata after the image
orientation is applied," empirically verified against a real EXIF-tagged
fixture (orientation 6 on a 400x300 buffer correctly reports 300x400, and
that number was confirmed to match the actual post-rotation output
dimensions from a real resize). Separately, `display` and `thumbnail` now
`.clone()` the already-open `pipeline` instance (which already carries
`.rotate()`) instead of each opening a brand-new `sharp(original, ...)` —
one shared decode instead of three.

**DB-04 fix**: `send()` checks `client.bufferedAmount > 512KB` before
writing; over that, it terminates and removes the client instead of adding
to the backlog.

**DB-07 fix**: a `sweepHostCheckCache()` call added to the existing 30s
heartbeat interval, deleting any entry whose `expiresAt` has passed.

**DB-08 fix**: both routes now use `INSERT ... ON CONFLICT DO UPDATE`
against a real unique index — `qr_canvas_configs(event_id)` for the QR
config, and a partial unique index via `ON CONFLICT (user_id) WHERE status
= 'active'` for subscriptions (matching the partial index that already
existed). The qr-config route needed explicit `::canvas_size_type`/
`::frame_style_type` casts inside the `COALESCE` — Postgres doesn't
auto-resolve a bare string literal to a custom enum column type there
(reproduced the exact `42804` error via `psql` before fixing).

**DB-09 fix**: `refreshExpiryDates()` rewritten around `UPDATE ... FROM
(SELECT unnest($1::uuid[]) AS id, unnest($2::timestamptz[]) AS expires_at)
v WHERE events.id = v.id` — one statement for the whole batch instead of one
per row.

**DB-10 fix**: `database/migrations/012_guest_cascade_indexes.sql` adds
three `CREATE INDEX IF NOT EXISTS` on the three `guest_id` FK columns.

**DB-11 fix**: both `acquireEventUploadLock` and
`acquireUserEventCreationLock` switched from `hashtext($1)` to
`hashtextextended($1, 0)` — a true 64-bit hash, matching Postgres's own
`pg_advisory_xact_lock(bigint)` signature instead of truncating into it.

**DB-12 / DB-13 fix**: both routes now wrap their final UPDATE/INSERT in a
`for (attempt < 5)` retry loop that catches `isUniqueViolation(err,
'events_slug_key')`, mutates the slug, and retries — matching the pattern
DB-06 already established for event creation. DB-13's login fallback also
now computes and writes `expires_at` on the newly-created event, which the
old code path never did.

**DB-14 fix**: `storage-recount.ts`'s measured-size calculation now adds
`sizeOf(toStoragePath(photo.thumbnail_url))` alongside the display and
original paths it already measured.

**DB-15 fix**: `shutdown()` now calls `client.terminate()` on every
connected client before `wss.close()` — `ws`'s `close()` only stops
*accepting new* connections, it doesn't touch existing ones, so the
`'close'` event (where `reactionFlushTimers.clear()` runs) previously never
fired while any guest was still connected. Confirmed this the hard way: the
first version of this fix (`wss.close()` alone) had a test pass for the
wrong reason — message delivery had stopped, but the timer itself was still
running — before being corrected.

**FE-04 fix**: `getAudioEntries()` now does a one-time sweep the first time
each event's audio is read in a fresh session — any entry whose `audioUrl`
still starts with `blob:` at that point is guaranteed dead (no
`createObjectURL` call has happened yet this session), so it gets cleared
to `''` and the correction is persisted back to `localStorage`. A `Set` of
already-swept event IDs on the singleton means a legitimate `blob:` URL
created later in the same session is never touched.

**FE-06 fix**: a small module-level concurrency limiter
(`runThrottledPhotoUpload`, `MAX_CONCURRENT_PHOTO_UPLOADS = 1`) now wraps
the actual `photosApi.create()` call inside `addPhoto()` — the optimistic
local save and `addPhoto()`'s own resolution timing are completely
unchanged for every caller, only the backend upload itself is queued to run
one at a time.

**FE-08 fix**: `update()` now also records the latest value and a
"has-pending" flag in refs; the unmount cleanup effect checks that flag and
calls `onCommitRef.current(pendingValueRef.current)` before clearing the
timer, so a pending edit is committed instead of dropped.

**FE-09 fix**: added a `showcase.*` namespace (bg + en) to
`src/i18n/index.ts` covering every static UI string in the component —
badge, heading, subtitle, active-album badge, photo/guest counts (`{{n}}`
interpolated), event-shots label, default caption fallback, and both CTA
sections. The `FALLBACK_SHOWCASE_WEDDINGS` sample data itself (venue names,
photo captions) stays Bulgarian by design, same as this app's other demo
fixtures elsewhere — it's content, not UI chrome.

**FE-10 fix**: replaced the hardcoded `toLocaleDateString('bg-BG', ...)`
call with the existing `formatEuDateLong()` from `src/utils/date.ts`, which
already carries the exact same locale-aware logic (`bg` → `bg-BG`, `en` →
`en-GB`) and is used elsewhere in the app for this exact purpose.

Regression tests added: `tests/unit/guestsRoutes` coverage via existing
suite (SEC-06 — rate-limiter headers proven present without exhausting the
shared limiter), `tests/unit/moderationAndReveal.spec.ts` (SEC-07, 1 new
test), `tests/unit/exportDownload.spec.ts` (MED-01, 2 new tests — one
proving store-mode via a 100KB all-zero payload that deflate would have
crushed to under 1KB but store mode ships near-verbatim, one proving the
abort/backpressure fix via a paced, mocked `storageAdapter.getStream` that
a reverted fix lets run to completion regardless of a client disconnect),
`tests/unit/ingestRoutes.spec.ts` (MED-04, 1 new test), `tests/unit/ftpServer.spec.ts`
(MED-05, 1 new test spying on `fs.promises.readFile`), `tests/unit/storageAdapter.spec.ts`
(MED-06, 2 new tests against a mocked `s3.send`), `tests/unit/mediaValidation.spec.ts`
(MED-07, 1 new test against a real EXIF-orientation-6 fixture),
`tests/unit/wsThrottleAndReactions.spec.ts` (DB-04, DB-07, DB-15 — 3 new
describe blocks using `as any` casts to reach internal state), `tests/unit/concurrentUpserts.spec.ts`
(new file, DB-08, 2 tests against real concurrent `23505` conflicts),
`tests/unit/retentionPurge.spec.ts` (DB-09, 1 new describe block),
`tests/unit/slugConcurrency.spec.ts` (DB-12, 1 new test), `tests/unit/authHardening.spec.ts`
(DB-13, 1 new describe block), `tests/unit/storageService.spec.ts` (FE-04 —
1 new test, FE-06 — 1 new test using a manually-controlled mock to prove
concurrency never exceeds 1), `tests/unit/useDebouncedField.spec.ts` (FE-08
— 2 new tests), `tests/unit/components.spec.tsx` (FE-09 — 1 new test
rendering in both languages, FE-10 — 1 new test rendering in both
languages). DB-10 (index-only migration) and DB-14 (no existing test
convention for anything under `scripts/`) were verified directly instead —
`pg_indexes` inspection for DB-10, a real end-to-end run against planted
rows for DB-14 — matching how schema-only and scripts/ changes were already
handled in earlier phases. Every automatable fix in this phase was
toggle-verified: reverted, confirmed the specific test fails for the right
reason, restored, confirmed it passes again.

Also fixed while here: the two pre-existing `tsconfig.test.json` gaps Phase
7 had flagged but left open — the `Buffer` vs. DOM `BodyInit` typing
mismatch (7 files, all sharing the same local `buildMultipartAudio`/`multipart`
helper shape; each now declares `body: BodyInit` and casts the `Buffer.concat(...)`
result, matching the one call site that already did this correctly) and
`useDebouncedField.spec.ts`'s generic-inference issue (TypeScript infers a
literal type like `""` from a bare string-literal argument here rather than
widening to `string`; each call site now passes `useDebouncedField<string>(...)`
explicitly).

Full suite: 42 files, 293 tests. `npm run typecheck` is clean across all
three configs (app, server, test) for the first time this session. Ran the
full suite 5 times total; 4 clean, 1 failure in `wsThrottleAndReactions.spec.ts`
that did not reproduce in isolation or on 3 immediate retries — consistent
with the parallel-execution port flakiness already known from earlier
phases, not a regression (that file wasn't touched this phase).

MED-03 (=SEC-M5) remained the only deferred item from the swarm review,
per Phase 7's verification that it's a confirmed duplicate — fixed
2026-09-05, see below.

---

## Fixed (2026-09-05, MED-03 / SEC-M5)

| Bug | Where | Consequence had it stayed |
|---|---|---|
| MED-03/SEC-M5 — pending-moderation and reveal-locked photos were saved to the same publicly-served path as approved photos | `server/routes/photos.ts`, `server/lib/ingestPipeline.ts`, `server/lib/storage.ts` | `express.static(CONFIG.UPLOADS_DIR)` serves everything under it with zero auth. The API correctly filtered pending/locked photos out of `GET /api/photos` for non-hosts, but the raw file itself was still sitting at a guessable/leakable `/uploads/events/:eventId/...` URL the whole time it was supposedly hidden. |

**Fix**: a real quarantine directory outside the statically-served root,
plus a token-gated preview route for the one legitimate case that still
needs to see the file before it's public — the host, moderating their own
queue.

- `server/lib/storage.ts` — `StorageAdapter.save()` takes an optional
  `{ quarantine: boolean }`. `LocalStorageAdapter` writes to a second root
  (`CONFIG.QUARANTINE_DIR`, default `uploads-quarantine/`, never mounted by
  `express.static`) instead of `UPLOADS_DIR` when set. `R2StorageAdapter`
  prefixes the object key with `quarantine/` instead. Both adapters gained
  `promoteFromQuarantine()` (local: copy + unlink; R2: `CopyObjectCommand` +
  `DeleteObjectCommand`) and a `promoteFromQuarantine` on an
  already-public path is a safe no-op. `removeEventDirectory()` now cleans
  up both roots. New exported `isQuarantined()` helper.
- `server/routes/photos.ts` (`POST /`) and `server/lib/ingestPipeline.ts`
  (photographer/FTP ingest — the same gap existed there, unrelated to the
  guest upload path) both now save with `{ quarantine: initialStatus ===
  'pending' || isLocked }`.
- `server/lib/previewToken.ts` (new) — a short-lived (1h), single-purpose
  HS256 JWT mirroring the existing `downloadToken.ts` pattern:
  `issuePreviewToken(photoId, hostUserId)` / `verifyPreviewToken(token,
  photoId)`.
- `server/lib/photoQuarantine.ts` (new) — `buildPreviewUrl()` builds the
  signed preview link embedded in host-only payloads (WS `PHOTO_ADDED` to
  hosts, and `GET /api/photos` for a host still looking at their own
  pending queue). `promotePhotoFromQuarantine(photoId)` moves a photo's
  three quarantined copies (display/original/thumbnail) back to the public
  path and updates the row; a no-op if none are quarantined.
  `promoteEligiblePhotos(eventId, disposableLocked)` finds every
  approved/featured photo in an event still pointing at a quarantine path
  and promotes it — called at the top of `GET /api/photos` so a disposable
  reveal, which is a passive deadline rather than a discrete action nothing
  else would ever trigger, still results in the file actually becoming
  public instead of guests hitting a dead link forever.
- `GET /api/photos/:id/preview?variant=&token=` (new route) — verifies the
  token, checks the caller is that specific photo's event host, streams the
  requested variant straight from the quarantine (or public, post-promotion)
  path. 401 with no/invalid/wrong-photo token, 403 if the token's user isn't
  this photo's host, 404 if the photo or its file is gone.
- `POST /:id/status` (moderation approval) now calls
  `promotePhotoFromQuarantine()` after setting `status = 'approved'`/
  `'featured'`, unless the photo is still disposable-locked with a
  `reveal_at` in the future — approval alone doesn't mean public yet if
  disposable mode is also in play on the same event.
- `src/services/photoService.ts` — a guest-UX guard in `addPhoto()`'s
  server-reconcile callback: if the server hands back a quarantine URL
  (this uploader isn't necessarily the host, so a signed preview link isn't
  something they can use), keep the guest's own local optimistic preview
  instead of overwriting it with a URL that would just 404 for them.

**Known, accepted limitation (documented, not silently overclaimed)**:
this project's own `CLOUDFLARE_R2_SETUP_GUIDE.md` configures the R2 bucket
for public read access as a whole. A `quarantine/` key prefix on R2 is
therefore a naming convention, not real access control — anyone who already
knows (or brute-forces) a quarantined R2 object's key can still fetch it
directly from R2's own public URL, bypassing the app entirely. Only the
local-disk path (a directory genuinely outside the served root) achieves
real confidentiality. Closing the R2 gap for real would mean a private
bucket plus signed R2 URLs for every public photo, which is a materially
bigger change than this fix and out of scope here; flagging it explicitly
rather than claiming R2 quarantine is equivalent to local quarantine when it
is not.

Regression tests: `tests/unit/storageAdapter.spec.ts` (7 new tests — local
save-outside-public-root, stream/delete a quarantined file, promote +
verify the quarantine copy is gone, promoting an already-public path is a
no-op, R2 key-prefixing on save, R2 promotion issues Copy+Delete with the
right keys, R2 promotion on an already-public key is a no-op).
`tests/unit/photoQuarantine.spec.ts` (new file, 7 tests, route-level against
a real server + real Postgres + real sharp-generated JPEGs) — a pending
photo's file is verifiably absent from `UPLOADS_DIR` and present under
`QUARANTINE_DIR`; the preview route 401s with no token and 401s when a
token minted for a different photo is reused; the owning host can stream
real bytes through the preview URL `GET /api/photos` itself hands back; a
non-host guest still gets nothing at all (unaffected by quarantine — this
was already true, confirmed still true); approving a photo promotes it to a
real `/uploads/...` file; a disposable-locked-and-approved photo gets
lazily promoted the next time `GET /api/photos` runs after its `reveal_at`
passes; a photo that's both moderation-approved and still disposable-locked
stays quarantined (approval alone doesn't unlock it early). The
`promoteFromQuarantine` local-adapter cleanup step was toggle-verified:
temporarily removed the `unlink` call, confirmed the "removes the
quarantine copy" test failed for exactly that reason, restored it.

Full suite: 58 files, 409 tests, all passing. `npm run typecheck` clean.

---

## Fixed (2026-09-05, G6 follow-up — R2_PUBLIC_URL gap)

Requested audit: cross-checked `server/lib/config.ts` against
`docs/CLOUDFLARE_R2_SETUP_GUIDE.md`. The guide frames `R2_PUBLIC_URL` as one
of "5 required values," but G6's fail-fast check (`STORAGE_PROVIDER=r2`
crashes at startup if credentials are missing) only covered
`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` — `R2_PUBLIC_URL`
had no default and no check.

| Bug | Where | Consequence had it stayed |
|---|---|---|
| `R2_PUBLIC_URL` not included in G6's required-credential check | `server/lib/config.ts` | With `STORAGE_PROVIDER=r2` and valid credentials but no `R2_PUBLIC_URL`, `R2StorageAdapter.save()` (`server/lib/storage.ts:228-230`) falls back to the private S3-compatible API endpoint (`bucket.accountid.r2.cloudflarestorage.com`) as the photo's public URL. That endpoint requires SigV4-signed requests even for `GET` — an unauthenticated browser `<img>` request gets `AccessDenied`, not the photo. Every upload would succeed (the PUT itself is a signed SDK call) and then be permanently unloadable for every guest — exactly the silent-failure-that-looks-healthy class of bug G6 exists to catch, just not fully closed. |

**Fix**: `config.ts`'s `STORAGE_PROVIDER === 'r2'` branch now also throws if
`R2_PUBLIC_URL` is unset, with a message pointing at the setup guide.

Also fixed while auditing: `.env.example`'s `R2_BUCKET_NAME` default
(`wedmoments`) didn't match the guide's and `config.ts`'s own default
(`wedmoments-photos`) — cosmetic, but corrected for consistency, and the
comment block above the R2 vars now names all four vars G6 actually
requires instead of a vague "Optional."

Regression test: `tests/unit/configValidation.spec.ts` — 1 new test
(`throws when STORAGE_PROVIDER=r2 has all credentials but no
R2_PUBLIC_URL`), plus the two existing passing-case tests updated to set
`R2_PUBLIC_URL` (they'd now fail otherwise). Toggle-verified: gated the new
check behind `if (false && ...)`, confirmed the new test failed by showing
the resolved `CONFIG` with `R2_PUBLIC_URL: ""` instead of throwing, restored.

Full suite: 58 files, 410 tests, all passing.

---

## Fixed (2026-09-05, external pricing/limits audit)

Requested audit: swept every doc for stale external pricing/limit claims,
verified each against the vendor's own current docs (not training-data
memory) rather than assumed correct.

| Claim | Where | Finding |
|---|---|---|
| R2 `$0.015/GB-month`, zero egress, 10GB free tier | `STORAGE_AND_FINANCIAL_PLAN.md` | Verified accurate against `developers.cloudflare.com/r2/pricing`. |
| "Cloudflare caps at 1,000 buckets" | `STORAGE_AND_FINANCIAL_PLAN.md` §2.B | Stale — raised to 1,000,000/account. Fixed. |
| R2 Class A/B request pricing | `STORAGE_AND_FINANCIAL_PLAN.md` | Never mentioned anywhere. Added as a note; confirmed immaterial at this app's scale. |
| Reaction endpoint "rate limited to 30 per minute per IP" | `docs/API_REFERENCE.md:102` | Wrong — `reactionLimiter` keys on device fingerprint (`deviceKey()`, `server/middleware/rateLimit.ts`), falling back to IP only when none is supplied. SECURITY.md already had this right from an earlier pass; API_REFERENCE.md's copy of the same claim was missed then. Fixed. |
| Auth "25 requests / 15 minutes" | `docs/API_REFERENCE.md:11` | Verified accurate against `authLimiter`. |
| Neon free tier "0.5 GB storage" | `docs/DEPLOYMENT.md` | Verified accurate against neon.com/pricing (0.5 GB/project). |
| Google Cloud Run "2 Million free container requests/month" | `docs/DEPLOYMENT.md` | Verified still accurate. |
| Vercel "Unlimited hobby requests" | `docs/DEPLOYMENT.md` §5 table | Wrong on two counts: Hobby is capped (1M function invocations + 100GB data transfer/month, not unlimited), and Hobby's terms restrict it to non-commercial use — this app charges guests 49€/89€ real money. Fixed the table row and added a callout: use a Pro seat once there's a paying customer. |
| PostgreSQL 16 / Node 22 version claims (README, ARCHITECTURE.md, LOCAL_DOCKER_SETUP.md) | `docker-compose.yml`, `Dockerfile` | Verified accurate (`postgres:16-alpine`, `node:22-alpine`). |
| Plan pricing 0€/49€/89€/49€ (README, STORAGE_AND_FINANCIAL_PLAN.md) | `src/config/plans.ts` | Verified consistent across all three. |

`docs/QR_PRINT_GUIDE.md` and `docs/HTTPS_AND_PERMISSIONS.md` contain no
pricing or vendor-limit claims — nothing to check.

No test changes (docs-only, except the R2_PUBLIC_URL fix already logged in
the entry above this one, which does have its own test).

---

## Fixed (2026-09-05, live phone/LAN testing session)

The owner tested the running app live from a phone on the same Wi-Fi while
this pass was in progress. Real, reproducible bugs surfaced this way that no
existing test caught, because every prior test ran on the same machine as
the server. Fixed one at a time, same discipline as every other phase.

| Bug | Where | Consequence had it stayed |
|---|---|---|
| Bulk gallery upload (4+ phone photos) crashed the browser tab — Out of Memory | `src/services/compressionService.ts` | The old path read every file to a base64 `data:` URL, then decoded it again via `new Image()` + canvas. A modern phone photo is 12-108MP; decoding that to a full-resolution bitmap while a base64 string of the same image was also held in memory, sequentially for 4+ photos in the upload loop, was enough to exceed a mobile tab's memory budget. |
| Server-side account/event defaults hardcoded in English (`"Grand Celebration Venue"`, `"Welcome to our celebration!..."`) regardless of the app's language | `server/routes/auth.ts` (both registration paths), `server/routes/events.ts` | Every real registration got English placeholder text baked into `venue_name`/`welcome_message` no matter what language the host was using — this app is Bulgarian-market first. |
| Host Studio's identity badge always showed the cached per-device **guest** identity, never the authenticated host | `src/components/layout/Navbar.tsx` | A host who had earlier tested their own event as a guest (e.g. "Ivan") saw that name on their own dashboard instead of their own account name — read as a account mix-up, though no data was actually crossed. |
| Deleting a photo whose upload never reconciled with the server (still carrying its local `photo-<ts>-<rand>` placeholder id) threw `INVALID_UUID`, then silently un-deleted it | `src/services/photoService.ts` | The optimistic-delete-then-rollback-on-failure logic didn't know a local-only photo has no server row to delete in the first place, so the guaranteed-to-fail network call put the photo right back — looked like that one photo could never be deleted. |
| QR poster's center icon (a heart) vanished from the exported PNG/PDF, present only in the live preview | `src/components/host/QRCanvasStudio.tsx` | Hotlinked from an external CDN (flaticon.com) with no CORS headers; html2canvas can't read cross-origin pixels into a canvas, so the export silently dropped it, leaving a blank excavated hole. Replaced with inline same-origin SVG data URIs and turned it into a 5-icon picker (heart/rings/camera/sparkle/none) — migration `013_qr_center_icon.sql`. |
| QR poster's "boho arch" frame visually overlapped the header text | `src/components/host/QRCanvasStudio.tsx` | Uniform inset on all sides meant the arch's curved top crossed right through the couple-name/venue text sitting at the top of the poster. Given an asymmetric top inset — also just a more correct "arch/doorway" shape. Added 2 more frame styles (double border, art deco corners) while in there — migration `014_qr_frame_styles.sql`. |
| Native `<input type="datetime-local">` for the ceremony date/time rendered in the browser/OS locale format (`09/28/2026 05:06 PM`) regardless of the app's own language | `src/components/host/HostDashboard.tsx` | That widget's displayed format is controlled by the OS locale, not page language, and cannot be reformatted from app code — only replaced. Swapped for two plain text inputs (DD.MM.YYYY / 24h HH:MM) with input masking, parsed and validated manually. |
| Phone camera/gallery photos in HEIC/HEIF (default iPhone format) or AVIF format were rejected outright by the upload endpoint | `server/lib/validation.ts` | `isImageMagicBytes()` only recognized JPEG/PNG/GIF/WebP. The *display*/thumbnail copies are always safely re-encoded to JPEG client-side regardless of source format, but the *original* is archived as untouched raw bytes — a HEIC/AVIF original failed this gate and the whole upload 400'd. Added ISO-BMFF container brand recognition (`ftyp` + `heic`/`heix`/`hevc`/`mif1`/`avif`/etc.) — safe to accept since nothing server-side ever decodes the original with sharp, it's archived opaquely. |
| The backend process doesn't hot-reload (unlike Vite's frontend HMR) | Dev workflow, not application code | Every server-side fix above kept running against the code that existed when the process was first started, until manually restarted — several rounds of "still doesn't work" traced back to this before it was identified. Restarting both `npm run server` and `npm run dev` resolved it; Vite's own HMR socket had also apparently dropped for the phone's tab, requiring a full close-and-reopen rather than a soft refresh. |
| `PUBLIC_BASE_URL` was never set in `.env`, defaulting to `http://localhost:6501` | `server/lib/config.ts`, `.env` | Baked into every stored photo/audio URL (`thumbnailUrl`, `fullUrl`, `originalUrl`, `audioUrl`) at upload time. `localhost` resolves to whichever device is loading the page — correct on the dev machine, but a phone on the LAN got a URL pointing at itself, rendering every image as broken even though the upload had fully succeeded. Set `PUBLIC_BASE_URL=http://192.168.0.35:6501` in `.env` (matching the LAN IP already used for `CORS_ORIGIN`) and corrected the 188 photo + 98 audio rows already stored with the broken host baked in via a one-off `UPDATE ... replace(...)` against the dev database. `.env.example`'s comment expanded to call out this exact LAN-testing failure mode so it isn't rediscovered blind next time. |

**Features added during the same session** (owner requests while testing, not bugs):
- Photo delete confirmation (`window.confirm`, matching the existing `host.reset_confirm` pattern) + multi-select bulk delete in `ModerationQueue.tsx`.
- Host account profile: `PUT /api/auth/me` (name only — email is intentionally not editable, it's the sign-in identity), opened from the same identity badge the Navbar fix above corrected.
- Per-photo emoji reactions (`photo_reactions` table, migration `015_photo_reactions.sql`) — a guest can toggle several different emoji kinds independently on the same photo (heart/clap/cheers/laugh/party, the same vocabulary the ambient live-reaction bar already used), alongside the existing single-purpose like.

Regression tests added: `tests/unit/compressionService.spec.ts` (bitmap-decode path + fallback), `tests/unit/cameraCaptureModal.spec.tsx` (bulk-selection preview stays responsive without gating on decode), `tests/unit/mediaValidation.spec.ts` (HEIC/AVIF magic bytes), `tests/unit/moderationQueue.spec.tsx` (delete confirmation, cancel-keeps-photo, multi-select bulk delete), `tests/unit/hostDashboard.spec.tsx` (rewritten for the DD.MM.YYYY/24h fields), `tests/unit/authHardening.spec.ts` (4 new tests for `PUT /api/auth/me`), `tests/unit/photoReactions.spec.ts` (new file, 5 tests), `tests/unit/feedComponents.spec.tsx` (3 new PhotoCard reaction tests), plus the R2_PUBLIC_URL and configValidation tests already logged above. Full suite: 59 files, 424 tests, all passing; `npm run typecheck` clean across all three configs; e2e 27/27.

---

## Fixed (2026-09-05, comments & reactions polish — "internal social media" pass)

Requested: test the comment and reaction paths thoroughly, and give them
more of a real social-feed feel.

Found and fixed one real bug while writing the tests: `CommentPhotoSchema`'s
`commentText: z.string().min(1, ...)` checked raw length, not trimmed length
— a whitespace-only comment (`"   "`) passed validation, then the route's
own `.trim()` call right before insert silently stored an empty string.
Changed to `.trim().min(1, ...)`, which validates and normalizes in one
step (`server/routes/photos.ts`).

UI polish, reusing the exact reaction vocabulary/glyphs already established
(heart/clap/cheers/laugh/party):
- **Comment preview on the feed card** (`PhotoCard.tsx`) — the latest
  comment now shows inline, with a "View all N comments" link, instead of
  every comment being hidden behind a click into the lightbox (the
  Instagram/Facebook pattern).
- **Comment avatars + relative timestamps** (`LightboxModal.tsx`) — a
  deterministic per-name color avatar circle per comment, and "2m ago"
  instead of a raw clock time. `formatTimeAgo()` was extracted out of
  `PhotoCard.tsx` into `src/utils/date.ts` so both components (and any
  future one) share it instead of duplicating the relative-time logic.
- **Emoji reactions in the lightbox too** — previously only the feed card
  had the 5-emoji reaction bar; the lightbox only had the single `like`
  button. Now both surfaces support the same independent multi-reaction
  toggle.

Regression tests added: `tests/unit/photoComments.spec.ts` (new file, 5
tests — no dedicated comment-route test existed before, only e2e coverage
of the happy path), `tests/unit/dateUtils.spec.ts` (new file, 5 tests for
`formatTimeAgo`), `tests/unit/feedComponents.spec.tsx` (4 new PhotoCard
comment-preview tests), `tests/unit/lightboxModal.spec.tsx` (2 new reaction
tests). Full suite: 61 files, 440 tests, all passing; e2e 27/27; typecheck
clean.

---

## Added (2026-09-05, Stripe billing integration)

Closes the "no billing" gap noted throughout this document and
`STORAGE_AND_FINANCIAL_PLAN.md` — every plan's revenue was previously
uncollectable, since `POST /api/subscriptions/upgrade` just wrote the tier
directly with no payment behind it. Real Stripe keys aren't available yet
(owner will add them later), so this was built to degrade gracefully to
exactly today's behavior without them, and switch on automatically the
moment they're added — no further code change needed.

**What changed:**
- `npm install stripe` (`^22.6.1`).
- `server/lib/stripe.ts` (new) — lazy Stripe client construction (never
  throws at import time just because keys are blank) and `isStripeConfigured()`.
- `server/lib/subscriptionUpgrade.ts` (new) — the tier-upsert DB logic
  extracted out of `subscriptions.ts` so both the old self-serve route and
  the new webhook write through the exact same, already-tested code path
  (same atomic `ON CONFLICT` upsert, same `refreshExpiryDates()` call for
  SEC-05, same per-tier event limits). Also adds `applyTierDowngradeToFree()`.
- `server/routes/billing.ts` (new):
  - `POST /api/billing/checkout-session` — creates a real Stripe Checkout
    Session using ad-hoc `price_data` (no Stripe Dashboard product needs to
    exist first) matching `src/config/plans.ts`'s amounts exactly
    (Celebration Pass 49 € one-time, Deluxe Keepsake 89 € one-time, Pro
    Planner 49 €/month subscription). Validates the client-supplied
    `successUrl`/`cancelUrl` against the `CORS_ORIGIN` allowlist first
    (open-redirect guard, mirroring SEC-W1's spirit) before checking whether
    Stripe is even configured — a malformed request is rejected the same
    way regardless of that state. Returns `503 STRIPE_NOT_CONFIGURED` while
    keys are unset.
  - `POST /api/billing/webhook` — the only place a tier is ever actually
    written now. Verifies `Stripe-Signature`, and on
    `checkout.session.completed` calls `applyTierUpgrade()` with the real
    Stripe customer/subscription IDs; on `customer.subscription.deleted`
    (a cancelled or terminally-failed Pro Planner subscription) calls
    `applyTierDowngradeToFree()`.
- `server/index.ts` — the webhook route is registered with `express.raw()`
  **before** the global `express.json()` middleware. Stripe's signature
  verification needs the exact original request bytes; once JSON middleware
  parses (and can alter) the body, signature verification fails
  unconditionally. Ordering here is load-bearing.
- `server/routes/subscriptions.ts` — kept, refactored to call the shared
  `applyTierUpgrade()`. This is now explicitly the pre-Stripe fallback, not
  the primary path (see its own updated comment).
- `database/migrations/016_stripe_billing.sql` — `subscriptions.stripe_customer_id`/`stripe_subscription_id`.
- `src/api/billingApi.ts` (new) — `createCheckoutSession()`, and
  `isStripeNotConfiguredError()` to detect the specific fallback code.
- `PricingPlansModal.tsx` — a paid-tier selection now tries a real Checkout
  Session first and does a full-page redirect (`window.location.href`) to
  Stripe's hosted checkout on success. Only on a confirmed
  `STRIPE_NOT_CONFIGURED` response does it fall back to the old direct
  `onUpgradePlan()` self-serve call — any other error (a real Stripe
  failure) surfaces directly instead of silently downgrading to the unpaid
  path. Downgrading to `free` always uses the self-serve call directly;
  a downgrade never needs a payment step.
- `App.tsx` — reads a `?checkout=success|cancelled` query param once on
  mount (Stripe's own redirect target), shows a confirmation/cancellation
  banner, strips the param, and re-fetches the event on success so the plan
  badge/locked features reflect the new tier immediately rather than
  waiting for a manual reload (the tier changed server-side via the
  webhook, not through this client at all).
- `.env` / `.env.example` — `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`,
  documented as optional with the exact fallback behavior explained inline.
- `server/lib/config.ts` — an informational (non-fatal) startup warning
  when the keys are unset, matching the existing `CORS_ORIGIN` warning's
  tone — deliberately not fail-fast like R2/JWT_SECRET, since the app is
  fully usable without payments configured.

**Found and fixed while writing this session's tests**: the redirect-URL
allowlist check was originally written *after* the `isStripeConfigured()`
check, which meant a malformed/malicious redirect URL got masked behind a
503 in this (currently unconfigured) environment instead of being rejected
on its own terms. Reordered so request-shape validation always runs first.

Regression tests: `tests/unit/billingRoutes.spec.ts` (new file, 8 tests —
auth required, free tier rejected for checkout, redirect-URL allowlist,
`503 STRIPE_NOT_CONFIGURED` for both the checkout-session and webhook
routes against this environment's actual unconfigured state, plus direct
tests of `applyTierUpgrade`/`applyTierDowngradeToFree` proving the Stripe
customer/subscription ID persistence and the "don't blank out an existing
customer id on a later upgrade" behavior), `tests/unit/pricingPlansModal.spec.tsx`
(existing tests updated to mock `global.fetch` — jsdom has no browser
origin to resolve a relative `/api/...` URL against, so an unmocked call
fails before it can reach the component logic under test — plus 3 new
tests: real Checkout redirect, a genuine checkout error surfacing directly
instead of silently falling back, and free-tier downgrades never even
attempting a checkout call). The redirect-URL guard and the
`CommentPhotoSchema` trim fix above were both toggle-verified: reverted,
confirmed the specific test failed for the right reason, restored. Full
suite: 62 files, 451 tests, all passing; e2e 27/27; typecheck clean across
all three configs.

**Still needed before this collects real money**: add `STRIPE_SECRET_KEY`
and `STRIPE_WEBHOOK_SECRET` to production `.env`, and register a webhook
endpoint in the Stripe Dashboard pointed at `POST /api/billing/webhook`
(locally, `stripe listen --forward-to localhost:6501/api/billing/webhook`
prints a matching secret for testing before that).



---

## Fixed (2026-09-11, Full-codebase review — Phase 1: guest-facing correctness)

A fresh end-to-end review (typecheck clean, eslint clean, 495/495 unit tests
passing at the time) turned up four defects that the suite could not see, all
of them on the local-first client path and all of them visible to a guest at an
actual reception. None required a schema change. Each was toggle-verified: the
test was written first, run against the unfixed code, and confirmed to fail
with the real symptom before the fix went in.

The common thread is that `tests/setup.ts` stubs `localStorage` with a plain
object that never throws, so every quota-failure branch in the app was
unreachable from the suite — which is exactly where the worst of these lived.

### H2 — A returning guest silently lost their `guestToken`

`src/services/guestService.ts` → `registerGuest`

`POST /api/guests` only returns a `guestToken` when the caller actually proved
the identity is theirs: a genuinely new row (`xmax = 0`). That is deliberate
server-side (SEC-03) — matching a leaked, client-generated device fingerprint
must not hand out a durable credential for someone else's guest row.

The consequence on the client was never handled. The *second* registration from
the same device — a guest reopening the profile modal to change their name —
legitimately comes back with no token, and `setCurrentGuest(ctx, serverGuest)`
replaced the stored guest wholesale, dropping the token the browser already
held. From that point every like, comment, reaction and quest completion was
rejected with `GUEST_TOKEN_REQUIRED`. Those rejections are caught and
`console.warn`ed, never surfaced, so the guest simply watched their likes fail
to stick and revert on the next sync.

Now merges instead of replacing, and carries the existing token forward **only
when the server agrees it is still the same `guestId`** — a token is bound to
one guest id and proves nothing about a different one, so it must not follow
the identity across.

### H1 — A captured photo vanished from the feed when localStorage filled up

`src/services/photoStore.ts` (new, 168 lines), `src/services/photoService.ts`,
`src/components/gallery/PhotoCard.tsx`

A freshly captured photo carries its compressed 1600px copy inline as a base64
`data:` URL (300KB-1MB), because that is what `POST /api/photos` takes and what
the optimistic feed card renders before the upload lands. The origin's whole
localStorage quota is ~5MB, so a bulk capture (up to 10 files) exhausts it —
and with moderation on, the quarantine branch keeps those previews indefinitely
rather than swapping in a server URL.

The old `saveWithRetry` caught the quota error and, for any list under 50
entries, gave up and wrote nothing at all. Since every read goes back through
localStorage, `notify()` then re-read a list without the photo the guest had
just taken. It disappeared from their own feed while its upload was still
succeeding in the background — indistinguishable from data loss, at the busiest
moment of the event.

Extracted the photo cache into a single module that owns every write, on two
rules:

1. The **record** is never negotiable. Losing a row loses the photo from the
   feed; losing its inline preview only degrades a thumbnail the server is
   about to replace anyway.
2. Shed previews **oldest-first, and only as far as the quota actually
   demands** — not down to a fixed arbitrary count.

What gets shed from storage is still held in a session-only `Map` (capped at 30
entries, oldest evicted) and put back by `readPhotos`, so nothing visibly
degrades for the guest who took the photo. The preview is released once a
reachable server URL replaces it — with quarantined photos the deliberate
exception, since their real URL is unreachable for the uploading guest.

All 20 photo-write sites across `photoService`, `realtimeMessages` and
`storageSyncService` now route through `persistPhotos`.

**Follow-on, same defect:** a shed preview after a page reload left
`<img src="">`, which renders as the browser's broken-image icon — telling a
guest their photo is lost at the exact moment it is in fact still uploading.
`PhotoCard` now renders an "Uploading..." placeholder instead
(`feed.preview_uploading`, added to both locales).

### H3 — Albums over 100 photos were truncated, permanently

`src/services/storageSyncService.ts` → new `fetchAllPhotos`

`syncFromBackend` asked `photosApi.list(eventId, 100)` for exactly one page and
never followed the cursor. A wedding with 400 photos showed 100 of them,
forever: LiveFeed's "load more" only pages through what is already cached
locally, so nothing else recovered the rest.

The server has supported a composite keyset cursor all along
(`priority:isoTimestamp`, matching its `ORDER BY priority DESC, created_at DESC`
— see DB-03), and `photosApi.list` already accepted one. Nothing ever passed it.

Now walks every page, capped at 20 (2000 photos, comfortably past any real
wedding) so a pathological response cannot spin. Rows are deduplicated by id
rather than trusted to be disjoint: the cursor timestamp is
millisecond-precision JSON while Postgres stores microseconds, so a page
boundary landing between two photos that share a priority and a millisecond can
repeat a row. A mid-album failure returns what was gathered so far instead of
throwing — 100 photos beats zero when the venue Wi-Fi drops.

### M1 — Host settings changes never reached the guests watching

`src/services/eventNormalization.ts` → new `normalizePartialEvent`,
`src/services/realtimeMessages.ts` → `EVENT_UPDATED`

The server broadcasts `EVENT_UPDATED` as `toPublicEvent(...)`, i.e. raw Postgres
column names (`theme_palette`, `is_moderation_enabled`). The client merged that
payload into the stored event verbatim, and `eventService.getEvent()` resolves
`parsed.themePalette ?? parsed.theme_palette` — the camelCase key is already
populated from the initial load, so the snake_case value that just arrived lost
every time. Every live settings broadcast was silently discarded; a host
changing the theme or switching moderation on saw nothing happen on any guest's
phone until they reloaded.

`normalizePartialEvent` is deliberately **partial** rather than reusing
`normalizeEvent`: `toPublicEvent` omits host-private columns (`host_email`,
`host_user_id`) on purpose, and defaulting those would blank a host's own
details the moment they changed a setting on their own event. `revealAt` is
distinguished from absent rather than folded away with `??`, since `null` there
is a real value — clearing a disposable reveal.

### Tests

New files, 21 tests: `tests/unit/guestTokenPersistence.spec.ts` (3),
`tests/unit/photoLocalPersistence.spec.ts` (5),
`tests/unit/photoFeedFullSync.spec.ts` (4),
`tests/unit/eventBroadcastNormalization.spec.ts` (6),
`tests/unit/photoCardPreviewFallback.spec.tsx` (3).

RED was confirmed for all four defects before any fix, with the specific
symptom each time: `expected undefined to be 'guest-token-first'` (H2),
`expected "list" to be called 3 times, but got 1 times` (H3),
`expected undefined to be 'rosewood_blush'` (M1), and a missing module for H1.

The H1 spec installs its own byte-capped `localStorage` locally rather than
changing the shared stub in `tests/setup.ts`, which 70 other spec files depend
on. **The shared stub still never throws** — any future work on a quota path
needs the same local treatment, or the branch will not be exercised.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean;
`npm run test:unit` 72 files / 516 tests passing (up from 67 / 495).

`npm run test:e2e` 27/27 passing.

Note for future sessions: the e2e suite does **not** need a separately-running
app server. `tests/e2e.test.ts` starts its own on port 6589 and only needs the
database — it was skipped earlier in this session on the mistaken belief that
something had to be listening on :6501 first.

---

## Fixed (2026-09-11, Full-codebase review — Phase 2: availability)

Three defects that are invisible in normal operation and all surface under
exactly the conditions a real reception produces: a nightly sweep, a shared
laptop, and a disposable-mode reveal. Migrations 020 and 021 accompany these.
Each was toggle-verified — test first, confirmed failing against the unfixed
code, then the fix.

### H5 — A retention purge locked the entire `photos` table

`server/lib/retention.ts` → `purgeEventMedia`,
`database/migrations/020_storage_trigger_bulk_purge_guard.sql`

`purgeEventMedia` skipped per-row storage accounting during a bulk delete with:

    ALTER TABLE photos DISABLE TRIGGER trg_photos_storage_bytes

The optimization behind it is sound — DB-01 is real, and a purge of thousands
of photos otherwise becomes thousands of sequential UPDATEs against the same
`events` row. The mechanism was not. `ALTER TABLE` takes an ACCESS EXCLUSIVE
lock on the *whole table* — every event's rows, not just the one being purged
— for the length of the transaction, and it queues behind any in-flight query
while new queries queue behind it. `sweepExpiredAlbums` loops over candidates,
so every live wedding's uploads and feed reads stall once per expired album.

It also silently requires table ownership, so the whole purge path fails
outright under a least-privilege application role — a failure nobody would see
until the first real sweep.

Migration 020 moves the skip inside `update_event_storage_bytes()`, gated on
`current_setting('wedmoments.bulk_purge', true)`. The purge now issues
`SET LOCAL wedmoments.bulk_purge = 'on'`, which is transaction-scoped, needs no
privilege, takes no lock at all, and cannot outlive its COMMIT/ROLLBACK. The
accounting shortcut is preserved exactly; the lock is gone.

That also removes the sharpest edge of the old approach: there is no longer any
failure mode where a crash leaves accounting switched off for *every* event.
020 re-enables both triggers once on the way through, to repair any database
where a pre-020 purge died between DISABLE and ENABLE.

### H9 — A signed-out host kept WebSocket host privileges

`server/ws/wsServer.ts`, `server/middleware/auth.ts`

`requireAuth` and `optionalAuth` both check `users.token_version` (migration
019), so logout kills every token minted before it. The WebSocket `AUTH`
handler verified the signature and the payload shape and never consulted that
column. A host who signed out kept full `isHost` room privileges on any socket
that stayed open.

This is not cosmetic. `broadcastToEventHosts` is the channel carrying photos
still awaiting moderation, and those payloads embed signed preview tokens for
the quarantined files. The shared-machine case migration 019 exists for is
precisely the one this left open — the spec proves it by showing a pending
photo payload actually arriving at a revoked session before the fix.

`isSessionTokenCurrent` is now exported and awaited in the AUTH branch, failing
closed like the HTTP path. It costs one indexed primary-key lookup, only on an
AUTH frame, already bounded by the existing 20-messages-per-10s budget.

**Introduced and fixed in the same change:** making AUTH asynchronous broke the
opening handshake. Node does not await an async `'message'` listener, so the
client's back-to-back AUTH + JOIN_EVENT_ROOM had their handlers interleaved at
the first await, and JOIN read `verifiedUser` while AUTH was still resolving —
every genuine host joined as a guest. Frames from one connection are now
processed through a per-connection promise chain, strictly in arrival order.
The rate limiter still runs before queueing, so a flood is dropped on arrival
rather than buffered into that chain.

### H4 — The disposable-reveal stampede

`server/lib/photoQuarantine.ts`, `server/routes/photos.ts`,
`server/lib/ingestPipeline.ts`,
`database/migrations/021_photos_is_quarantined.sql`

A reveal is a passive deadline — `reveal_at` passes and nothing fires — so
promotion out of quarantine happens lazily in `GET /api/photos`. The right
trigger, implemented two dangerous ways:

1. Eligibility was `storage_path LIKE '%quarantine%'` across three columns. A
   leading wildcard cannot use an index, so every feed load by every guest
   sequentially scanned `photos`. Not just at a reveal — permanently, for every
   event, forever.

2. Matching rows were fanned out through an unbounded `Promise.all`. Each
   promotion is a SELECT, up to three storage copy/delete round trips, and an
   UPDATE.

At the reveal every guest refreshes at once, every request matches the same few
hundred rows, and each fans them out concurrently against a pool of 40. The
pool empties and every HTTP endpoint times out with it — during the first
dance. Concurrent callers also race the same object, and the loser finds the
file already moved and throws. Both failures are reproduced by the spec against
the unfixed code (`expected 16 to be less than or equal to 12`, and
`Cannot promote — quarantined file missing`).

Migration 021 adds `photos.is_quarantined`, backfilled from the predicate it
replaces, with a partial index on `(event_id) WHERE is_quarantined` — small
enough to stay cached, and empty for most events. The flag is set at both
insert sites (guest upload and photographer ingest) and cleared by
`promotePhotoFromQuarantine`, so it is maintained at the two points that
actually change it rather than inferred from path strings.

Promotion is now gated by a **non-blocking** `pg_try_advisory_lock` per event.
Blocking would have been worse than the problem: each waiter would sit on a
pooled connection doing nothing, draining the pool exactly when the promoting
request needs connections of its own. Losing the race means someone else is
already doing the work, so there is nothing useful to wait for — the request
returns and reads the feed as it stands, and the next load picks up whatever
landed. Within the winner, promotion runs at concurrency 4.

**Two defects found while building this fix**, both caught by the tests rather
than review:

- A first attempt used a *blocking* transaction-scoped lock. Six concurrent
  callers took all five test-pool connections and held them while waiting,
  while the lock holder needed further connections for the promotions —
  deadlock. This is the origin of the non-blocking design above.
- Promotion statements were taking their own pooled connections while the
  caller already held one. `promotePhotoFromQuarantine` now accepts an optional
  `db` (the same `Pool | PoolClient` pattern `getUploadContext` and
  `refreshExpiryDates` already use) and runs on the already-held connection, so
  one album promotion costs exactly one connection. node-pg queues the
  statements, so the concurrency above still overlaps the storage round trips,
  which are the slow part.

### Tests

New files, 14 tests: `tests/unit/purgeNoTableLock.spec.ts` (4),
`tests/unit/wsSessionRevocation.spec.ts` (4),
`tests/unit/quarantinePromotionScale.spec.ts` (6).

Note for anyone writing a similar spec: a `vi.spyOn(pool, 'connect')` mock
**must pass callback-style calls straight through**. pg's own `pool.query()`
calls `pool.connect(callback)` internally, so a promise-only mock strands every
pooled query and the spec hangs rather than failing. `captureTransactionSql` in
`purgeNoTableLock.spec.ts` shows the shape, and also restores the patched
`query` on release so instrumentation does not follow a client back into the
pool.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean over
`src`, `server`, `shared` and `tests`; `npm run test:unit` 75 files / 530 tests
passing (up from 72 / 516 after Phase 1).

Migrations 020 and 021 applied and confirmed idempotent on replay. Verified
directly against the database: `idx_photos_quarantined` present,
`photos.is_quarantined` present, the trigger function carries the guard, and
both storage triggers report enabled (`tgenabled = 'O'`).

`npm run test:e2e` 27/27 passing, run after both phases were complete.

This matters more here than for Phase 1, because this round changes server
code — and the suite covers the exact surface most at risk: "WebSocket room
joined with verified host privilege" exercises the AUTH + JOIN_EVENT_ROOM
handshake whose ordering H9 rewrote. e2e also runs against real Cloudflare R2
(it reads `.env`, where `STORAGE_PROVIDER=r2`), unlike the unit suite, which
`vitest.config.ts` pins to local disk.

---

## Fixed (2026-09-11, Full-codebase review — H8: unauthenticated guest-row minting)

Taken on its own, ahead of the rest of Phase 3, because unlike H6 and H7 it
carries no product decision — it is a straight defect.

### The defect

`POST /api/photos/:id/comments` and `POST /api/quests/:id/complete` both
accepted a request carrying no credential whatsoever and `INSERT`ed a fresh
`guests` row on every single call. Comments had no rate limiter at all beyond
the global `apiLimiter` (3000/min/IP), which is a venue-wide *browsing* budget,
not a write limit. `guests` has no quota of any kind.

Anyone holding a public event slug — which is the entire point of the QR code —
could therefore create unbounded guest rows: the host's guest list fills with
ghosts, the showcase guest count inflates, and the table grows without bound.
The specs pin the scale of it against the unfixed code: 5 comments produced 5
new guest rows (`expected 6 to be 2`), 4 quest completions produced 4
(`expected 4 to be 1`).

Anonymous participation was never the problem and is still supported. Minting a
new identity *per request* was.

### The fix

`server/lib/guestIdentity.ts` (new) resolves identity through the same ladder
the photo-upload path already used:

1. A verified guest token — the caller proved who they are.
2. A device fingerprint matching a row this event already has — enough to
   attribute the action to the right guest, which is the whole point of the
   fingerprint fallback.
3. A fingerprint with no match — one row, for that device.

A caller offering neither now gets `401 GUEST_IDENTITY_REQUIRED` and is asked
to join, instead of being handed a brand-new identity for the asking. Row
creation is bounded by devices per event rather than by requests.

`identityProven` carries SEC-03 through unchanged, and this mattered: adding
fingerprint matching would otherwise have *opened* that hole here. A
fingerprint is client-generated and not secret, so matching one is enough to
attribute an action but never enough to be issued a durable credential. Both
routes previously returned a `guestToken` unconditionally; they now return one
only for a verified token or a genuinely fresh row (`xmax = 0`).

The upsert deliberately uses `DO UPDATE SET name = guests.name`, not
`EXCLUDED.name`. The upload path may rename, because a name change there is the
guest editing their own profile; a comment is not, and an unproven request must
not be able to rename someone else's guest just by knowing their fingerprint
(SEC-A2).

Rate limiting added in `server/middleware/rateLimit.ts`: `commentLimiter`
(20/min per device) with `commentIpLimiter` (300/min per venue) as the backstop
— the per-device key is client-supplied and therefore rotatable, the same
reasoning `uploadIpLimiter` already exists for — and `guestActionLimiter`
(30/min per device) on quest completion. Both routes also gained the reserved
device-fingerprint guard (`photographer`, `system`) the upload path has.

Client side, `photoService.addComment` and `questService.completeQuest` now
send `getOrCreateDeviceFingerprint()`, threaded through `photosApi.addComment`
and `questsApi.complete`.

### Three existing specs changed, and why

These asserted the old behaviour. Each was checked individually for whether it
encoded a property now broken, or merely the behaviour deliberately changed —
the answer was the latter in all three, and in every case the *security*
assertion was preserved or strengthened rather than relaxed:

- `photoComments.spec.ts` — "posts under a freshly-minted guest instead of
  rejecting when the token cannot be verified". The property it actually
  guards is `body.guestId !== claimed guestId`, i.e. no impersonation. Split
  into two: with a device fingerprint it still degrades gracefully to a new
  guest (the original intent), and without one it is now refused with nothing
  recorded. The file header, which documented the old minting behaviour as an
  intentional design choice, was rewritten — it would otherwise have misled the
  next reader.
- `crossTenantSecurity.spec.ts` — "rejects a quest completion attributed to an
  event-B guestId" asserted `200` with a fallback guest. Now asserts `401` plus
  a direct database check that no completion row exists for the event-B guest.
  Same property, stronger evidence. (Its sibling test at line ~295 already
  accepted either shape, so rejection was always a valid outcome for this
  class.)
- `serverRoutes.spec.ts` lifecycle — two calls relied on the mint-fallback. The
  comment now sends the `guestToken` the upload handed back, which was already
  in scope and already used by the like/unlike calls beside it; the quest
  completion keeps its anonymous character but sends a device fingerprint. Both
  are what a real client does.

`tests/e2e.test.ts` needed the identical one-line change at its comment step
for the same reason — `guestToken` was in scope and used by the like call two
statements earlier.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean over `src`,
`server`, `shared` and `tests`; `npm run test:unit` 76 files / 540 tests
passing (up from 75 / 530); `npm run test:e2e` 27/27.

New file: `tests/unit/guestRowMinting.spec.ts` (9 tests) — the 401 gate on both
routes, one-row-per-device across repeated calls, the SEC-03 token rule, token
holders not creating rows, the per-device rate limit, and the reserved
fingerprint guard.

---

## Fixed (2026-09-11, Full-codebase review — the MEDIUM list)

Ten of the thirteen MEDIUM findings. The other three are below under **Not
done**, with reasons — one of them because the original finding was wrong.

### Validation and error codes

**M2 — event slug accepted anything.** `slug` was `z.string().min(3).max(120)`
with no charset rule, and the update path applied no `cleanSlug()` even though
every creation path did. The value addresses the event in the URL printed on
QR codes, and is interpolated into
`Content-Disposition: attachment; filename="<slug>-memories.zip"` — where a
CR/LF makes Node throw `ERR_INVALID_CHAR` (a 500 on the export) and a quote
manipulates the filename. A shared `SlugSchema` now enforces
`^[a-z0-9]+(?:-[a-z0-9]+)*$` on both create and update.

**M8 — a duplicate registration raced into a 500.** The email check is a plain
`SELECT`, so two concurrent registrations for the same address both pass it and
one loses against `users_email_key`. The retry loop only caught
`events_slug_key`, so that surfaced as an opaque 500 — for the exact condition
the non-racing path already answers as 409. Now returns 409 either way.

**M9 — ingest key routes never validated `eventId`.** A malformed one reached
Postgres as `22P02` and became a 500. `POST /api/ingest/keys` now takes
`z.string().uuid()`, and the list route validates its query parameter.

**M11 — `PUT /api/events/:id` could throw a TypeError.** The ownership
`SELECT` and the `UPDATE` are separate statements, so a concurrent delete
between them leaves zero rows; reading `planTier` off `rows[0]` then threw and
surfaced as a 500. Now answers 404, which is what actually happened. *This one
has no dedicated test* — the window is a genuine race with no deterministic
hook, and a test that pretends otherwise would be theatre. The guard is three
lines and reviewable on its face.

**M12 — quest creation was unbounded.** `title`, `description` and `iconName`
had no maximum and `points` accepted negatives and arbitrarily large values.
Writing the RED test turned up something the original finding had not: an
over-long title did not merely store badly, it overflowed the `VARCHAR`
column, Postgres raised `22001`, and the host got a **500 for a plain
validation error**. Now bounded (200/1000/50 chars, points 0–1000).

### Query shape

**M5 — `GET /api/events` resolved the plan tier once per event**, sequentially,
in a `for` loop. The tier belongs to the *host*, and every row in that response
is that one host's by definition of the `WHERE` clause, so all those queries
asked an identical question. New `getEffectiveTierForUser()` answers it once.
`getEffectiveTierForEvent` stays for the callers that only hold an event id.

**M6 — the photo feed carried three correlated subqueries per row** (comments
with a join, likes, reactions). At the maximum `limit=200` that is 600 subquery
executions to render one page, scaling with the page instead of staying flat.
Replaced with three batched lookups keyed on the page's photo ids, hitting
`idx_photo_comments_photo` / `idx_photo_likes_photo` /
`idx_photo_reactions_photo`, stitched in `attachPhotoAggregates`. Output shape
is deliberately identical — empty-array defaults, oldest-first comments — and
the spec asserts that directly, because the feed, the lightbox and the offline
cache all read these fields.

**M7 — the Stripe webhook called Stripe from inside its transaction.**
`resolvePurchasedTier` makes a network round trip
(`checkout.sessions.listLineItems`) and was called while the transaction held
both a pooled connection and the per-customer advisory lock. A slow or degraded
Stripe therefore stalled every other delivery for that customer behind it —
and Stripe fans events out concurrently and retries independently, which is
precisely when that queue forms. Now resolved in `prefetchExternalData()`
before `BEGIN`; nothing there writes, so there is nothing to roll back if it
fails. The spec records an ordered log of Stripe calls and BEGIN/COMMIT and
asserts the Stripe call happens first.

### Render cost

**M4 — `LiveProjectorScreen` re-sorted the whole album on every render.** This
component re-renders constantly: each live reaction sets state twice (once to
show it, once to drop it 3.4s later). On a thousand-photo album during a
reaction burst that is a full filter+sort per frame, on the underpowered TV
hardware least able to absorb it. Now `useMemo` on `[photos]`.

**M3 — `AppContext` rebuilt its provider value on every render**, and
recomputed `pendingPhotosCount` with it. Both are now memoized.

Be aware this is the *smaller* half of M3. The original finding was that every
`storageService.notify()` fires seven `setState` calls with freshly-parsed
array references, so one WebSocket message re-renders the whole tree. Memoizing
the provider value does not fix that, because the state genuinely changes
identity each time. Fixing it properly means splitting the context or moving to
a selector-based store — a refactor, not a MEDIUM, and it is **still
outstanding**.

### Not done

**M10 — guest tokens are long-lived and cannot be revoked.** Real, and left
open deliberately: it needs a decision, not a patch. The 400-day TTL has a
sound justification (a Deluxe album lives a year, and a guest returning weeks
later should not be treated as a stranger), and there is no `guests` equivalent
of `users.token_version` because there is no guest logout to bump it. Every
half-measure available is worse than the gap: shortening the TTL breaks the
Deluxe tier it was sized for; binding expiry to the album's `expires_at` costs
a query on a hot path; adding a `token_version` column with nothing that ever
increments it is machinery with no user. What it actually needs is a decision
about what guest revocation *means* here — most likely a host-facing "reset
guest sessions" action — and that is a product question.

**M13 — `amount_paid_cents` is overwritten rather than accumulated.** The
original finding called this an accounting bug. On checking, that was
overstated. The column defaults to `4900` (the price of one plan) and the seed
data sets a per-subscription amount, so "the price of this subscription" is a
coherent reading of it, and **nothing in the codebase reads the column at all**
— `src/types/index.ts:36` declares it on a type that no component renders.
Changing it to accumulate would be inventing semantics for a field with no
consumer. Left exactly as it is. If a revenue figure is ever needed, it should
come from its own ledger rather than from this column.

**M14 — secrets in `.env`.** Not a code change. The R2 keys are still the ones
the file's own comment says were exposed and must be regenerated in the
Cloudflare dashboard. That remains outstanding and is an operator action.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean over `src`,
`server`, `shared` and `tests`; `npm run test:unit` 78 files / 556 tests
passing (up from 76 / 540); `npm run test:e2e` 27/27.

New files: `tests/unit/inputValidationHardening.spec.ts` (10 tests),
`tests/unit/queryShapeHardening.spec.ts` (6 tests).

One note on writing those: the first draft of the M5 assertion matched
`FROM subscriptions`, but `getEffectiveTierForEvent` reads the tier through
`JOIN subscriptions` — so the test passed against the unfixed code and proved
nothing. It was corrected to match either shape, which produced the real RED
(`expected 5 to be less than or equal to 1`) before the fix. A test that goes
green on the first run against known-broken code is not evidence; it is a bug
in the test.

---

## Fixed (2026-09-11, Full-codebase review — H6 privacy, H7 billing)

The two findings that needed a product decision rather than a judgement call.
Decisions taken by the owner: **seed demo events** for H6, **refuse and
redirect** for H7.

### H6 — the showcase published every wedding, with no opt-in

`server/routes/events.ts`, `database/migrations/022_event_public_showcase_optin.sql`

`GET /api/events/showcase/feed` returned the six newest events to anyone —
host name, venue, date, and four preview photos each. No `is_public` column
existed anywhere in the schema, so there was nothing a couple could set and
nothing the query could filter on. Registering an account was consent to being
advertised on the landing page, and a paying couple's wedding photos appeared
there without anyone ever being asked. Under GDPR that is a lawful-basis
problem, not a UX one.

Migration 022 adds `events.is_public`, **default false, and false for every
event that already exists**. Grandfathering existing weddings in would have
kept the landing page full while carrying the original problem forward under a
new column name — those couples were never asked either.

The landing page is repopulated from the seeded demo wedding (migration 002)
instead, which the migration marks public: fictional data the operator owns,
attached to the public demo login, and the one album that can be shown without
asking anyone. Verified after migrating: 1 of 2 events public, and it is the
demo one.

The opt-in is a plain boolean on `UpdateEventSchema` and is deliberately
**absent from `TIER_GATED_EVENT_FIELDS`** — publishing your own album, and
withdrawing it again, is a privacy control and must never sit behind a plan.
A spec asserts a free-tier host can set it, and that a stranger gets 403 and
leaves the flag untouched.

The showcase query was also reshaped while it was open. It previously joined
`photos` and `guests` across the whole table and grouped before `LIMIT 6`
could discard anything, so it got slower with every wedding ever created. It
now picks the six public events first and counts per selected event.

Host-facing: a toggle in `HostDashboard` beside the other privacy switches,
`isPublic` threaded through the client type, both normalizers, `getEvent()`'s
casing fallback and the default fixture, with i18n in both locales.

### H7 — a self-service downgrade left the customer paying

`server/routes/subscriptions.ts`, `server/routes/billing.ts`,
`server/lib/stripe.ts`, `server/lib/retention.ts`

`POST /api/subscriptions/upgrade {"tier":"free"}` was always allowed, on the
reasoning that a downgrade needs no payment step. True, but it never told
Stripe. It cleared the stored `stripe_subscription_id` locally while the
subscription itself stayed live, so:

- the card kept being charged for a plan the account no longer had;
- the next `invoice.paid` found `tier=free`, failed `isPaidTier`, logged a
  warning and did nothing — the money arrived and bought nothing;
- `refreshExpiryDates` recomputed retention at the free tier's 7 days in the
  same breath.

The route now refuses with `409 MANAGE_SUBSCRIPTION_IN_PORTAL` while a
subscription is genuinely live at Stripe, and changes nothing when it does.
Cancelling from here would have fixed the divergence but handed a non-billing
endpoint the authority to destroy a subscription on a single request;
refusing keeps that authority in the Billing Portal, where Stripe expects
cancellation to happen. A *stale* id Stripe no longer recognises must never
strand a customer on a plan they cannot leave, so only a live one blocks.

New `POST /api/billing/portal-session` gives the refusal somewhere to send
people. `returnUrl` is pinned to the same allow-list as the checkout
redirects, for the same reason: it is client-supplied and the customer arrives
at it carrying the trust of having just been on Stripe's own page.
`PricingPlansModal` catches the code, shows the explanation, and redirects.

**The retention floor is separate, and holds regardless of how the tier
changed.** A tier recompute works from the *celebration date*, so a shorter
plan can produce a deadline already in the past — a wedding six months ago
recomputed at 7 days lands well before today, and the next sweep past the
grace period treats the album as eligible for deletion. `refreshExpiryDates`
now floors every computed expiry at `NOW() + GRACE_PERIOD_DAYS`. This is a
floor, not a freeze: a shorter plan still shortens retention, it just cannot
do so retroactively. Losing a plan is a billing outcome; losing the photos
without warning is not.

### A test-integrity note worth keeping

Moving `isSubscriptionStillLive` out of `billing.ts` into `lib/stripe.ts` (as
`isSubscriptionLiveAtStripe`, now shared by the checkout guard and the
downgrade guard) broke `billingCheckout.spec.ts` — that spec mocks
`lib/stripe` wholesale, so the relocated function came back `undefined` and
every case 500'd.

The tempting fix was to restate the live-status list inside the mock. That
would have quietly converted a spec about *Stripe's status vocabulary* into a
spec about a copy of it, free to drift from the real thing. Instead the rule
was extracted as a pure predicate, `isLiveSubscriptionStatus(status)`; both
billing mocks now delegate to the real one via `vi.importActual`, so there is
one definition and no copy to drift.

That left the list itself asserted nowhere, because all three billing specs
mock the module it lives in — so `tests/unit/stripeSubscriptionStatus.spec.ts`
tests it directly and mocks nothing. It pins the load-bearing case
deliberately: `past_due` and `unpaid` count as **live**, because Stripe is
still running dunning and a customer in that state must neither be
double-billed by a second checkout nor quietly dropped to free while their
card is still being retried.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean;
`npm run test:unit` 81 files / 576 tests passing (up from 78 / 556);
`npm run test:e2e` 27/27. Migration 022 applied and idempotent; verified
directly against the database that `is_public` is `NOT NULL DEFAULT false`,
`idx_events_public_showcase` exists, and exactly the demo wedding is public.

Ten existing spec fixtures needed `isPublic: false` added, since the field is
required on `WeddingEvent`. Mechanical, and the compiler found every one.

**One flake to watch, not explained.** On the first full run after these
changes, `tests/unit/wsThrottleAndReactions.spec.ts > Reaction batching (P6)`
failed at the suite level with one test skipped. It did not reproduce in
isolation or on a full re-run, and nothing in this change touches the reaction
path. It is recorded here rather than written off: if it recurs, it is
probably the same parallel-worker contention the `DB_POOL_MAX` note in
`vitest.config.ts` describes, and the reaction batch timer (200ms) is the
obvious thing to suspect under a loaded machine.

---

## Fixed (2026-09-11, Full-codebase review — M10 guest revocation, M3 render cost)

The two items previously deferred as "needs a decision" and "needs a refactor".

### M10 — guest tokens could not be revoked

`database/migrations/023_guest_token_revocation.sql`,
`server/lib/guestAuth.ts`, `server/lib/guestIdentity.ts`,
`server/routes/events.ts`, plus the four token call sites.

A guest token is a bearer credential with a 400-day TTL, and that TTL is
justified — a Deluxe album lives a year, and a guest reopening the link weeks
later should not be treated as a stranger. The problem was that nothing could
end one. A token copied off a shared phone, or read out of a screenshot,
stayed valid for the life of the album. `users.token_version` (migration 019)
solved this for hosts but had no `guests` equivalent, because there is no guest
logout to bump it.

**The decision this needed was what the trigger is**, and the answer is a host
action on the album they own: `POST /api/events/:id/guest-sessions/reset`.

The reset does two things, and they only work together:

1. bumps `guests.token_version`, invalidating every token already issued;
2. clears `device_fingerprint`, releasing the
   `(event_id, device_fingerprint)` slot.

The second is what makes revocation recoverable *without* reopening SEC-03.
A returning guest re-joins, no longer matches an existing row, gets a fresh
one, and is issued a token because that row is inherently theirs (`xmax = 0`).
Without it the reset would be permanent: the fingerprint would still match the
old row, so no token could ever be issued again — while issuing one on a
fingerprint *match* is precisely the hole SEC-03 exists to keep shut. Freeing
the slot lets both rules hold at once.

The old rows stay, with their photos, comments and reactions intact —
revoking sessions must never become a way to delete what guests contributed.
The visible cost is real and deliberate: a guest who re-joins afterwards is a
new identity and loses the link to their own earlier uploads. That is why this
is an explicit host action behind a confirm, not something that happens on its
own, and why the confirm text says so.

**The earlier objection to fixing this turned out to be wrong**, and worth
recording. It was deferred partly because verifying a version would mean a
database read on every like, comment and reaction. It does not: every call
site already loaded the guest row next to the token check —
`SELECT id FROM guests WHERE id = $1 AND event_id = $2` — so adding
`token_version` to those existing selects costs one extra column and no extra
round trip. Two call sites (`guestIdentity`, `audio`) needed the select
reordered ahead of the verification that now depends on it; nothing else
changed shape.

Backward compatible the same way migration 019 was: tokens minted before this
carry no version, read as 0, and keep working until an actual reset.

Client side: `eventsApi.resetGuestSessions`, a host button beside the other
privacy controls, and — importantly — recovery. `photoService` now detects
`GUEST_TOKEN_REQUIRED` / `GUEST_IDENTITY_REQUIRED` on a rejected write and
clears the stored guest, putting the guest back through onboarding. Without
that, a reset would leave every guest holding a dead credential with their
likes failing silently, which is exactly the invisible-failure shape H2 was
about.

### M3 — one realtime message repainted the whole feed

`src/components/gallery/PhotoCard.tsx`, `LiveFeed.tsx`, `App.tsx`,
`src/context/AppContext.tsx`

Every `storageService.notify()` pushes a freshly-parsed `photos` array into
AppContext, so the whole tree re-renders on every incoming WebSocket message —
a like, a comment, a reaction, someone else's upload. A feed page renders up
to 20 PhotoCards, so one like repainted all twenty.

**The obvious refactor was the wrong one.** The earlier note suggested
splitting the context or moving to a selector store. `useApp()` has exactly
one consumer — `App.tsx` — which destructures everything and passes props
down, so splitting the context would have achieved nothing at all. The actual
cost is prop identity churn defeating any memoization below it.

So: `PhotoCard` and `LiveFeed` are memoized, and the callback props were made
stable to let that work. `PhotoCard` now takes `onReact(photoId, kind)`
instead of a pre-bound closure, so `LiveFeed` can pass one shared handler by
reference rather than minting `onLike={() => onLike(photo.id)}` per card per
render — a fresh function identity that would have failed the memo comparison
on every card regardless of whether its photo changed. `App.tsx`'s handlers
and AppContext's actions are wrapped in `useCallback` for the same reason.

`applyRealtimeMessage` already replaced only the changed photo's object and
left the rest identical, so the fix was available; it just was not reachable
while the props churned.

Measured, not asserted: `tests/unit/feedRenderCost.spec.tsx` counts
`formatTimeAgo` calls, which run once per PhotoCard render. Ten photos, one
like arriving: **10 repaints before, 1 after**. A re-render touching no photo:
**6 before, 0 after**. Both numbers came from toggle-verifying — reverting
LiveFeed to inline arrows reproduced 10 and 6 exactly, restoring it gave 1 and
0. The third case in that spec deliberately pins the failure mode, so the test
cannot quietly stop measuring anything.

One existing assertion changed: `feedComponents.spec.tsx` checked
`onReact('heart')` and now checks `onReact(photo.id, 'heart')` — the new
contract, and a stricter assertion than the old one rather than a relaxed one.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean;
`npm run test:unit` 83 files / 586 tests passing (up from 81 / 576);
`npm run test:e2e` 27/27. Migration 023 applied and idempotent; verified
against the database that `guests.token_version` is `NOT NULL DEFAULT 0`.

---

## Fixed (2026-09-11, Full-codebase review — test harness: the flake, and the stub that hid H1)

The two loose ends left after the review itself. Neither is production code;
both are about the suite being able to tell the truth.

### The "unexplained" flake was a port collision, and it was deterministic

`tests/unit/wsThrottleAndReactions.spec.ts`,
`tests/unit/testPortAllocation.spec.ts` (new)

The `Reaction batching (P6)` suite failed once during this session's work with
its test skipped, did not reproduce in isolation or on a re-run, and was
recorded as "watch this". It is not a timing mystery.

`wsThrottleAndReactions.spec.ts` listened on `TEST_PORT + 1`. `TEST_PORT` is
6606, so that resolves to **6607** — the same port `authHardening.spec.ts`
binds. vitest runs spec files in parallel worker processes, so both raced for
it; whichever lost threw `EADDRINUSE` inside `beforeAll`, which vitest reports
as a suite-level failure with the tests *skipped*, passing perfectly in
isolation. Whether it happens at all depends on the scheduler overlapping
those two files, which is why it looked intermittent.

The arithmetic is why it survived: grepping the codebase for `6607` finds
`authHardening` and nothing else. Nobody scanning for duplicates would see it.

Three things changed:

- The batching block now uses its own `BATCH_PORT = 6630` constant.
- `testPortAllocation.spec.ts` resolves every spec file's ports *including*
  `NAME + n` arithmetic and fails if two files share one, naming both. Reverting
  the port reproduces its failure exactly:
  `port 6607: unit/authHardening.spec.ts and unit/wsThrottleAndReactions.spec.ts`.
  A future collision now fails immediately with a readable message instead of
  surfacing as an intermittent failure in an unrelated file weeks later.
- Two genuine races in the same test were removed while it was open: it slept
  150ms and hoped the room join had landed (a reaction broadcast before the
  socket is in the room is simply never delivered), and slept a fixed 500ms for
  a 200ms flush window. It now waits for the server's own `ROOM_JOINED` and
  polls for the expected count with a deadline. The H9 change — frames are
  promise-chained per connection now — had tightened that first window further.

Writing the scanner produced a small lesson of its own: the first version kept
only the last `TEST_PORT` declared per file, and `authHardening.spec.ts`
declares four. It reported "no collisions" against a codebase that had one. The
second version then flagged 6607 *after* the fix, because the explanatory
comment it had just been given contains the literal text `TEST_PORT + 1`. The
committed version strips comments and string literals before scanning, and has
tests for both of those mistakes.

### The shared localStorage stub now enforces a real quota

`tests/setup.ts`, `tests/helpers/quotaStorage.ts` (new),
`tests/unit/localStorageHarness.spec.ts` (new)

The stub accepted a write of any size, so every quota-handling branch in the
app was unreachable from the suite. That is not hypothetical: **H1 lived in one
of those branches.** A freshly captured photo whose inline `data:` URL did not
fit was silently dropped from the feed, and 495 passing tests could not see it,
because nothing ever refused a write.

The stub now enforces 5MB, matching what a browser actually grants an origin.
This was checked rather than assumed — the full suite passes with it in place,
so it changes no existing behaviour today; what it changes is that a future
spec writing more than a real browser allows now fails here instead of passing
against conditions that cannot occur.

Deliberate quota tests still need a tighter ceiling than 5MB — manufacturing
megabytes of fixture data to reach it would be absurd. That stub was hand-rolled
inside `photoLocalPersistence.spec.ts`; it is now
`installQuotaLimitedStorage(maxBytes)` in `tests/helpers/quotaStorage.ts`, and
that spec uses it. Worth sharing rather than copying because the accounting is
easy to get subtly wrong in one specific direction: if the key being overwritten
is counted toward its own budget, an ordinary re-save fails; if the existing
contents are not counted at all, the stub never throws — and a stub that never
throws is exactly the failure it exists to catch.

`localStorageHarness.spec.ts` pins both: that the shared stub refuses an
oversized write, counts what is already stored, and still allows an overwrite
in place; and that the helper enforces its ceiling, restores the shared stub
afterwards, and keeps its contents isolated.

### One of this session's own tests was fragile, and it showed

`tests/unit/guestRowMinting.spec.ts` proved the comment rate limiter by firing
up to 40 sequential HTTP requests and waiting for a 429. That passed when it
was written and timed out at 5s once the suite reached 85 files competing for
the machine — the same fragility class as the flake above, in a test written
during this review. It now fires 25 concurrently: the limiter allows 20 per
minute per device, so at least one 429 is guaranteed whatever order they
arrive in, and the assertion no longer depends on 40 round trips finishing
inside a timeout.

### Verification

`npm run typecheck` clean across all three configs; `eslint` clean;
`npm run test:e2e` 27/27; `npm run test:unit` **85 files / 597 tests, run three
times consecutively with no failures** — stability being the actual claim
here, and one run would not have supported it.

---

## Fixed (2026-09-11, maintenance scheduler — report retention, interval guard, lint gap)

Started from "wire the retention report into the maintenance scheduler". It was
already wired: `maintenance-scheduler.ts` has run `retention-sweep.ts` every 24h
in report-only mode since it was written, and `docker-compose.yml` already
defines the `maintenance` service for it. Nothing to add. What was missing was
everything around it.

### The reports went nowhere

D1 asks for the retention report to be read repeatedly over several weeks
before enforcement is ever switched on. The scheduler spawned each sweep with
`stdio: 'inherit'`, so the output existed only in container stdout — gone long
before a decision could be made on it. A report nobody can read afterwards is
not evidence.

Each run now tees to a dated file as well as stdout: one file per sweep per
day, appended, under `MAINTENANCE_LOG_DIR` (default `logs/maintenance`). In
compose it is a **named volume**, so reports survive `docker compose down` and
an image rebuild — which is the entire point of keeping them.

A log that cannot be written never takes the sweep down with it: the stream
error handler and the surrounding try/catch both degrade to stdout-only. The
sweep is the point; the log is a convenience.

Verified end to end by running the scheduler for real against the dev
database — both sweeps ran, both files were written, and a second run appended
to the same day's file rather than truncating it.

### A typo in an interval turned the scheduler into a hot loop

Both intervals came from `parseInt(process.env.X || 'n', 10) * HOUR_MS` with
nothing checking the result:

    "24"  -> 86400000   ok
    "0"   -> 0          setInterval fires immediately, forever
    "abc" -> NaN        setInterval fires immediately, forever
    "-5"  -> negative   setInterval fires immediately, forever

`setInterval` treats `0`, `NaN` and negatives alike as "as fast as possible",
so one character in `RETENTION_INTERVAL_HOURS` turns a daily report into a
sweep process respawned the instant the last one exits, against the production
database, indefinitely.

What makes that genuinely dangerous rather than merely wrong is that it does
not look like a failure. The `running` guard holds it to one process at a time,
so nothing crashes, nothing queues, nothing alerts — the startup banner prints
`every 0h` and the service simply never stops working.

`parseIntervalHours()` now rejects anything non-finite or non-positive, falls
back to the documented default, and says so on stderr. It also uses `Number`
rather than `parseInt`, so `0.5` means half an hour instead of silently
truncating to zero — the runaway case again, arrived at from the other
direction.

The scheduler had no tests at all; it has 13 now. Auto-start is behind the same
`invokedDirectly` guard `server/lib/migrate.ts` uses, so importing the module
to test it cannot spawn sweeps against a live database. Toggle-verified:
restoring the unguarded `parseInt` fails four of them, including
`expected 0 to be greater than 0`.

### `scripts/` was never linted

Widening the lint command to cover `scripts/` for this work turned up six
violations that had been sitting there unseen — the project's `lint` script
covers `src`, `server`, `shared` and `tests`, and nothing else.

Worth being precise about severity: none of the six was a bug.
Three `catch (err: any)` in `ingest-watcher.ts` (which is how `err?.message`
passed review — `any` silences the check), a `while (true)` worker loop in
`load-test.ts`, and two dead imports. All fixed, and `scripts/` is now in the
`lint` script so the gap cannot reopen.

`scripts/` *is* typechecked — `tsconfig.server.json` has always included it —
so this was a lint-only blind spot, not an unchecked directory.

### Verification

`npm run typecheck` clean across all three configs; `npm run lint` clean,
now including `scripts/`; `npm run test:unit` 86 files / 610 tests;
`npm run test:e2e` 27/27. `docker compose config` validates with the new
volume and environment.

### Still not enough to enable enforcement

The report ran clean against this database: 2 albums, both on paid plans,
neither near expiry, nothing eligible, no expiry date moved. That confirms the
mechanism and the dates are right. It is not evidence about a real population,
and D1's sequence still stands — run it against production data, see at least
one album legitimately appear as eligible and check it by hand, and add the R2
lifecycle rule as a backstop, before `RETENTION_ENFORCED=true` goes anywhere
near a real deployment.

---

## Fixed (2026-09-11, orphan sweep could not see quarantined R2 objects)

Found while investigating what an R2 lifecycle rule would need to cover.

`sweepR2()` in `scripts/storage-orphan-sweep.ts` listed `Prefix: 'events/'` and
nothing else, so every object under `quarantine/events/...` was invisible to
it — permanently, not intermittently. A photo saved while pending moderation or
disposable-locked (MED-03/SEC-M5) lives under that prefix until it is promoted;
if its event is deleted before that happens, the objects are orphaned somewhere
nothing would ever look, and on R2 they are billed for as long as they exist.

On the development bucket that was **446 objects the sweep could not see,
against 12 it could**. The report now finds 458.

The local disk sweep in the same file already walked both roots — it reports
"local uploads" and "local quarantine" separately — which is what makes this an
oversight in the R2 path rather than a deliberate exclusion.

`eventIdFromR2Key()` is now exported and tested, because the failure mode is
silent in the worst direction: an object the sweep cannot see is never
reported, never cleaned, and nothing anywhere says so. One of its tests pins
the specific shape of the original bug — reading index 1 of
`quarantine/events/<id>/…` yields the literal string `"events"`, which is not a
UUID and is therefore skipped without comment.

### A correction worth recording

The investigation started from a wrong number of my own. An ad-hoc scan
reported 458 orphans while the project's tool reported 12, and the tool looked
wrong. It was not: 67 of the 79 `events/` objects sit under a literal
`test-event-id` path segment, and the tool's Guard 4 deliberately refuses to
resolve anything whose path segment is not a UUID. My scan had simply omitted
that guard. The tool's 12 was correct for the prefix it was scanning; the
defect was the prefix, not the counting.

### Verification

`npm run typecheck` clean; `npm run lint` clean; `npm run test:unit`
87 files / 616 tests; the report itself re-run against the live bucket before
and after (12 → 458 orphaned objects found). Nothing was deleted — the sweep
remains report-only unless `SWEEP_CONFIRM=true`.

### Not done: the R2 lifecycle rule

D1 suggests one as a backstop. It cannot be applied as described, and the
reason is worth writing down rather than rediscovering.

R2 lifecycle rules delete by object **age**, optionally narrowed by key prefix.
Object keys are `events/{eventId}/…`, which carries no plan information, while
retention is per tier — 7 days on free, 90 on Celebration Pass, 365 on Deluxe
Keepsake, and **indefinite on Pro Planner** (`retentionDays: null`). So any
age-based rule over `events/` eventually deletes photos a Pro Planner customer
is paying to keep forever, and there is no prefix that can exclude them because
the tier is not in the key.

What is safe, and what is actually being asked for:

- **`quarantine/` at a long window** is defensible on its own terms. Quarantine
  is a transient state — an object is promoted out of it or deleted — so
  anything still there after a window longer than the longest finite retention
  plus grace (365 + 30) is abandoned by definition. This is exactly what the
  446 orphans above were.
- **Incomplete multipart uploads** are already covered: the bucket carries
  Cloudflare's `Default Multipart Abort Rule` at 7 days.
- **`events/` should have no age rule at all**, for the Pro Planner reason
  above. Changing that needs either a product decision (Pro Planner retention
  is not truly indefinite) or a key-scheme change that puts the tier in the
  path.

And the failure mode D1 actually names — "the sweep stops running and nobody
notices" — is better served by noticing than by blind deletion. The maintenance
scheduler now writes a dated report file per sweep per run; reports that stop
appearing are the signal, and they arrive before anything is lost rather than
after.

Also worth noting for whoever picks this up: the orphan sweep is **not** on the
maintenance scheduler. Only the retention and grace sweeps are. Adding it would
mean scheduling something that deletes storage, which is the same opt-in
decision `RETENTION_ENFORCED` represents and should be taken the same way.

---

## Done (2026-09-11, orphan cleanup executed, leak fixed at source, M14 closed)

### Orphans cleared

`npm run storage:orphan-sweep` run with confirmation, after the prefix fix
above made the quarantined objects visible to it:

    R2 objects            525 -> 0
    local uploads dirs   1325 -> 144
    local quarantine      620 -> 57
    reclaimed            164.4 MB across 2202 entries

Live data was snapshotted by file count and exact byte total before the run and
compared after: both live events' media byte-identical, 15 photo rows
unchanged, both events present. The sweep excludes live event ids by design and
that held — but a destructive run is worth proving rather than trusting.

### The leak had a source, and it was a test

67 of the R2 objects sat under `events/test-event-id/` — a path the sweep's
Guard 4 deliberately refuses to resolve, because it will not delete anything
whose path segment is not a UUID. So they were unreachable by the only thing
that cleans up, and had been accumulating one per run.

They came from a single line: `serverRoutes.spec.ts` called
`saveBase64ToStorage(raw, 'test-prefix', 'test-event-id')`, wrote a real object
to whatever storage was configured, never deleted it, and asserted
`expect(savedPath).toBeDefined()` — which passes for literally any return
value, including the raw base64 the function hands straight back when it
declines to store something. That is the one failure the assertion should have
caught.

Fixed at source before clearing anything: the test now uses a real UUID, deletes
what it wrote, and asserts the returned path is not the input and matches the
expected shape. Confirmed by running the full unit and e2e suites afterwards —
**the bucket held 0 objects at the end**, where every previous run had left one
behind.

The 67 historical objects were then cleared by a separate, tightly-scoped
delete rather than by the sweep. That guard exists so the *automated* tool can
never delete paths it does not understand; this one was understood, having been
traced to a specific line. The delete was restricted to that exact prefix and
refused by design if any key failed to match the known filename pattern. All 67
matched. 4.6 KB.

### Dead code removed

`saveBase64ToStorage` (47 lines in `server/lib/storage.ts`) had zero production
callers — the test above was its only consumer, which is how a function nobody
used still managed to leak storage on every test run. Removed.

Its test was **not** removed wholesale. That `it()` block also held the only
direct assertions of `cleanSlug`'s behaviour anywhere in the suite —
`slugConcurrency.spec.ts` calls `cleanSlug` to build an expected value but
asserts nothing about the result. Deleting the block would have silently
dropped the only coverage of Bulgarian transliteration, which is a core feature
of this product. The cleanSlug assertions were kept and the test renamed to
describe what it actually tests.

### M14 — R2 credentials rotated

The keys `.env` had been carrying, which the file's own comment recorded as
exposed, are replaced. Verified end to end against the new credentials before
the old token was revoked: write, read (round-trip content compared), list and
delete all succeeded, followed by the full unit suite (87 files / 616 tests)
and e2e (27/27), which exercise real R2.

The rotation was done with the bucket already empty, which is the cleanest
possible moment for it — no question about what the old keys could have reached,
and nothing to lose if the new ones had not worked.

**M14 is closed.** It was the last outstanding item from the 2026-09-11 review.

### Verification

`npm run typecheck` clean; `npm run lint` clean; `npm run test:unit`
87 files / 616 tests; `npm run test:e2e` 27/27; orphan report afterwards shows
**0 R2 orphans**, with only recent local test churn remaining (141 + 57 dirs,
most of them inside the 60-minute window the sweep deliberately leaves alone).

---

## Decided and implemented (2026-09-11, D1 retention, D2 erasure, R2 lifecycle)

Both decisions taken on instruction to do what is best for the app and
standard practice, with the R2 lifecycle constraint in scope.

### D1 — enforcement stays OFF, and the reason is now a precondition in code

> **Later note (2026-09-13):** the mailer this section says does not exist
> was subsequently built (`server/lib/mailer.ts`, `retentionNotice.ts`). The
> precondition below still holds and still runs in the right order, but it is
> no longer a de-facto safety net: with SMTP configured and notices aged past
> 14 days, `RETENTION_ENFORCED=true` permanently deletes photos. See D1 at the
> top of this document.

**The decision: do not enable it. Encode why, so it cannot be enabled
carelessly.**

Standard practice for destroying customer data is notice first — and a
retention clause in the terms is not notice. The sweep deleted a host's photos
the moment an album passed `expires_at` plus the 30-day grace, having told
nobody. Worse, **this app has no mailer**: no nodemailer, no provider SDK, no
mail dependency of any kind. So notice cannot be sent, so enforcement cannot
responsibly be switched on — which was already true and was recorded as prose
in D1, where a flipped environment variable would sail straight past it.

`events.retention_notified_at` (migration 024) turns that into a precondition.
`sweepExpiredAlbums` now deletes only albums whose notice was sent and has aged
past `RETENTION_NOTICE_DAYS` (14). Everything else past the grace period is
reported under **awaiting notice** rather than skipped silently, because an
album sitting in that list means notification is not running.

Nothing sets the column, so `RETENTION_ENFORCED=true` currently deletes
**nothing at all**. That is the point: enabling enforcement becomes safe by
construction rather than safe by remembering, and the day a mailer is added,
the code that sends the warning stamps the column and deletion begins working
on its own, in the right order, without this guard changing.

The RED run before the fix is worth recording: with an album pushed past its
grace period and no notice sent, the sweep deleted it —
`expected [Array(1)] to not include '<eventId>'`.

The report now also prints the host emails of albums awaiting notice, so the
warnings can be sent by hand in the meantime if anyone wants to.

### D2 — event deletion implemented

**The decision: build it, hard delete, typed confirmation.**

There was no DELETE handler anywhere, so a host could never remove their album
and a service storing photographs of identifiable people alongside their names
and table numbers had no erasure path. That is a GDPR Article 17 problem, not a
missing nice-to-have.

`DELETE /api/events/:id` — host-only, ownership checked, and the host must type
the album's own slug back, which the server compares against the stored value.
Same pattern as typing a repository name before deleting it, and the right
weight for something this irreversible. A `confirm()` dialog alone is one
misclick.

**Hard delete, deliberately, not soft.** Soft deletion would mean threading
`deleted_at IS NULL` through every read path in the app, where one missed query
leaves a "deleted" album still serving photos — a worse failure than the one it
protects against, and a weaker answer to an erasure request, which asks for the
data to be gone rather than hidden.

**Media is purged before the row, and the ordering is load-bearing.** Deleting
the event cascades its photo and audio rows away, and those rows hold the only
record of which stored objects belong to the album. Purge afterwards and every
file is orphaned permanently — precisely the failure that had already put
orphaned objects in storage before the sweep's blind spot was fixed. A test
asserts `bytesFreed > 0`, which can only hold if the rows were still readable
when the purge ran.

`event_deletions` records that a deletion happened without keeping what was
deleted: event id, slug, host, counts, timestamp — no photos, no guest names,
no host email. `host_user_id` is `ON DELETE SET NULL`, so closing an account
later detaches the record from the person without erasing that the deletion
occurred. If the audit insert fails, the response still succeeds: the deletion
has already happened and is not reversible, and telling the host it did not
work would be a lie.

A danger-zone panel in `HostDashboard` makes it usable — a legal erasure path
nobody can reach is not an erasure path.

### R2 lifecycle — policy written, deliberately NOT applied by the app

`scripts/r2-lifecycle.ts`, `npm run r2:lifecycle` / `:apply`

**No age rule on `events/`, and that is the decision, not an omission.** R2
lifecycle rules delete by object age, narrowed at best by key prefix. Keys are
`events/{eventId}/…` and carry no plan information, while retention is per
tier — and Pro Planner is **indefinite**. Any age rule over `events/`
eventually deletes photographs a customer is paying to keep forever, and no
prefix can exclude them because the tier is not in the key. That would not be a
backstop; it would be a slow product failure nobody notices until someone asks
where their wedding went.

What the policy does contain:

- `quarantine/` expiring at **400 days**. Quarantine is transient — an object
  is promoted out of it or deleted with its album — so anything still there
  well past the longest finite retention plus grace (365 + 30) is abandoned.
  The one case it can still catch is a photo left pending moderation on a Pro
  Planner album for over a year, which is a host who has had thirteen months to
  act.
- Cloudflare's existing multipart-abort rule, **preserved**, because
  PutBucketLifecycle replaces the entire configuration and anything omitted is
  dropped.

**It could not be applied, and that turns out to be correct.** The rotated R2
token is Object Read & Write — least privilege for an application — and bucket
lifecycle configuration requires Admin. The attempt returned `AccessDenied
(403)`. Rather than widening the app's token, the policy should be set in the
Cloudflare dashboard (R2 → bucket → Settings → Object lifecycle rules), or by
running this script once with a separate admin token the app does not carry.

The script's first version masked this: a blanket `catch` returned `[]`, so a
403 read as "no rules configured" — which would invite someone to apply a
policy that silently fails, or to believe a backstop exists when it does not.
It now distinguishes forbidden from empty and says which.

**Outstanding, and it needs the dashboard:** the `quarantine/` 400-day rule is
not on the bucket. `npm run r2:lifecycle` prints the exact policy to enter.

### Verification

`npm run typecheck` clean across all three configs; `npm run lint` clean;
`npm run test:unit` 88 files / 627 tests; `npm run test:e2e` 27/27. Migration
024 applied and idempotent. Confirmed directly against the database:
`events.retention_notified_at` and `event_deletions` present, and **0 albums
have ever been notified** — the state that makes enforcement inert.

---

## Done (2026-09-11, R2 quarantine lifecycle rule)

The `Abandoned quarantine objects` rule — prefix `quarantine/`, delete at 400
days — was added in the Cloudflare dashboard by the owner.

**Not verified from this repo, and it cannot be.** Reading a bucket's lifecycle
configuration needs the same Admin scope that writing it does, and the app's R2
token is deliberately Object Read & Write. `npm run r2:lifecycle` will keep
reporting `Access Denied (403)` for that reason, which is the correct outcome
rather than a fault to fix — widening the runtime token so a script can read a
policy it must never change would be the wrong trade.

If it ever needs confirming: check it visually in the dashboard, or run
`npm run r2:lifecycle` with a short-lived admin token and revoke it after.

The one thing worth a second look is the prefix. It must read exactly
`quarantine/`, with the trailing slash. An empty or truncated prefix would
scope the 400-day deletion across the whole bucket, which would eventually
destroy Pro Planner albums that are sold as kept indefinitely — the precise
outcome the policy exists to avoid. The trailing slash is what confines it to
transient quarantined objects.

Nothing is affected today: the bucket holds 0 objects, and the rule only acts
on objects older than 400 days.

**With this, every item from the 2026-09-11 review is closed**, including both
standing decisions (D1 retention, D2 erasure).

---

## Added (2026-09-11, mailer — D1's missing half)

Retention enforcement was inert by design: the sweep refuses to delete an album
whose host was never warned, and nothing could warn anyone. This is that
missing piece.

### SMTP, not a provider SDK

`server/lib/mailer.ts`, nodemailer 10.

This app ships as its own docker-compose against its own Postgres, and SMTP is
the one interface every provider speaks — SES, Postmark, Mailgun, Resend, or a
relay on the same network. Swapping providers is then an environment change
rather than a code change, which is the right shape for something self-hosted.

Unconfigured is a warning, not a crash, matching how Stripe is handled — and
the failure direction is safe: no SMTP means no notices, which means no album
ever becomes deletable. `RETENTION_ENFORCED=true` stays inert on its own.

`sendMail` **throws on failure, deliberately**, and also treats a per-recipient
SMTP rejection as a failure. A transport can accept a message and still reject
every address; SMTP reports that in `rejected` rather than by throwing, and
letting it pass as success would be the same lie as swallowing an exception.

### The one property everything rests on

`server/lib/retentionNotice.ts`

`events.retention_notified_at` is not bookkeeping — it is the act that **arms
deletion**. So the column is stamped only after a confirmed send, one album at
a time.

Stamping optimistically, or in bulk after the loop, would mark a host as warned
when nothing reached them, and the sweep would destroy their photographs a
fortnight later on the strength of a notice that never existed. That is exactly
the failure the notice guard was built to prevent, reintroduced by the code
written to satisfy it.

Toggle-verified rather than assumed: moving the stamp above the send fails two
tests immediately — `expected 2026-09-11T13:41:22.018Z to be null`.

The surrounding cases follow from the same rule. A failed send is reported and
left unstamped, so it retries next run and the album stays undeletable. An
album with no `host_email` cannot be warned, so it is reported as failed rather
than skipped silently — a data problem someone needs to fix, not one to paper
over. A send that succeeds but whose stamp fails is logged and reported,
erring toward a duplicate warning next run, which is obviously better than an
album that can never be deleted or one deleted with no record of why it was
allowed.

### Timing

Warned `RETENTION_NOTICE_LEAD_DAYS` (14) before expiry, then the 30-day grace
period, then deletable once the notice is `RETENTION_NOTICE_DAYS` (14) old —
roughly six weeks between the warning and anything being removed.

The email names the album, the expiry date, the grace period, and links back —
a notice missing any of those is not much of a notice. (It was first written
bilingual; see "Notice email — copy rewritten" at the end of this file for why
that was wrong, and for the unusable link it was carrying.)

### Wiring

`npm run notify:report` / `npm run notify:send`, the same report-then-opt-in
pair as the sweeps. Added to the maintenance scheduler as `retention-notice`,
running daily and ordered ahead of the retention sweep: the sweep enforces the
notice requirement regardless of ordering, but there is no reason to make a
host wait an extra day for a warning that was already due.

`verifyMailer()` runs once before the batch, so a misconfiguration surfaces as
one clear error instead of the same failure repeated per host.

### Verification

`npm run typecheck` clean; `npm run lint` clean; `npm run test:unit` 89 files /
638 tests; `npm run test:e2e` 27/27; `docker compose config` valid.

Beyond the mocked specs, the transport was exercised against a real SMTP
socket — a minimal server accepting a message and asserting nodemailer actually
issued `MAIL FROM`, `RCPT TO` and `DATA`, with `accepted: ['host@test']` and
`rejected: []`. Mocks prove the decision logic; they do not prove the library
speaks SMTP.

### What is now needed to turn retention on

1. Set `SMTP_*` and `MAIL_FROM`, then `npm run notify:report` to see who is due.
2. `NOTICE_SEND=true` — warnings start going out and albums begin being stamped.
3. Leave it for several weeks, reading the dated reports under
   `MAINTENANCE_LOG_DIR`.
4. Only then `RETENTION_ENFORCED=true`, which will delete only albums warned at
   least 14 days earlier.

Each step is independently reversible, and no step before the last deletes
anything.

---

## Notice email — copy rewritten, and the link it carried was unusable

Rendering the email rather than reading the code turned up six problems, one of
them serious enough that the feature could not have been switched on.

### The link (the serious one)

`CONFIG.APP_PUBLIC_URL` falls back to `PUBLIC_BASE_URL`, which in `.env` is
`http://192.168.0.35:6501` — this machine's LAN address. Every notice would
have carried a link no recipient could open. That is worse than sending
nothing: the host cannot act on the warning, they are stamped as notified
anyway, and a fortnight later the sweep deletes the album on the strength of it.

`isPubliclyReachableUrl()` (exported, so it is testable on its own) refuses
loopback, `10/8`, `192.168/16`, `172.16/12`, `169.254/16`, `0/8`, and any bare
hostname with no dot. Plain http to a public host is allowed but warned about.
It is checked once in `sendRetentionNotices` before anything goes out, and
again in `scripts/retention-notify.ts` ahead of the SMTP check — the URL is the
likelier mistake and the more damaging one, since a broken mailer merely sends
nothing.

On refusal every album is reported failed and **none is stamped**, so nothing
becomes deletable. That is the correct outcome for a misconfiguration.

### The copy

Bulgarian only. The bilingual version doubled the subject, which a client
truncates at roughly 60 characters — so the duplication cost length and bought
nothing, and neither half was read in full. The subject is now 62 characters
with the album title truncated at 32 so the date always survives.

Dates read `2 октомври 2026 г.`, not `2026-10-02`, from
`Intl.DateTimeFormat('bg-BG')`.

The month names were briefly hard-coded on a mistaken reading that this runtime
was small-ICU. It is not — `process.config.variables.icu_small` is `false`,
`Intl.DateTimeFormat.supportedLocalesOf(['bg-BG'])` returns `bg-BG`, and Node
has shipped full ICU by default since v13. Twelve strings maintained by hand
were the wrong answer to a problem that did not exist.

The underlying risk is real but small and belongs in a check, not in a table: a
runtime without `bg-BG` data does not throw when asked for it, it quietly
answers in English. `hasBulgarianLocaleData()` is checked once per batch beside
the URL guard, and refuses the same way — nothing sent, nothing stamped.

Dates render in `Europe/Sofia`. `expires_at` is a timestamptz whose time of day
is whenever the album happened to be created, so anything after 21:00 UTC is
already tomorrow in Sofia — roughly one notice in eight would otherwise name
the wrong day. The instant stays UTC in the database; only the calendar day
shown to the host is local.

Also: the redundant `Адрес на албума: <slug>` line is gone (the URL contains
it), the hard wrap at a fixed column is gone (it broke "Ако не / предприемете
нищо" mid-sentence, which looks ragged on the phone this will be read on), and
the title is HTML-escaped — it is host-supplied and lands in an HTML body.

### Two things found while testing

`tests/unit/retentionNoticeAndDeletion.spec.ts` counted
`retention_notified_at IS NOT NULL` across the whole `events` table. Vitest runs
spec files in parallel workers and `retentionNotices.spec.ts` legitimately
stamps its own albums, so that count measured whichever spec was running
alongside it. It passed only for as long as the two specs' timings did not
overlap, and failed the moment this change added a few tests to the other file.
Now scoped to non-test albums via `TEST_EMAIL_DOMAINS`, which is the property it
was always trying to express.

`vitest.config.ts` pins `APP_PUBLIC_URL` to a public-looking address, because
otherwise the notice specs would have quietly exercised the new refusal path
instead of the sending one.

### Verification

`npm run typecheck` clean; `npm run lint` clean; `npm run test:unit` 89 files /
652 tests; `npm run test:e2e` 27/27.

Both guards were toggle-verified. Neutering either makes its test fail with
`expected [ { …(4) } ] to have a length of +0 but got 1` — one email actually
going out, to an unreachable link or with English dates in it, which is the
symptom each prevents.

One unrelated casualty: `guestRowMinting.spec.ts`'s limiter flood test times
out under the default 5s once the suite is this large. It needs a register, an
upload and 25 round trips while racing every other spec file, and its own
comment records having been parallelised for this same reason once already. Now
given an explicit 20s budget, which does not weaken what it asserts and makes a
failure there mean the limiter is broken rather than that the runner was busy.

---

## Scheduler logs — already wired; a compose volume was not

The notice report was already in the scheduler and already logged: `runSweep`
applies dated logging to every sweep `buildSweeps()` returns, and
`retention-notice` has been in that list since it was added. Verified rather
than assumed — running the scheduler through one boot cycle produces three
files side by side:

```
logs/maintenance/retention-2026-09-11.log
logs/maintenance/retention-notice-2026-09-11.log
logs/maintenance/subscription-grace-2026-09-11.log
```

### What was actually broken

`docker-compose.yml` declared:

```yaml
volumes:
  postgres_data:                      # no name
  maintenance_logs:
    name: wedmoments_postgres_data    # the database volume's name
```

The `name:` belonged to `postgres_data`; inserting `maintenance_logs` above it
orphaned the line. Two consequences, neither of which announces itself:

1. The maintenance container mounts the **database's** volume at `/app/logs`
   and appends sweep reports into PGDATA.
2. `postgres_data` falls back to a name Compose derives from the project, which
   defaults to the containing directory. Checked out as `Wedding_album` rather
   than `wedmoments`, Postgres comes up against an empty volume — which
   presents as every album having vanished.

Caught before it did anything: `docker volume ls` showed no
`wedmoments_maintenance_logs`, and PGDATA contained no stray `.log` files, so
the maintenance service had never been brought up under compose.

`tests/unit/composeVolumes.spec.ts` covers it, because there is no type checker
for YAML. The rule that catches this class directly is "a volume's name ends in
its own key" — a uniqueness check alone does **not** catch it, and that is worth
knowing: the orphaned `name:` leaves `postgres_data` parsing as `null`, so the
two entries do not collide, they disagree, and uniqueness waves it through. The
first version of the test did exactly that and passed on the real defect.
Toggle-verified: reintroducing the YAML fails 4 of 6.

### Two corrections to earlier claims in this file

**`npm run typecheck` was not what I had been running.** The script chains three
configs — `tsconfig.json` (src + shared only), `tsconfig.server.json`, and
`tsconfig.test.json`. Invoking `tsc --noEmit -p tsconfig.json` directly, as
several checks this session did, covers the frontend and nothing else. Re-run in
full, everything passes; the claims were narrower than they sounded.

**Two more specs were measuring other specs.** `retentionNotices.spec.ts`'s
"does not notify the same album twice" asserted the whole mocked mailbox was
empty after the second pass. `sendRetentionNotices` has no event scope — it
picks up every album that is due — so a parallel worker's album lands in that
array and fails the assertion. Now scoped to its own host's address. Same shape
as the `retention_notified_at` count fixed earlier today, and the same cause:
a global assertion in a suite that runs spec files concurrently. Both passed for
as long as the timings did not overlap.

`guestRowMinting.spec.ts`'s limiter flood test also needed an explicit 20s
budget, for the ordinary reason that it makes 27 round trips while racing every
other spec.

### Verification

`npm run typecheck` (all three configs) clean; `npm run lint` clean;
`npm run test:unit` 90 files / 658 tests, run twice; `npm run test:e2e` 27/27;
`docker compose config` valid with three distinct volume names.

`js-yaml` and `@types/js-yaml` are now declared devDependencies. `js-yaml` was
already present as a transitive dependency of eslint, which is not something a
test should rely on.

---

## A retention window on the maintenance reports

One file per sweep per day, forever, on a volume nobody looks at — the same
shape of problem retention itself exists to solve. Roughly 1 MB a year, so not
urgent, but unbounded.

`pruneOldReports()` runs at scheduler start and daily thereafter. The window is
`MAINTENANCE_LOG_RETENTION_DAYS`, default **90** — deliberately far longer than
the few weeks of review D1 asks for, because keeping a report costs nothing and
having deleted one somebody needed costs something. `0` or `never` keeps them
indefinitely.

### The parts that needed care

**Age comes from the filename, not mtime.** A sweep appends to its file all day,
and a restarted container can touch an older one, so mtime is not the day the
report is *about*. `retention-2026-06-01.log` is pruned on the strength of the
date it carries.

**The filename pattern is deliberately narrow**: `^[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.log$`.
`MAINTENANCE_LOG_DIR` is operator-configured and under compose it is a mount
point, so this deletes files in a directory that may hold things nobody asked us
to manage. Toggle-verified — loosening the pattern to a bare date match
immediately takes `retention-2026-06-01.log.gz` and `archive-2026-06-01.log.bak`
with it, neither of which the scheduler wrote.

**Bad configuration can only ever keep more.** `MAINTENANCE_LOG_RETENTION_DAYS`
garbage (`-1`, `abc`, `30d`, `NaN`) falls back to 90 rather than to 0 or `NaN` —
`NaN` would happen to delete nothing, but only by accident of comparison, which
is not a property worth relying on.

A report that cannot be deleted is logged and counted as kept; it never takes
the sweeps down with it, on the same reasoning as the log stream's error
handler.

### Verified end to end

Seeded a directory with two stale reports, one recent report and an unrelated
`operator-notes.txt`, then ran the scheduler with a 30-day window:

```
[maintenance] reports older than 30 days are removed
[maintenance] removed 2 report(s) past the retention window, kept 1
```

`operator-notes.txt` and `retention-2026-09-05.log` survived; the January and
May reports did not; today's three files were then written normally.

### Verification

`npm run typecheck` (all three configs) clean; `npm run lint` clean;
`npm run test:unit` 90 files / 669 tests; `npm run test:e2e` 27/27;
`docker compose config` valid.

---

## `--once` for the maintenance scheduler

```
npm run maintenance        schedule them, and keep running
npm run maintenance:once   run each one once, then exit
```

For cron, for a one-shot container, and for checking by hand what the sweeps
currently say. The last of those is not hypothetical: the only way to see the
output before this was to start the long-running form and kill it, which during
this session left **five orphaned scheduler process groups** — fifteen processes
from 18:26, 18:40, 18:41, 18:51 and 19:29 — still ticking against Postgres and
R2. `kill $PID` in Git Bash reaches only the job leader, the `npx` wrapper; the
`tsx` child and its node grandchild survive it. They were found because a
`subscription-grace` log file showed a run block timestamped before the run that
produced it: the 18:26 scheduler's hourly tick, firing exactly an hour later.
Killed with `taskkill /T /F`.

### Shape

`runSweep` now resolves with the child's exit code instead of returning void.
The interval path ignores it, which is exactly what it did before — a failed
sweep must be visible but must never take the scheduler down, because the next
tick is a perfectly good retry and a crash loop would stop the other sweeps too.

`--once` runs the sweeps **sequentially, in declared order**, unlike the
scheduler's concurrent boot burst. The notice sweep genuinely should precede the
retention sweep, and one sweep at a time means one connection pool at a time,
which is the difference between this being safe to cron on a small database and
not.

**It exits non-zero if any sweep did.** That is the point of the mode rather
than a detail: a sweep failing silently under cron is the classic way for a job
like this to stop working without anybody noticing. A failure does not stop the
remaining sweeps — they are independent, and the retention report is the one
that gets read.

`runAllOnce(sweeps, run)` takes an injectable runner, so ordering, concurrency
and exit-code accounting are tested without spawning three real processes
against a live database.

### Verified end to end

```
npm run maintenance:once                      exit 0, 3s, no lingering processes
DATABASE_URL=<unreachable> ... --once         exit 1, "3 of 3 sweep(s) failed"
```

The failing run recorded `exited with code 1` in each dated report, and ran all
three rather than stopping at the first. The scheduled form was re-run
afterwards and is unchanged.

`parseOnce` rejects the near-misses — `once`, `--onces`, `-once` — because
misreading one of those would silently turn a long-running service into a
one-shot that exits seconds after deploying.

### Verification

`npm run typecheck` (all three configs) clean; `npm run lint` clean;
`npm run test:unit` 90 files / 676 tests; `npm run test:e2e` 27/27;
`docker compose config` valid. The compose service keeps the long-running form;
`restart: unless-stopped` owns that lifecycle properly.

---

## `notify:verify` — proving the mailer before customers do

```
npm run notify:verify                      check everything, print the email
npm run notify:verify -- --to you@you.bg   also send one to that address
```

Every other path either sends nothing or sends to real hosts. `notify:report`
deliberately never opens a socket — it only reads the database — and
`verifyMailer()` previously ran solely inside `notify:send`, behind
`NOTICE_SEND=true`. So the first proof that SMTP was configured correctly would
have been a live send to somebody's wedding album, and a misconfiguration would
have announced itself by its silence.

### What it checks

```
[ok  ] SMTP_HOST          set
[ok  ] MAIL_FROM          WedMoments <noreply@wedmoments.bg>
[ok  ] APP_PUBLIC_URL     https://wedmoments.bg
[ok  ] bg-BG locale data  present — dates render in Bulgarian
[ok  ] SMTP connection    connected and authenticated
```

All of them, every run — it does not stop at the first failure, because
configuring this four times in a row, each attempt ending in a different
surprise, is a worse experience than being told everything at once. Against the
current `.env` it reports two failures and exits 1, which is correct: there is
no SMTP host and `APP_PUBLIC_URL` is still a LAN address.

`MAIL_FROM` is checked for an `@` because it must live on a domain verified
with the provider; plain http to a public host is a warning rather than a
failure, since the link still opens. The password is never printed — not even
masked to its real length, which leaks it.

**It touches no database rows.** It never calls `sendRetentionNotices`, so
nothing can be stamped as notified and no album can be moved closer to deletion
by running a diagnostic. It also refuses to send while any check fails, so a
test message can never carry the dead link the checks just objected to.

The printed email is the real `buildNoticeEmail()` output against a plausible
album expiring in 14 days, so the preview is the thing itself rather than a
description of it. When sent, the body is unchanged and only the subject is
prefixed `[ТЕСТ]` — a mistyped address should not leave a stranger holding what
reads like a genuine warning about their photographs.

### Verified against a real socket

Mocks prove the decision logic, not that anything speaks SMTP. Run against a
minimal server on 127.0.0.1:

```
[fake-smtp] MAIL FROM:<noreply@wedmoments.bg>
[fake-smtp] RCPT TO:<kiril@wedmoments.bg>
[fake-smtp] DATA accepted, 2639 bytes
[fake-smtp]   Subject: =?UTF-8?B?W9Ci0JXQodCiXSDQkNC70LHRg9C80YrRgiDigJ4=?=
[fake-smtp]   has html part: true
```

That subject decodes to `[ТЕСТ] Албумът „`, which is the point of checking:
Cyrillic survives MIME encoding intact. Exit 0 with everything configured, exit
1 with anything failing, and refusal rather than a send when `--to` is given
while a check is red.

### Still missing, and worth knowing before NOTICE_SEND=true

**Bounces are invisible.** `sendMail` throws on synchronous rejection, but a
relay normally accepts a message and bounces asynchronously minutes later.
Nothing here sees that, so the album is stamped `retention_notified_at` and
becomes deletable a fortnight on. A host whose address has died is precisely the
host most likely to lose photographs — the exact failure the notice design
exists to prevent, surviving inside it. Closing it needs a provider bounce
webhook that clears the stamp.

Sends are also sequential with a 200-album cap and no throttling. Fine at this
scale; a provider rate limit would surface as failures, which leave albums
unstamped and retried, so the failure direction is safe.

### Verification

`npm run typecheck` (all three configs) clean; `npm run lint` clean;
`npm run test:unit` 91 files / 688 tests; `npm run test:e2e` 27/27.

---

## Bounce handling — a bounced warning is not a warning

The gap named at the end of the `notify:verify` entry, now closed on the side
that protects photographs.

`sendMail` throws when the transport rejects a recipient mid-conversation, and
that was handled. But a relay normally *accepts* a message, returns 250, and
bounces asynchronously when the receiving server refuses the address — no
mailbox, domain gone, address abandoned after the wedding. Nothing here saw
that. The album was stamped `retention_notified_at`, and a fortnight later the
sweep deleted the photographs on the strength of a notice that was never
delivered. The host whose address has died is precisely the one least able to
notice their album is about to be destroyed, so this was the exact failure the
notice mechanism exists to prevent, surviving inside it.

### The rule that matters

**Recording a hard bounce clears `retention_notified_at` on every album owned by
that address.** The bounce nearly always arrives *after* the stamp, so merely
refusing future sends would have left exactly the albums at risk that this is
meant to protect. Disarming is the fix; refusing is the follow-up.

The address is then excluded from `findAlbumsNeedingNotice`, so nothing re-arms
it. The album settles in the sweep's "past grace but NOT deletable" bucket and
stays there, in every report, until a person acts. An album that cannot be
warned is an album that may not be destroyed, and one that cannot be quietly
forgotten either.

Soft bounces are recorded and block nothing — transient means retry. A hard
bounce never downgrades to soft, because a transient failure from some later
retry must not quietly re-enable deletion for an address already known dead. A
fresh bounce un-clears a cleared one: a bounce after somebody marked the address
fixed means it is not fixed. Nothing expires a hard bounce on its own — "it has
been a while" is not evidence an address works.

### What is deliberately not built

Bounce handling has two halves, and only one can be built without knowing the
provider. The half above is provider-independent. The half that *learns* about
bounces is a webhook whose payload shape, signature scheme and event vocabulary
belong to SES or Postmark or Mailgun specifically — guessing at one and shipping
an unverifiable parser would be worse than leaving the seam visible.

So `recordBounce()` is the single entry point, and today it is driven by hand:

```
npm run bounce:list
npm run bounce:record -- --email a@b.bg --detail "550 no such user"
npm run bounce:record -- --email a@b.bg --soft
npm run bounce:clear  -- --email a@b.bg
```

Tedious at scale, entirely adequate at the scale where no provider has been
chosen, and it means the protection is real now rather than waiting on plumbing.
Adding the webhook later is a thin adapter onto `recordBounce`.

### Also fixed

The retention sweep's explanation for its stuck albums still read *"this app has
no mailer, so events.retention_notified_at is never set"* — true when it was
written, stale since the mailer landed. It now separates the three reasons an
album sits in that bucket, because they need different responses and only one
resolves on its own: waiting on a notice, blocked by a bounced address, or
having no host email at all.

### Verification

Both guards toggle-verified. Without the disarm, `takes the album back out of
the deletable set` fails with the album still listed as eligible — that is the
photographs being deleted. Without the exclusion, `never lets the album be
re-armed while the address is blocked` fails, which is the next nightly run
stamping it straight back.

The CLI was exercised end to end against the live database with an address
owning no album, then removed again.

`npm run typecheck` (all three configs) clean; `npm run lint` clean;
`npm run test:unit` 92 files / 704 tests; `npm run test:e2e` 27/27;
migration 025 applied.

---

## Current state — 13 September 2026

Supersedes the 12 September entry below. Since then: the repository was pushed,
CI ran for the first time, coverage was raised past the standard on two of its
four metrics, and the first Dependabot cycle was reviewed and merged.
`REPO_AUDIT.md` §16 has the detail.

```
npm run typecheck     clean  — all three configs
npm run lint          clean  — at --max-warnings=0
npm run test:unit     99 files / 824 tests passed
npm run test:e2e      27 passed | 0 failed
npm run audit:ci      0 production advisories, 0 exemptions
npm run build         clean
```

Coverage: **80.22% statements**, **82.29% lines** — both now clear the project's
80% standard. Branches (71.30%) and functions (76.90%) do not, and that is the
honest remaining gap. The uncovered branches are concentrated in
`CameraCaptureModal` (media APIs jsdom does not implement) and in server route
error paths.

**The repository is live at `github.com/Renova69/Momenta`** — private, default
branch `main`. `git init` had left it on `master`, which the workflow does not
trigger on; renaming it and moving the remote default is what makes CI actually
fire rather than sit silent while looking correctly configured.

**CI passed every job on its first run.** That is attributable to rehearsing it
locally — running every step with `.env` moved aside, then against a brand new
empty database — rather than to luck.

**The repository is public, and branch protection is applied.** It was blocked
while private (a paid feature there); going public resolved it. All three checks
are required and strict, force pushes and branch deletion are denied, and admins
are deliberately exempt so a broken `main` can still be fixed directly.

Verified through a real pull request rather than by reading the settings back —
a mismatch between the required context names and what the workflow reports
fails silently, leaving every future PR waiting on a check that never arrives.

**The history was re-audited before going public** and is clean: no `.env` in
any commit, no live credential pattern, and the actual values in the
local `.env` appear in no blob. Nothing needed rotating.

**GitHub's security tooling is enabled**: secret scanning with push protection,
Dependabot alerts and security updates, and private vulnerability reporting.
`SECURITY.md` at the root is now a real disclosure policy — GitHub had been
presenting `docs/SECURITY.md`, which is architecture documentation, as the
place to report a vulnerability.

**There is deliberately no LICENSE.** Default copyright applies: readable, not
reusable. The README says so explicitly, because "no licence" and "forgot a
licence" look the same from outside.

**The first Dependabot cycle merged**: `zod`, `express-rate-limit`,
`lucide-react` and `@aws-sdk/client-s3`, plus a grouped dev-tooling update. All
minor or patch within the same major, all green before merge, and verified again
as a combination afterwards — each pull request is tested against `main`
separately, so the set together is untested until it lands.

---

## Current state — 12 September 2026

Supersedes the 11 September entry below. Since then: the `REPO_AUDIT.md`
remediation (sections 12-15), version control, CI, and a dependency pass.

```
npm run typecheck     clean  — all three configs
npm run lint          clean  — at --max-warnings=0
npm run test:unit     93 files / 715 tests passed
npm run test:e2e      27 passed | 0 failed
npm run audit:ci      0 production advisories, 0 exemptions
npm run build         clean
```

Coverage is 76.24% statements / 68.04% branches / 72.16% functions / 78.63%
lines — still under the 80% standard, and the one substantial item left open.

**This repository is now under version control.** It had no `.git` at all.
`.gitignore` already covered `.env`, `node_modules`, `dist`, `coverage`, `logs`
and `uploads`; three gaps were closed before the first commit so nothing
sensitive or generated entered history — `uploads-quarantine/` (real guest
photos awaiting moderation), `.claude-flow/` and `.impeccable/` (agent state
that may carry tokens), and `.npm-cache/`.

**CI runs on push and on pull requests** (`.github/workflows/ci.yml`): lint,
typecheck and build in one job; migrations, unit tests with coverage and e2e in
another against a real Postgres 16 service; and a blocking dependency audit in a
third. It has never actually run, because the repository has no remote yet.

**Production dependency advisories are at zero**, down from seven. `multer`,
`qs` and `jspdf` were upgraded, and `ftp-srv` was replaced with
`@electerm/ftp-srv` — the only way to clear an SSRF advisory in `ip` that has no
fixed version anywhere. Details in `REPO_AUDIT.md` §15.

Two upgrades turned out to have no test behind them at all, which only became
visible when they were changed: nothing in the suite constructed jsPDF, and
nothing started the FTP server. Both now have real integration tests, and the
FTP one immediately caught a silent break — the new library reports the client
path on STOR where the old one reported the path on disk, so uploaded frames
would have vanished with all fifteen existing FTP tests still green.

---

## Current state — 11 September 2026

The per-entry figures above are a running history, each recording what was true
when that piece of work landed (67 / 495 at the start of the review, 92 / 704
now). This is the authoritative current position, from a cold run of everything:

```
npm run typecheck     clean  — all three configs
npm run lint          clean
npm run test:unit     92 files / 704 tests passed
npm run test:e2e      27 passed | 0 failed
docker compose config valid
```

Two things about those commands that are easy to get wrong, both learned here:

**`npm run typecheck` is three invocations**, not one — `tsconfig.json` covers
only `src` and `shared`, and `tsconfig.server.json` and `tsconfig.test.json`
cover the rest. Running `tsc --noEmit -p tsconfig.json` by hand checks the
frontend and nothing else, and looks exactly like a full pass.

**`Error: render exploded` in the unit output is expected.**
`components.spec.tsx:177` throws inside a component on purpose to exercise the
error boundary, and React logs the caught error to stderr. The file passes; the
stack trace is not a failure.

The suite is green from cold, which is the part worth stating: three separate
specs this session were passing only because of how their timings happened to
interleave with other spec files (a global `retention_notified_at` count, an
assertion that a mocked mailbox was empty, and a limiter flood test running out
of a 5s budget). All three now assert on their own rows rather than on whatever
else the runner had in flight.
