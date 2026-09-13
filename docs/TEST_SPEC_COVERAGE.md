# 🧪 WedMoments — Test Specification & Coverage

**Version:** `1.0.0`

Two runners, run separately:

| Command | What it runs | Needs PostgreSQL |
| :--- | :--- | :---: |
| `npm run test:unit` | Vitest over `tests/**/*.spec.ts` | Yes — the route specs hit a real database |
| `npm run test:e2e` | The full-stack harness in `tests/run-all-tests.ts` | Yes |
| `npm run test` | Both of the above, in order | Yes |
| `npm run test:coverage` | Vitest with V8 coverage | Yes |
| `npm run typecheck` | `src`, `server` + `shared`, and `tests` | No |
| `npm run lint` | ESLint over `src`, `server`, `shared`, `tests` | No |

Start the database with `docker compose up -d db` before running tests. Route
specs register throwaway hosts and clean up after themselves.

---

## 1. Test Architecture

**118 files in `tests/unit/`, 1241 tests, as of 2026-09-13** (57 on
2026-09-05; 23 before the nine-phase security/architecture pass). Grouped by
what they actually exercise, since a flat alphabetical list goes stale the
moment the next file is added.

Coverage clears the project's 80% standard on all four metrics:

| Metric | Value |
| :--- | :--- |
| Statements | 85.68% |
| Branches | 80.46% |
| Functions | 82.26% |
| Lines | 87.43% |

Two guards keep the suite honest about itself. `testPortAllocation.spec.ts`
fails if two spec files bind the same TCP port — including ports reached by
arithmetic such as `TEST_PORT + 3`, since a collision otherwise surfaces as an
intermittent `EADDRINUSE` in an unrelated file weeks later. And `tests/setup.ts`
refuses to run against a non-local storage provider, because a spec that
silently stopped asserting anything is worse than one that fails.

**Security & auth** — `serverAuth.spec.ts`, `authService.spec.ts`,
`authHardening.spec.ts` (trust-proxy parsing, login timing, bcrypt 72-byte
truncation), `guestIdentityAndWsAuth.spec.ts` (guest tokens, reserved
fingerprints, WS `AUTH`), `crossTenantSecurity.spec.ts` (IDOR/cross-tenant
exfiltration paths), `magicBytes.spec.ts`, `mediaValidation.spec.ts`.

**Concurrency & database integrity** — `concurrentUploadQuota.spec.ts`,
`concurrentUpserts.spec.ts` (subscription/QR-config `ON CONFLICT` races),
`slugConcurrency.spec.ts`, `migrate.spec.ts`, `hostAccountCascade.spec.ts`,
`photoFeedPagination.spec.ts` (composite keyset cursor).

**Storage & retention** — `storageAdapter.spec.ts`, `storageQuota.spec.ts`,
`orphanedUploadCleanup.spec.ts`, `purgeAndOrigin.spec.ts`,
`retentionPurge.spec.ts`, `exportDownload.spec.ts`.

**Real-time & offline** — `wsThrottleAndReactions.spec.ts`,
`offlineQueue.spec.ts`, `moderationAndReveal.spec.ts` (paid gates over REST
*and* WebSocket).

**Media & ingest pipelines** — `ingestRoutes.spec.ts`, `ftpServer.spec.ts`,
`mediaSupport.spec.ts`, `pdfPrintService.spec.ts`, `compressionService.spec.ts`.

**Tier gating & subscriptions** — `tierGating.spec.ts`,
`subscriptionUpgrade.spec.ts`, `configValidation.spec.ts` (`STORAGE_PROVIDER`
fail-fast, G6).

**Server routes / general** — `serverRoutes.spec.ts`, `apiClient.spec.ts`,
`router.spec.ts`, `i18n.spec.ts`, `config.spec.ts`, `useDebouncedField.spec.ts`.

**Frontend components** (`*.spec.tsx`) — every component under
`src/components/` now has one: `components.spec.tsx` (StorageMeter,
ReactionBar, LockedFeatureBadge, ErrorBoundary, PublicWeddingsShowcase,
QRCanvasStudio), `feedComponents.spec.tsx` (LiveFeed, ScavengerHunt),
`hostDashboard.spec.tsx`, `cameraCaptureModal.spec.tsx`,
`lightboxModal.spec.tsx`, `liveProjectorScreen.spec.tsx`,
`moderationQueue.spec.tsx`, `photographerIngestPortal.spec.tsx`,
`audioGuestbook.spec.tsx`, `pricingPlansModal.spec.tsx`,
`guestOnboardingModal.spec.tsx`, `hostAuthPage.spec.tsx`,
`hostEventsList.spec.tsx`, `photographerIngestPanel.spec.tsx`,
`landingHomePage.spec.tsx`, `navbar.spec.tsx`, `bottomNav.spec.tsx`,
`weddingHero.spec.tsx`, `eventNotFound.spec.tsx`, `loadingSpinner.spec.tsx`.

**Paywall** — `tierGatingEndToEnd.spec.ts` drives every server-enforced gate
over real HTTP at every tier, asserting each is refused below its threshold and
allowed at or above it, that `events.plan_tier` is never trusted for
entitlement (only `subscriptions`, and only while `status = 'active'`), and
that a lapsed host can still switch a paid setting *off*.

**Retention & mail** — `retentionNotices.spec.ts`, `retentionPurge.spec.ts`,
`emailBounces.spec.ts`, `mailer.spec.ts`, `maintenanceScheduler.spec.ts`. An
album is never deleted until its host has been warned, so the mailer's refusals
matter more than its successes: an unconfigured relay, a transport that throws,
and a transport that accepts the message and then rejects the recipient.

**Storage internals** — `localStorageAdapter.spec.ts` (the adapter every
non-Cloudflare deployment runs: path containment on delete, promotion out of
quarantine, post-purge directory removal that must not force a directory still
holding files), `exportArchiveContents.spec.ts` (which files actually end up in
the exported ZIP, and that a row naming another album's object is dropped).

**Guest upload rules** — `perGuestPhotoCap.spec.ts` (a cap of zero means accept
nothing, not "use the default"), `offlineQueue.spec.ts` and
`offlineQueueAudioAndResilience.spec.ts` (the flush path, including rebuilding a
queued voice message into multipart and not running two flushes at once).

Plus `tests/e2e.test.ts` (full-stack API, PostgreSQL & WebSocket suite) and
`tests/run-all-tests.ts` (E2E harness entry point, `npm run test:e2e`).

Unit suites used to exist twice — once for Vitest and once for a bespoke
`tsx` runner — with two sets of assertions covering the same modules. The
duplicates were removed; `run-all-tests.ts` now owns only the live-stack pass.

---

## 2. What is covered

### Security, authentication, and file signatures

| Requirement | Covered by |
| :--- | :--- |
| bcrypt password hashing and login comparison | `serverAuth.spec.ts` |
| JWT issuance with identity, role and expiry | `serverAuth.spec.ts` |
| `password_hash` never returned by any auth route | `e2e.test.ts` |
| Unauthenticated requests to host routes are refused | `serverRoutes.spec.ts`, `ingestRoutes.spec.ts` |
| Magic-byte validation across all accepted formats | `magicBytes.spec.ts` |
| Executables and disguised HTML are rejected | `magicBytes.spec.ts` |
| Undecodable images are rejected with 400, not 500 | `ingestRoutes.spec.ts` |
| Malformed UUIDs return 400 rather than a database error | `ingestRoutes.spec.ts` |
| Path-traversal containment on disk operations | `storageAdapter.spec.ts` |
| Ingest keys: single-issue, masked listing, revocation, event scoping | `ingestRoutes.spec.ts` |
| Ingest keys are refused from the query string | `ingestRoutes.spec.ts` |
| Expired/rejected tokens clear the client session | `apiClient.spec.ts` |
| ZIP download links are short-lived and bound to one event and user | `exportDownload.spec.ts` |
| A session JWT is not accepted as a download token | `exportDownload.spec.ts` |
| A failed migration rolls back and halts the run | `migrate.spec.ts` |
| Editing an applied migration is reported, never silently re-run | `migrate.spec.ts` |

### Multi-tenancy and data integrity

| Requirement | Covered by |
| :--- | :--- |
| Event isolation across photos, guests, quests, audio | `e2e.test.ts` |
| Public slug endpoint omits host PII | `e2e.test.ts` |
| Nullable columns can be cleared via the update route | `e2e.test.ts` |
| Guest upsert by `(event_id, device_fingerprint)` | `e2e.test.ts` |
| Quest completions survive photo moderation | `e2e.test.ts` |

The public slug endpoint returns `planTier` deliberately, so the client can gate
the interface without inventing a default. It does not return `host_email` or
`host_user_id`.

### Real-time and offline

| Requirement | Covered by |
| :--- | :--- |
| WebSocket auth via a post-handshake `AUTH` message, not a `?token=` query string (SEC-A5) | `e2e.test.ts`, `wsThrottleAndReactions.spec.ts` |
| Room subscription and host-privilege verification | `e2e.test.ts` |
| `PHOTO_ADDED` reaches room clients | `e2e.test.ts` |
| Offline queue enqueue, flush, and atomic removal | `offlineQueue.spec.ts` |
| Retry capping | `offlineQueue.spec.ts` |

### Tier gating

| Requirement | Covered by |
| :--- | :--- |
| Feature boundaries per tier | `tierGating.spec.ts` |
| Every gate carries keys that resolve in both dictionaries | `tierGating.spec.ts` |
| Free plan refused: moderation, custom themes, QR studio | `serverRoutes.spec.ts` |
| Upgrading the subscription unlocks those same routes | `serverRoutes.spec.ts` |
| Audio guestbook gated to `deluxe_keepsake` | `e2e.test.ts` |
| Free-tier photo cap enforced, failing closed on DB errors | `tierGating.spec.ts` |
| A photo awaiting moderation reaches hosts only, never the guest room | `moderationAndReveal.spec.ts` |
| Approving a photo releases it to guests over both channels | `moderationAndReveal.spec.ts` |
| Disposable-mode photos broadcast with their URLs stripped | `moderationAndReveal.spec.ts` |
| Locked photos are hidden from guests but visible to the host | `moderationAndReveal.spec.ts` |
| Photos become visible once the reveal time passes | `moderationAndReveal.spec.ts` |
| Storage allowance enforced per plan | `tierGating.spec.ts`, `storageQuota.spec.ts` |
| Uploads charge bytes to the event, deletions release them | `storageQuota.spec.ts` |
| Pro Planner pools its allowance across events | `storageQuota.spec.ts` |
| Retention window starts at the celebration, not setup | `storageQuota.spec.ts` |

### Frontend

| Requirement | Covered by |
| :--- | :--- |
| Root and event-slug routing | `router.spec.ts` |
| BG/EN dictionary parity | `i18n.spec.ts` |
| Print dimensions per canvas size | `pdfPrintService.spec.ts` |
| Printing is refused when the poster is not mounted | `pdfPrintService.spec.ts` |
| Client compression and filter application | `compressionService.spec.ts` |
| Camera/mic blocked on insecure origins, with a message that names the fix | `mediaSupport.spec.ts` |
| Storage meter shows usage, warns near the limit, hides on error | `components.spec.tsx` |
| Error boundary shows a recovery message, not an internal error | `components.spec.tsx` |
| A guest sees their own pending photo but never another guest's | `feedComponents.spec.tsx` |
| Feed filters and search across name, caption and quest title | `feedComponents.spec.tsx` |
| Every seeded quest icon name renders an icon | `feedComponents.spec.tsx` |

---

## 3. Measured coverage

Last measured 2026-09-05 with `npm run test:coverage` against a live database:

| Metric | Value |
| :--- | ---: |
| Statements | 74.6% |
| Branches | 65.6% |
| Functions | 69.1% |
| Lines | 77.0% |

By area (statements):

| Area | Statements |
| :--- | ---: |
| `server/middleware` | 90.6% |
| `src/config` | 85.2% |
| `src/i18n` | 93.8% |
| `src/router` | 92.3% |
| `server/routes` | 80.2% |
| `src/services` | 72.3% |
| `server/lib` | varies widely by file — `guestAuth.ts`/`downloadToken.ts` in the 90s, `retention.ts` 62.7%, `storage.ts` 68.3% |
| `src/api` | 59.4% — `ingestApi.ts` at 2.7% is the outlier: its real network calls are exercised through the frontend component specs (`photographerIngestPortal.spec.tsx`, `photographerIngestPanel.spec.tsx`) via mocks, not through a dedicated unit spec of the module itself |
| `src/components` | varies by component, roughly 30-100% — every component now has *a* spec (G1, `OPEN_ITEMS.md`); depth varies (`ModerationQueue.tsx` and `PricingPlansModal.tsx` are at 100%, `HostDashboard.tsx` and `PhotoCard.tsx` are the thinnest) |

All 27 components under `src/components/` have at least one direct test as
of the G1 pass in `OPEN_ITEMS.md` — the "still untested" list this section
used to carry (camera modal, lightbox, host dashboard, projector screen,
layout components) is gone. What's left to improve is *depth* on the
lower-percentage files above, not existence of a spec at all.

`server/lib/retention.ts`'s sweep and purge paths (`purgeEventMedia`,
`sweepExpiredAlbums`) now have dedicated coverage in `retentionPurge.spec.ts`
and `purgeAndOrigin.spec.ts` — real database rows are created and purged
against a throwaway test event, not production data.

Regenerate these numbers rather than trusting them: they change with every
change to the suite.

---

## 4. On regression tests that have never failed

`moderationAndReveal.spec.ts` guards two paid features whose enforcement lives on
the server. Both were verified by *reintroducing the original bug* and confirming
the spec caught it:

- restoring the whole-room broadcast for pending photos made the moderation test
  fail with `expected [ PHOTO_ADDED ] to have a length of +0 but got 1`;
- removing the disposable-mode URL redaction made the reveal test fail with the
  real image URL where an empty string was expected.

A regression test that has only ever passed is unproven. If you change what
these cover, break the behaviour deliberately once and check the test still
notices.

The full-stack suite (`tests/e2e.test.ts`) posts photos as external URLs, which
exercises the pass-through path but not the derivative pipeline. That gap is
covered by the `storageQuota` and `moderationAndReveal` specs, which post real
base64 image payloads and assert on the resulting original, display copy and
thumbnail.
