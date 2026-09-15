# MASTER AUDIT — Momenta / WedMoments

**Date:** 2026-09-15 · **Mode:** read-only, no application code modified.

Consolidates every completed audit and verification report into one authoritative
list. Sources reconciled:

| Source | Scope |
|---|---|
| `REPO_AUDIT.md` §§1–21 | Running audit log, Sept 4–15 |
| `OPEN_ITEMS.md` | Working findings log: gaps G1–G6, decisions D1–D2, phase tables, swarm review |
| Read-only repository audit (this session) | Findings F-1 – F-13 |
| Self-audit of that audit (this session) | Findings F-14 – F-16 |
| `docs/G2_CAPACITY_BENCHMARK_RUNBOOK.md` §Results | Capacity verification, 2026-09-13 |
| `docs/TEST_SPEC_COVERAGE.md`, `docs/SECURITY.md` | Test and security reviews |
| Live verification runs | typecheck, lint, build, 1351 unit, 27 e2e, audit gate, `r2:lifecycle` report |

**Where reports disagreed, the code decided.** Three disagreements were resolved
by inspection, not by preference; each is recorded with its evidence in §6 or §4.

**Totals:** Critical 0 · High 4 · Medium 6 · Low 8 · Unfinished 4 · False
positives 3 · Needs manual verification 5 · Production blockers 3.

---

## 1. Confirmed Critical

**None.** No finding is exploitable, and none causes data loss in the current
configuration. The two findings with data-loss *potential* (M-1, H-3) require a
deploy or a container stop to trigger and are rated High rather than Critical
because the live bucket currently holds no customer data.

---

## 2. Confirmed High

### H-1 — A €49/mo plan advertises three capabilities that do not exist
**Status** CONFIRMED · **Severity** High · **Feature** Billing / Pro Planner
**Files** `src/config/plans.ts:57-70`, `src/i18n/translations/{en,bg}.ts:345-350`, `src/components/host/PricingPlansModal.tsx:202`
`pro_planner.features` renders six strings at the point of sale. Three have no
implementation anywhere: `plan.pro.f2` "White-label — remove platform branding",
`plan.pro.f4` "Custom subdomains per couple", `plan.pro.f5` "Hand archives
directly to the couple". `grep -rniE "custom.?domain|cname|dns|subdomain|white.?label|transfer.*owner"` across `server/` and `src/` returns only
`hsts: includeSubDomains` and the translation strings themselves.

The absence of the capabilities is tracked separately in §5 as planned work.
**This finding is specifically that they are sold.**
**Production impact** Commercial: a customer can pay €49/mo for a feature that
cannot be delivered, with the marketing copy as evidence in a dispute.
**Regression test required** No (copy decision) · **Blocker** Yes

### H-2 — Production container runs Node 22; every gate that tests it pins Node 24
**Status** CONFIRMED · **Severity** High · **Feature** Build / runtime
**Files** `Dockerfile:9,34`, `.nvmrc`, `package.json` engines, `.github/workflows/ci.yml:52-65`
Both Docker stages are `node:22-alpine`. `.nvmrc`=24, `engines.node`=">=24.0.0",
CI `NODE_VERSION`=24. CI's "Node version pins agree" step compares those three
**to each other only** — it never reads the Dockerfile. No `.npmrc`, so `engines`
is advisory and `npm ci` will not fail on the mismatch.
**Production impact** The runtime serving production is a different major
version from the one every test, lint and typecheck runs on, and `engines` is
false of the shipped image.
**Regression test required** Yes — extend the existing CI pin step · **Blocker** Yes

### H-3 — No graceful shutdown, on a service whose defining failure is orphaned storage
**Status** CONFIRMED · **Severity** High · **Feature** Runtime / data integrity
**Files** `server/index.ts` (no handler anywhere in `server/` or `scripts/`)
`grep -rn "process.on('SIG" server/ scripts/` → no match. No `SIGTERM`/`SIGINT`,
no `server.close()`, no `pool.end()`, no WebSocket drain. `Dockerfile` `CMD` is a
direct `tsx` exec with no init, so signals are not forwarded either.
**Production impact** `photoWrite.savePhotoVariants` guards the
files-written-row-not-committed case *within a request*; an abrupt kill bypasses
it. Every deploy or scale-down during live traffic can strand R2 objects that
nothing references and nothing will reclaim — see H-4.
**Regression test required** Yes · **Blocker** Yes

### H-4 — Nothing reclaims orphaned R2 objects: all three safety nets are inoperative
**Status** CONFIRMED · **Severity** High · **Feature** Storage lifecycle
**Files** `scripts/storage-orphans.ts`, `scripts/r2-lifecycle.ts`, `server/index.ts`
Consolidates F-8, F-17 and the storage half of H-3. Verified individually:

1. **`npm run storage:orphans` cannot see R2.** It prints
   `[orphans] STORAGE_PROVIDER=r2 — this script only walks local disk.` and exits.
   Production runs `STORAGE_PROVIDER=r2`.
2. **R2 lifecycle rules have never been applied.** Running `npm run r2:lifecycle`
   (report mode) returns: *"These credentials cannot manage lifecycle rules. The
   runtime R2 token is Object Read & Write… Lifecycle rules need Admin Read &
   Write."* The multipart-abort and `quarantine/` expiry rules exist in code and
   are **not in effect on the bucket**.
3. **Orphans are actively produced** by H-3 on every ungraceful stop.

`purgeEventMedia` only removes *referenced* objects, so it cannot help: an orphan
is by definition unreferenced.
**Production impact** Storage cost grows monotonically with no detection and no
reclamation. This is the exact failure class `REPO_AUDIT` records three prior
instances of ("delete the row, leak the bytes"), now with every net down.
**Mitigating fact** The live bucket was verified empty during the 2026-09-13
capacity benchmark, so nothing has accumulated yet.
**Regression test required** Partly — orphan detection needs an R2 path; the
lifecycle application is an operational action.
**Blocker** No (no data at risk today) — but blocks go-live with customers.

---

## 3. Confirmed Medium

### M-1 — Container health check reports healthy while the database is down
**Status** CONFIRMED · **Feature** Ops / observability
**Files** `server/index.ts` `/api/health`, `Dockerfile:77-78`
`HEALTHCHECK` curls `/api/health`, which returns
`{status:'ok', connectedSockets, storageProvider, timestamp}` and never touches
Postgres or storage.
**Production impact** Postgres dies, every request 500s, the orchestrator still
reports healthy, keeps routing traffic, and never restarts or fails over.
**Regression test required** Yes

### M-2 — Nine server error codes surface untranslated English in a Bulgarian-default UI
**Status** CONFIRMED · **Feature** i18n / error handling
**Files** `src/api/apiClient.ts:31-37`, `src/i18n/index.ts:30`
The server emits 14 machine-readable codes; `ERROR_CODE_KEYS` maps 5. The
documented fallback is the server's own message, and those are English:
`SESSION_REVOKED`, `GUEST_TOKEN_REQUIRED`, `GUEST_IDENTITY_REQUIRED`,
`CHECKOUT_REQUIRED`, `ALREADY_SUBSCRIBED`, `MANAGE_SUBSCRIPTION_IN_PORTAL`,
`NO_STRIPE_CUSTOMER`, `CONFIRMATION_MISMATCH`, plus `STRIPE_NOT_CONFIGURED`
(the only one special-cased client-side). Default language is `bg`.
**Production impact** A Bulgarian host mistyping the slug in the irreversible
delete dialog gets "Type the album address exactly to confirm deletion." in
English — in the one dialog where comprehension matters most.
**Regression test required** Yes — a code-coverage completeness assertion

### M-3 — `/api/audio` accepts image files as audio recordings
**Status** CONFIRMED · **Feature** Audio guestbook
**Files** `server/lib/validation.ts:44-63`, `server/routes/audio.ts:22-24,50,112-113`
`validateMagicBytes` — sole caller `/api/audio`, sole purpose "is this audio" —
returns `true` for JPEG, PNG, GIF and WebP, and for any ISO-BMFF `ftyp` container
with no brand allowlist (unlike its sibling `isImageMagicBytes`, which checks
brands). No multer `fileFilter`; `req.file.mimetype` is used only to pick an
extension.
**Production impact** A JPEG posted to the guestbook is accepted, stored as
`audio-message-<ts>.webm` **with content type `image/jpeg`**, charged against the
host's paid quota, broadcast as `AUDIO_ADDED`, and rendered as an entry whose
`<audio>` element silently fails. Extension and content type disagree on the
stored object.
**Regression test required** Yes

### M-4 — No automated gate exercises the production storage adapter
**Status** CONFIRMED · **Feature** CI / storage
**Files** `vitest.config.ts:60`, `vitest.r2.config.ts:38`, `.github/workflows/ci.yml:115`
The unit suite pins `STORAGE_PROVIDER:'local'`; the CI job sets
`STORAGE_PROVIDER: local` at job level, so e2e runs on local disk too. The only
R2 lane (`tests/integration/r2Storage.spec.ts`, 6 real tests) runs via
`npm run test:storage:r2`, which appears nowhere in the workflow.
**Production impact** 1351 unit + 27 e2e tests green prove nothing about the
adapter production uses. A regression in key construction, content type,
public-URL fallback or presigning ships undetected.
**Regression test required** No — the tests exist and need wiring

### M-5 — `amount_paid_cents` and `received_at` are written but never read
**Status** CONFIRMED (dedupes OPEN_ITEMS **M13** with audit **F-12**)
**Feature** Billing / webhook ledger
**Files** `server/lib/subscriptionUpgrade.ts:91-117`, `server/routes/billingWebhook.ts:226`, `database/migrations/017_stripe_webhook_events.sql`
Verified: no application code reads either column — `amount_paid_cents` appears
only in writes and one test assertion; `stripe_webhook_events.received_at` is the
sole column of 152 with no code reference at all.
OPEN_ITEMS M13's downgrade from "accounting bug" to "unread column" is
**upheld by the code**: nothing computes revenue from it, so overwriting rather
than accumulating changes no behaviour.
**Production impact** No revenue reporting is possible from the database as it
stands. Billing correctness is unaffected.
**Regression test required** No

### M-6 — 157 MB of stale local uploads while running on R2
**Status** CONFIRMED · **Feature** Storage hygiene
26,671 files under `uploads/` (135 MB) and `uploads-quarantine/` (22 MB), left
from before the R2 switch. Correctly gitignored (`uploads/*` with `.gitkeep`
exempted) — local disk only, never committed.
**Production impact** None in the container (not copied by the Dockerfile).
Developer-machine disk only. Listed because these are invisible to
`storage:orphans` in R2 mode (H-4) and to the R2 lifecycle rules.
**Regression test required** No

---

## 4. Confirmed Low

| ID | Finding | Feature | Files | Impact | Test? |
|---|---|---|---|---|---|
| **L-1** | `vercel.json` describes a deployment this app cannot support — an SPA catch-all rewrite, while the app is a stateful Express server with WebSockets, in-process FTP and schedulers. Inert config; no runtime effect. | Deploy | `vercel.json` | A Vercel deploy yields a SPA whose every API call 404s | No |
| **L-2** | Two empty files committed to the repo root (`0)`, `5`), added in `25d0943`, present in public history. Shell-redirection artefacts of this session's tooling. | Hygiene | `0)`, `5` | None | No |
| **L-3** | Three dead exports: `isDecodableImage`, `ApiErrorResponse`, `formatEuDateTime` — each referenced only at its own declaration across `server/`, `src/`, `shared/`, `tests/`, `scripts/`. | Dead code | 3 files | None | No |
| **L-4** | `NOTICE_INTERVAL_HOURS` is read by `maintenance-scheduler.ts` but absent from `.env.example`, while both its siblings are documented. | Ops config | `.env.example` | An operator tuning schedules finds two of three intervals | No |
| **L-5** | CI comment states "25 sequential SQL migrations"; there are 26. | Docs | `.github/workflows/ci.yml:145` | None; goes stale by one per migration | No |
| **L-6** | `OPEN_ITEMS.md` "Not done: M10 — guest tokens cannot be revoked" is **stale**. Resolved by inspection: `guests.token_version` exists (migration 023), `guestAuth` verifies it, and `POST /api/events/:id/guest-sessions/reset` is exactly the host-facing action the entry said was needed. | Docs | `OPEN_ITEMS.md:2842` | A reader concludes a shipped security control is missing | No |
| **L-7** | `OPEN_ITEMS.md` "Not done: the R2 lifecycle rule" predates `scripts/r2-lifecycle.ts`. PARTIALLY CONFIRMED: the constraint it states is correct and still binding; the safe subset it says was impossible has since been written. Superseded in substance by H-4. | Docs | `OPEN_ITEMS.md:3368` | Understates what exists | No |
| **L-8** | `.dockerignore` excludes `uploads/*` but not `uploads-quarantine/` or the agent dot-directories, so all are sent to the Docker build context. None is `COPY`d into the image. | Build | `.dockerignore` | Slower builds only | No |

---

## 5. Unfinished Features

Kept strictly separate from defects. **None of these is a bug.** Each is
code that was deliberately not written, or written and deliberately not enabled.

### U-1 — SMTP / email delivery: complete in code, unconfigured
`server/lib/mailer.ts` is fully implemented — lazy transport, anonymous-relay
support (auth key omitted entirely rather than sent blank), per-recipient
rejection detection, `verifyMailer`, plus bounce tracking (`email_bounces`,
migration 025) and a publicly-reachable-URL guard. `SMTP_HOST` is unset.
**Consequence, by design:** notices cannot send, so `retention_notified_at` is
never stamped, so `RETENTION_ENFORCED=true` deletes nothing. Correctly
documented in `docs/OPERATIONS.md`. A rehearsal harness exists
(`npm run retention:rehearse`, 24 checks) and passed end-to-end against a local
SMTP sink on 2026-09-15.

### U-2 — Custom subdomains per couple: not started
No DNS, CNAME, host-header or subdomain routing exists. Advertised — see **H-1**.

### U-3 — White-label branding removal, and archive hand-off to the couple: not started
No branding-suppression setting or column; no ownership-transfer route. Both
advertised — see **H-1**.

### U-4 — Retention enforcement: built, deliberately switched off (decision D1)
`RETENTION_ENFORCED` unset. Two independent preconditions gate deletion: 30-day
grace after `expires_at`, and a delivered notice at least 14 days old. The
celebration guard added 2026-09-14 (`event_date < NOW()`) prevents the free
tier — 7-day window against a 14-day notice lead — from warning couples *before*
their wedding. The decision is the owner's and is unresolved by design, not by
oversight.

*Also intentional, recorded to prevent re-reporting:* Stripe runs on test keys
(`sk_test…`) with the pre-Stripe direct-upgrade fallback still wired and
reachable while keys are unset; `plan.deluxe.f7` ("20% off photo book printing")
may be fulfilled manually rather than in code.

---

## 6. False Positives

### FP-1 — "Five env vars are declared but never read"
**Rejected.** `APP_PORT`, `DB_PORT`, `GRACE_INTERVAL_HOURS`,
`MAINTENANCE_LOG_DIR`, `RETENTION_INTERVAL_HOURS` all *are* read — the first two
by `docker-compose.yml`, the last three by `scripts/maintenance-scheduler.ts` via
a destructured `env.X` that a `process.env.X` grep does not match. No dead config.

### FP-2 — "Migration 020 is not replay-safe"
**Rejected.** Flagged by a crude grep for `ALTER TABLE`/`CREATE` without
`IF NOT EXISTS`. Reading it shows `CREATE OR REPLACE FUNCTION` and
`ALTER TABLE … ENABLE TRIGGER`, both idempotent. `server/lib/migrate.ts`'s header
explicitly addresses the `docker-entrypoint-initdb.d` replay path this concerned.

### FP-3 — "A single `JWT_SECRET` signs four token types"
**Not a defect.** Session, guest, export-download and preview tokens share the
secret, but every type carries a `purpose` claim that is verified on use, and
`algorithms: ['HS256']` is pinned (no `alg:none` confusion). Cross-purpose replay
is tested in `authHardening.spec.ts`. Recorded as a design observation only.

*Also checked and found sound, listed to prevent re-reporting:* the two
`react-hooks/exhaustive-deps` suppressions in `AppContext.tsx` are correct —
every subscriber reads fresh state via `storageService.getX()` rather than
closing over it; agent dot-directories (`.claude`, `.remember` — 368 files
including conversation logs) are all correctly gitignored and not exposed.

---

## 7. Needs Manual Verification

| ID | Area | Why unresolved |
|---|---|---|
| **V-1** | Stripe with live keys | Webhook signature verification and the checkout → webhook → tier round trip have run only against mocks and `sk_test`. |
| **V-2** | SMTP with a real provider | Deliverability, SPF/DKIM, bounce-webhook ingestion. The rehearsal used a local sink. |
| **V-3** | FTP ingest against real photographer software | Lightroom tethering / camera FTP. The integration test drives `basic-ftp` only. |
| **V-4** | Service capacity ceiling (G2, second half) | The 2026-09-13 benchmark saturated the host uplink at 8.7 MB/s — CPU 17–49%, pool 12/40 — so the service's own limit was never reached. Needs real hosting with the generator elsewhere. |
| **V-5** | ~84 unread spec files | Executed, never read. "Tests with weak assertions / tests that always pass" is evidenced only for the ~38 specs read — and three such tests were found among those, so the rate in the remainder is not zero. See §8. |

---

## 8. Test Gaps

**Current state (verified this session):** `npm run test:coverage` → 122 files,
1351 tests, 0 failures. Statements 86.93% · Branches 82.06% · Functions 83.31% ·
Lines 88.55%. `npm run test:e2e` → 27 passed. No skipped or disabled suites.

**Missing regression tests, each tied to a finding:**

| # | Test | Catches |
|---|---|---|
| 1 | Node pin check includes the Dockerfile | H-2 — the current drift |
| 2 | Graceful shutdown drains in-flight work | H-3 — orphans on deploy |
| 3 | `/api/health` fails when the DB is unreachable | M-1 |
| 4 | Every server error code has a client translation | M-2, and the next code added |
| 5 | `/api/audio` refuses an image | M-3 |
| 6 | Advertised plan features map to implemented capabilities | H-1, at authorship |
| 7 | R2 adapter contract runs in CI | M-4 — the tests exist, unwired |

**Structural gaps:**
- **The production storage adapter has no automated coverage at all** (M-4).
- **Three tests were found passing for the wrong reason** during this session's
  work — a `vi.waitFor` on a negative assertion that resolves before the
  fire-and-forget work runs; an assertion on a value already true before the
  event; a test named for an unreachable guard. All were caught by breaking the
  source, not by reading. This is the basis for V-5.
- **Two self-policing mechanisms exist and are unusual**, worth preserving:
  `testPortAllocation.spec.ts` (no two specs may bind the same port, arithmetic
  resolved) and `tests/setup.ts`'s refusal to run against a non-local provider.

---

## 9. Production Blockers

| # | Finding | Why it blocks |
|---|---|---|
| 1 | **H-2** Node 22 in the container vs 24 everywhere else | The runtime serving production is untested at that version, and the guard built to catch this cannot see the Dockerfile. |
| 2 | **H-3** No graceful shutdown | Every deploy under load can strand R2 objects, and with H-4 nothing will ever reclaim them. |
| 3 | **H-1** Selling three unbuilt capabilities | Commercial, not technical: taking €49/mo for a feature that cannot be delivered. |

**Close to blocking, not yet:** H-4 (no orphan reclamation — no data at risk
*today* because the bucket is empty, but it blocks onboarding real customers) and
M-1 (health check cannot detect a dead database).

**Explicitly not blockers:** U-1 through U-4. Unconfigured SMTP and disabled
retention are safe resting states, not defects — the system fails closed in both.

---

## Appendix — Disagreements resolved by code

| Disagreement | Sources | Resolution |
|---|---|---|
| Are guest tokens revocable? | `OPEN_ITEMS.md:2842` says no ("Not done"); migration 023 says yes | **Code wins: they are.** `guests.token_version` exists, `guestAuth.ts:19,55` verifies it, `events/crud.ts:466` is the host reset action. The log entry is stale → L-6. |
| Is `amount_paid_cents` an accounting bug? | Original swarm finding says yes; `OPEN_ITEMS` M13 downgrades it | **Code upholds the downgrade.** Grep confirms write-only; nothing computes revenue from it → M-5. |
| Can an R2 lifecycle backstop be applied? | `OPEN_ITEMS:3368` says it cannot be applied as described; `scripts/r2-lifecycle.ts` implements a safe subset | **Both are partly right.** The `events/` constraint is real and binding; the safe subset was written — but `npm run r2:lifecycle` proves it has **never been applied**, because the app's token lacks the scope → H-4, L-7. |
| Do the docs have zero drift? | `REPO_AUDIT` §21 claims zero | **Upheld for its four mechanical checks** (paths, npm commands, routes, schema columns), which I re-ran. **Withdrawn as a general claim:** L-5 and L-6 are drift those checks do not cover. |

---

*No fix plan. No application code modified. Findings are ordered by severity, not
by discovery.*
