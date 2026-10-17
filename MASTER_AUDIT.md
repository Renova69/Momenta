# MASTER AUDIT — Momenta / WedMoments

**Audited:** 2026-09-15, read-only. **Fixes applied and recorded:** 2026-09-17.
**Post-audit findings added:** 2026-09-18, extended 2026-09-19 (§3b).
**Feature review:** 2026-09-21 (§3c). **Accessibility review:** 2026-09-21 (§3d).
**Client mutation sweep:** 2026-09-21 (§8).
**Performance pass:** 2026-09-22 to 23 (§3e).
**Security review, partial:** 2026-09-25 to 26, recorded 2026-10-04 (§3f). **All 25 findings fixed.**
**Remaining five domains:** reviewed 2026-10-05 (§3g). **All 36 findings fixed.**
**Review of the §3g fixes:** 2026-10-10 (§3h). **All 12 findings fixed.**
**Running-app feature pass:** 2026-10-14 (§3i). **26 of 27 fixed; N-112 kept by the owner's decision.**
**Follow-up on the production build (speed, keyboard, screen reader):** 2026-10-15 (§3j). **All 16 fixed** (N-139 and N-149 after the owner's decision).
**Stripe end to end in the sandbox, a load test, and a third running-app pass:** 2026-10-16 to 17 (§3k). **13 of 15 fixed; N-159 and N-163 wait on the owner.**

> **Read this first.** The audit below is preserved as written — each finding
> still describes the code as it was on 2026-09-15, because a finding rewritten
> to match the fix stops being evidence that the fix was needed. What changed is
> that every confirmed finding now carries a **FIXED** line naming the commit,
> and §9 records what is actually left.
>
> **State on 2026-09-21:** all three production blockers cleared in code. Of the
> 20 findings the audit itself produced (12 in §§2–3, 8 in §4): **19 fixed** —
> H-4's last net, the R2 lifecycle rule, confirmed on the bucket on 2026-09-19 —
> and **1 resolved as not a defect**: L-1's premise was wrong, `vercel.json` is
> genuinely in use.
>
> **§3b records 14 further findings the audit did not produce, all of them
> fixed.** All but one were found by *running* something the audit had only
> read; the exception, N-14, surfaced while building a feature on top of the
> code it was in. That is
> the most useful thing in this document: reading code does not catch a
> container that will not start, a sweep that reports work it did not do, or a
> teardown that deletes another process's data. One of them, N-3, is the root
> cause of the intermittent suite failures that had previously been blamed on
> database contention.
>
> **§3c records 15 more, from a review that asked a different question:** not
> whether the code is correct, but whether each feature does what it is sold as
> doing, tier by tier. All fixed. The pattern there is worth as much as the
> findings — most of them are places where every step was reasonable and the
> whole was wrong, which is what you see when you follow a feature end to end
> instead of reading a file.
>
> What remains is operational (§9). Two of those items, key rotation and SMTP,
> are **deferred by the owner** — see §9.
>
> **Superseded on 2026-10-04 by §3f.** A security review on 2026-09-25 and 26
> covered three of eight domains before stopping. It returned **25 open
> findings, two of them High**: N-34, album expiry that moves forward every
> night so retention can never act, and N-35, a dunning downgrade that leaves
> the customer paying. Code work remains, and five domains are unreviewed.

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

**Totals as audited:** Critical 0 · High 4 · Medium 8 · Low 8 · Unfinished 4 ·
False positives 3 · Needs manual verification 5 · Production blockers 3.

**Totals as of 2026-09-21:** of the audit's own 20 findings — 19 fixed, L-1
resolved as not a defect. Of the 14 post-audit findings in §3b — 14 fixed.
Of the 15 feature-review findings in §3c — 15 fixed (2 Critical, 6 High,
6 Medium, 1 Low). Of the 13 accessibility findings in §3d — 13 fixed
(3 High, 9 Medium, 1 Low): six from a source pass, seven more from running
axe in a real browser at two viewports. What is left there needs a screen
reader and a person.
Production blockers 0 in code, 3 operational actions outstanding (§9). The 4 unfinished features are unchanged
and none is a defect; of the 5 verification items, V-5 is substantially
addressed by mutation testing rather than by reading, and V-1 to V-4 still need
real credentials, real hardware or real third-party services.

Two of those Medium findings, **N-1** and **N-2**, were not produced by the
audit passes. They were found while implementing the fixes, by running things
the audit only read: the container, and the test suite under CI's conditions.
Both are recorded in §3 with that provenance, because it is the more useful
finding — an audit that reads code does not catch a container that cannot
start.

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
**FIXED** `35e19b4`. All three strings removed from `pro_planner.features` and
from both translation tables, on the owner's instruction to remove rather than
qualify them. `tests/unit/i18n.spec.ts` now asserts every advertised feature
resolves in both languages, which catches the next one at authorship. The
capabilities themselves remain unbuilt — see U-2, U-3.

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
**FIXED** `a423a38`. Both Docker stages are `node:24-alpine`, and CI's pin step
now reads the Dockerfile's `FROM` lines alongside the other three sources, so
the gate can finally see the thing it exists to check. Building the image to
verify that is what surfaced N-1.

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
**FIXED** `fadbd7c`. SIGTERM and SIGINT stop accepting connections, let
in-flight requests finish inside an 8s budget (`SHUTDOWN_BUDGET_MS`), then
close the WebSocket manager, the FTP listener and the pool before exiting. A
second signal is ignored rather than restarting the sequence and double-closing
the pool, and the hard-exit timer is `unref`'d so it cannot itself hold the
process open.

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
**FIXED** 2026-09-19. All three nets are up.

1. **Orphan detection sees R2** — `bfbbcb7`. Paginated listing that aborts on a
   truncated page rather than reporting a partial one as complete, an
   unrecognised key never treated as an orphan, and a refusal to act when the
   events table is empty while the bucket is not. Exercised against the live
   bucket with four seeded objects (live / orphan / quarantined orphan /
   unrecognised): correct on all four, and the empty-events guard refused to
   delete. `bce0e6a` then fixed the local half, which had never walked the
   quarantine tree at all and reported removals it had not performed.
3. **Orphan production stopped** — `fadbd7c` (H-3).

2. **Lifecycle rules are on the bucket** — confirmed 2026-09-19. `4bf398d` made
   the script usable: it takes `R2_ADMIN_*` credentials instead of requiring you
   to overwrite the app's token in `.env`, refuses to write over a configuration
   it could not read, and names any rule on the bucket the policy would destroy
   rather than dropping it silently. Run by the owner with a temporary Admin
   Read & Write token, `npm run r2:lifecycle` read back both rules the policy
   carries — `Abandoned quarantine objects` (`quarantine/`, 400 days) and
   `Default Multipart Abort Rule` (7 days) — already in place and identical to
   the file, so nothing needed applying.

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
**FIXED** `5ff35e0`. Probes the database with `SELECT 1` behind a 2s deadline —
deliberately inside the Dockerfile's `--timeout 5s`, so a slow answer is
reported with a reason instead of being killed as a timeout — and returns 503
`{status:'degraded', database:'unreachable'}`. `Promise.race` rather than a
statement timeout, because the likeliest failure is pool exhaustion, where the
query never starts and a statement timeout never fires. Readiness, not liveness:
failing says "send me no work", not "restart me", which is safe here because
nothing in this deployment acts on a failing HEALTHCHECK; the tradeoff is
documented in `server/lib/health.ts` for orchestrators that do. `4bf398d` then
cleared the deadline the race left armed on every healthy probe.

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
**FIXED** `84c7753`. All nine mapped, with strings in both tables. The guard is
the general form rather than nine assertions: it reads every `code:` literal out
of `server/` and fails when one is missing from the map or from either language,
so the tenth fails the build on the commit that adds it. A further assertion
stops the map degenerating into nine codes pointing at one generic line, and a
fifth guards the guard — if the regex or the directory layout stops matching,
the suite would otherwise pass over an empty list and quietly test nothing.

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
**FIXED** `1625fc3`. `validateMagicBytes` had one caller, so it was replaced
rather than forked: `detectAudioFormat` admits WebM, Ogg, ISO-BMFF with an
audio/video brand, and MP3. The `ftyp` brand allowlist mirrors what
`isImageMagicBytes` already did on the image side — HEIC and AVIF share the
container with MP4, which is how an iPhone photo passed a check about audio —
and covers what `MediaRecorder` actually emits, including the `iso*`/`dash`
brands Safari's fragmented output carries. MP3 frame-sync detection was
`buf[1] & 0xE0`, which matches a great deal of arbitrary binary; it now also
rejects the reserved version and layer values.

It returns the format rather than a boolean because the route needed the same
answer three times. The stored object's Content-Type and extension came from
`req.file.mimetype`, a client-supplied string written verbatim onto an R2 object
served from a public URL — genuine audio declared `text/html` was served back as
a document. Both are now derived from the validated bytes, so the declared type
cannot disagree with the content: it is no longer read.

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
**FIXED in code, pending a secret.** `211c14d` added a `live-storage` job on a
nightly schedule plus `workflow_dispatch`, never on `pull_request` — a fork
cannot read repository secrets, and a job that skips silently on every external
contribution is worse than one that never claimed to run. It is deliberately not
a required check: a blip against a third-party API should not block a merge. The
same commit fixed the suite leaking two objects per run, which it did because it
deleted the event rows before purging their media and the cascade took the photo
rows with it.
**Still an owner action:** without `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `R2_PUBLIC_URL` as repository secrets — and ideally
`R2_TEST_BUCKET_NAME`, since a second bucket costs nothing and the alternative
is a cleanup routine operating on customers' weddings — the job skips nightly
and this gap is closed only on paper.

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
**Resolved — documented, not changed.** The owner's decision: both columns are
write-only audit metadata and stay as they are. `docs/DATABASE_SCHEMA.md` now
says so on each column, with the reason — Stripe is the authority on what a
customer paid, and a revenue figure would need its own ledger keyed by payment
rather than a column one cancellation can overwrite. Making it accumulate would
have been inventing semantics for a field with no consumer, which is the
conclusion OPEN_ITEMS M13 had already reached independently.

### M-6 — 157 MB of stale local uploads while running on R2
**Status** CONFIRMED · **Feature** Storage hygiene
26,671 files under `uploads/` (135 MB) and `uploads-quarantine/` (22 MB), left
from before the R2 switch. Correctly gitignored (`uploads/*` with `.gitkeep`
exempted) — local disk only, never committed.
**Production impact** None in the container (not copied by the Dockerfile).
Developer-machine disk only. Listed because these are invisible to
`storage:orphans` in R2 mode (H-4) and to the R2 lifecycle rules.
**Regression test required** No
**FIXED** `bce0e6a`, and the sweep it exposed two bugs in. Running it found
that the local scan had never walked the quarantine tree — `QUARANTINE_DIR`
defaults to a *sibling* of the uploads directory, the same layout detail behind
N-1 — and that the removal loop counted a directory as gone whenever `fs.rmSync`
did not throw. It does not always throw: the first pass reported 7,234 folders
removed while 616 were still on disk, silently. Both fixed and tested.
~700 MB reclaimed across three passes on the development machine; both live
albums and their 67 files untouched; a re-run reports zero. The owner's
instruction was orphans only, not a wholesale delete of `uploads/`, because two
albums still hold 12 photo rows pointing at local paths.

### N-1 — The container could not start: `uploads-quarantine/` was never created
**Status** CONFIRMED · **Feature** Deploy / container
**Files** `Dockerfile`, `docker-compose.yml`
Found while verifying the fix for H-2, not by the audit passes — nothing in
those passes ran the image. The Dockerfile created and chowned `uploads/` but
not `uploads-quarantine/`, and `QUARANTINE_DIR` defaults to a *sibling* of
the uploads directory rather than a child, so it was never covered by the
existing `mkdir`. The process runs as `node`, not root, and could not create it
at runtime.
**Production impact** The container exits on start under the default
configuration. `docker compose up` was broken for the same reason plus a
second: Compose defaults `STORAGE_PROVIDER=local`, so the quarantine path is
actually used there.
**Regression test required** No — fixed in the same commit as H-2; the gate
that would have caught it is running the image at all, which the `docker`
job now does.
**FIXED** `ae46774`.

### N-2 — `ReactionBar` leaked a timer across component unmount
**Status** CONFIRMED · **Feature** Gallery / reactions
**Files** `src/components/gallery/ReactionBar.tsx`
A `window.setTimeout` scheduled on send was never cleared on unmount. Under
jsdom the callback fires after teardown and throws
`ReferenceError: window is not defined`, which fails CI as an unhandled error
while every test reports passing.
**Production impact** In a browser the leak is benign — a `setState` on an
unmounted component. The real cost was a CI failure mode that does not name
the test responsible.
**Regression test required** No — the failure is the test suite itself.
**FIXED** `d8606d7`. The same leak class later turned up in the health probe's
`Promise.race` deadline (`4bf398d`), which is why that one now has a test.

---

## 3b. Found After the Audit (2026-09-17 to 19)

None of the findings below came from the read-only passes. All but N-14 were
found by **running** something the audit had only read — the container, the storage
sweep, the lifecycle script, the test suite under its own conditions, or the
source with a mutation in it. That is the single most useful observation in this
document: an audit that reads code does not catch a container that will not
start, a sweep that reports work it did not do, or a teardown that deletes
another process's data.

They are numbered in the N- series that began with N-1 and N-2.

### N-3 — The test teardown deleted a concurrent run's fixtures
**Status** CONFIRMED · **Severity** High (test integrity) · **Feature** Test infrastructure
**Files** `tests/globalSetup.ts`, `scripts/purge-test-data.ts`
**The root cause of this repository's intermittent suite failures**, which had
been attributed to database contention for long enough to be written into
`vitest.config.ts`'s comments.

`purgeTestData` deletes every event and user whose address is in a test domain.
Identification by domain says *whose* rows these are; it says nothing about
*when* they were made. The teardown that calls it fires whenever any Vitest
process finishes — including while another is halfway through a suite.

Reproduced deliberately rather than inferred: firing that purge against a
running suite deleted **11 events and 152 users** and failed **11 tests across 6
unrelated spec files** (`concurrentUploadQuota`, `exportDownload`,
`ingestRoutes`, `photoComments`, `photoReactions`, `slugConcurrency`). That is
the observed signature exactly — a broad scatter across whichever DB-touching
specs were mid-test, different files each time, green on a re-run done alone. It
also explains why six consecutive runs in a loop were clean: one run at a time.

The 152-users-to-11-events ratio is the tell. Users were matched by domain with
no event constraint at all, and deleting a user cascades into their albums.
**FIXED** `9a24447`. A run now cleans up after *previous* runs, never its peers:
`setup()` records the start instant and teardown passes it as a cutoff, so rows
created during a run are out of reach by construction rather than by timing.
Accumulation stays bounded at one run's worth — demonstrated: run 1 purged
nothing and left 54 events, run 2 collected exactly those 54 and left its own.

Two things would have made the cutoff a lie, and both are part of the fix:

- Deleting a user cascades into their events, so an old host holding a new album
  would still take a live fixture down. The user delete carries
  `AND NOT EXISTS (... events ... created_at >= cutoff)`.
- The cutoff must come from Postgres, not `new Date()`. Rows are stamped by the
  database's clock and the two are several hundred milliseconds apart on this
  machine — enough for a row inserted with `NOW()` immediately after a JS
  timestamp to land *before* it, reintroducing the timing dependence the cutoff
  exists to remove.

**Regression test required** Yes — `tests/unit/purgeScope.spec.ts`, which uses
`dryRun` throughout on purpose: a test calling the real delete would remove
every fixture older than its cutoff, including those of sibling specs in
parallel workers, reproducing the bug it exists to prevent.

### N-4 — The teardown deleted from R2 and never from local disk
**Status** CONFIRMED · **Severity** Medium · **Feature** Test infrastructure / storage
**Files** `tests/globalSetup.ts`, `package.json` scripts
`tests/setup.ts` refuses to let the unit suite run against remote storage, and
that guard covers the *worker* processes, where `vitest.config.ts`'s `test.env`
applies. `globalSetup` is not one of them: it runs in Vitest's main process,
which `test.env` never touches, so it resolved `STORAGE_PROVIDER` from `.env`.

On any machine whose `.env` says `r2` — which is this one, and which is what
production runs — the teardown called `purgeEventMedia` against the **live
Cloudflare bucket** after a suite that had written every byte to local disk.
Measured, not inferred: the main process resolved `r2` while a probe inside a
worker reported `local`.

Every `npm run test:unit` therefore issued real DeleteObject calls against
production storage — no-ops only because a local disk path is not a key that
exists in the bucket — while the local files it was meant to delete were never
touched, and it reported success either way. CI was never affected: the workflow
sets `STORAGE_PROVIDER=local` at job level.
**FIXED** `cab08a5`. The scripts pin the provider for the whole invocation
rather than only its workers, and the teardown asserts the pin held before
purging anything.

### N-5 — Forty spec files deleted event rows without purging media
**Status** CONFIRMED · **Severity** Medium · **Feature** Test infrastructure / storage
**Files** 40 spec files, `tests/helpers/cleanup.ts`
`DELETE FROM events` cascades to the photo and audio rows, and those rows are
the only record of where the bytes live. Delete them first and the files are
stranded with nothing left to identify them — the failure this repository has
recorded four times in application code, reproduced by its own test suite on
every run.

Measured from a clean disk: a full run left **7,267 orphaned album directories
and 421 MB**. It now leaves 2 to 3 directories and about 4 MB. This is where the
10,431 directories swept off the development machine came from.
**FIXED** `46e2995`. All 62 call sites go through `tests/helpers/cleanup.ts`,
which purges media first — so every spec exercises the ordering production must
follow. `tests/unit/fixtureCleanup.spec.ts` names any file that goes back to the
raw statement. The same commit fixed `purge-test-data` selecting doomed events
by the event's own `host_email` and then deleting users, whose cascade took
events the purge had never seen.

### N-6 — The migration spec poisoned its own next run
**Status** CONFIRMED · **Severity** Low · **Feature** Test infrastructure
**Files** `tests/unit/migrate.spec.ts`
Fixed scratch table, fixed ledger filenames, and the ledger is a real table
shared by every run. A run killed part-way leaves `900_spec_create.sql` recorded
as applied; the next run fails exactly two tests because `runMigrations`
correctly declines to re-apply it, and that run's `afterAll` clears the row so
the run after passes. Fail once, pass on retry, nothing reproducible.
Reproduced by seeding one leftover row.
**FIXED** `06c68b5`. Fixtures are suffixed per run, making the collision
impossible rather than unlikely.

### N-7 — Two cross-tenant holes in the realtime layer
**Status** CONFIRMED · **Severity** High · **Feature** WebSockets
**Files** `server/ws/wsServer.ts`
Found by mutation testing; both were reachable and neither was asserted.

1. **Host privilege.** The ownership check is
   `rows.length > 0 && rows[0].host_user_id === userId`. Dropping the second
   half hands host privileges to anyone holding any valid session token, for any
   album that exists — and host privilege gates the moderation queue and the
   pending-photo channel. All 40 spec files reaching the module stayed green.
   The existing tests covered an owner on their own album and an invalid token;
   nobody had tried a *valid token for somebody else's wedding*.
2. **Room switching.** Leaving a room is guarded by
   `oldMeta.eventId !== eventId`. Flip it and the client stays subscribed to the
   album it left, so a guest who opens a second wedding link keeps receiving the
   first couple's photographs.

**FIXED** `d43766e` — tests, not code: the production logic was already correct
and entirely unverified. Toggle-verified in both directions.

### N-8 — The storage sweep reported work it had not done
**Status** CONFIRMED · **Severity** Medium · **Feature** Storage hygiene
**Files** `scripts/storage-orphans.ts`
Two faults, both found by running it:

- It walked `UPLOADS_DIR/events` only. `QUARANTINE_DIR` defaults to a *sibling*
  of the uploads directory rather than a child — the same layout detail behind
  N-1 — so the quarantine tree was never scanned. It held 2,577 orphaned albums.
- It counted a directory as removed whenever `fs.rmSync` did not throw. It does
  not always throw: one pass reported 7,234 folders removed while 616 were still
  on disk, silently. A sweep that overstates what it freed is worse than one
  that fails loudly, because the second gets re-run.

**FIXED** `bce0e6a`. It verifies each removal, names survivors, retries
transient locks, exits non-zero when any remain, reports bytes actually freed,
and carries the R2 branch's empty-database guard.

### N-9 — The lifecycle script could not be run the way its own note said
**Status** CONFIRMED · **Severity** Medium · **Feature** Storage lifecycle
**Files** `scripts/r2-lifecycle.ts`
Three faults, all found trying to apply the policy for real:

- Its note said to use "a separate admin token that is not the one the app
  carries", and gave no way to pass one. The only route was editing
  `R2_ACCESS_KEY_ID` in `.env`, which makes the application's own credentials an
  admin token until someone remembers to change them back.
- Only the 403 case returned early. Every other read failure fell through to a
  Put that **replaces the entire configuration** — a blind overwrite of rules the
  script had never seen.
- It hardcodes a copy of Cloudflare's default rule and calls that "preserving"
  it, which holds only while nobody has added anything in the dashboard.

**FIXED** `4bf398d`. `R2_ADMIN_*` credentials, a refusal to write over an unread
configuration, and any unknown rule named with the run stopped.

### N-10 — The health probe leaked its deadline
**Status** CONFIRMED · **Severity** Low · **Feature** Ops / observability
**Files** `server/lib/health.ts`
The loser of a `Promise.race` is not cancelled, so every healthy probe left its
2s timeout armed — on an endpoint an orchestrator calls every few seconds for
the life of the container. The same leak class as N-2, introduced by the fix for
M-1.
**FIXED** `4bf398d`, with a test that tracks the timer by its delay rather than
counting live timers.

### N-11 — Three tests that could not fail
**Status** CONFIRMED · **Severity** Medium (test integrity) · **Feature** Test suite
**Files** `tests/unit/feedComponents.spec.tsx`, `tests/unit/tierGatingEndToEnd.spec.ts`
Beyond the three recorded in §8, a mechanical scan of all 126 spec files found
two more that could not fail, and mutation testing found the class the scan
could not see:

- `feedComponents` "asks to capture the quest the guest chose" **asserted
  nothing for its entire life**. It walked from the title to
  `closest('div').parentElement`, took the first button there — none — and
  guarded its only assertion behind `if (button)`. Replacing the handler body
  with `undefined` left it green.
- `tierGatingEndToEnd`'s gate-tier check iterates `if (gate.name in advertised)`.
  Rename a gate and `in` stops matching, no iteration body runs, and a test about
  what the customer is charged for passes having checked none of it.

**FIXED** `147b131`. Both repaired and toggle-verified.

---

### N-12 — A harvested guest id was accepted as proven identity on upload
**Status** CONFIRMED · **Severity** High · **Feature** Guest uploads
**Files** `server/routes/photos/upload.ts`
The weakest module of the sweep at 11/15, with all four survivors inside one
block: the one that decides whose guest id an upload counts against.

The worst turns the ownership check inside out. With `&&` where the code has
`||`, a client-supplied `guestId` is cleared only when the guest row is missing
*and* the token is bad — so a real guest id plus any rubbish token passes as
proven identity. Every photo in the feed carries its `guestId`, so the id is
public and the token is the only thing that is not. Proven identity decides both
which guest an upload counts against and whether a signed durable token comes
back, so the hole is worth a quota and a credential.

The last survivor was not where its line number suggested: `tokenVersion =
Number(...token_version) || 0` is the same defect found in `lib/guestIdentity.ts`,
because upload kept its own copy of the identity logic. Forcing the version to 0
means that after a host resets guest sessions, a proven guest's upload mints a
token at version 0 that the verifier then rejects against the row's 1 —
permanently. The gap existed twice and had to be closed twice; the duplication
itself is what `0c01347` then removed.

**FIXED** `05cae17`, five tests covering both directions (a blanket refusal
would satisfy the impersonation cases and break every returning guest), each
toggle-verified; the shared resolution extracted in `0c01347`. Module now 15/15.

---

### N-13 — Two Zod caps wider than the columns behind them
**Status** CONFIRMED · **Severity** Medium · **Feature** Host accounts
**Files** `server/routes/auth.ts:60`, `server/routes/auth.ts:351`
`RegisterSchema.companyName` was `z.string().max(200)`; `users.company_name` is
`VARCHAR(150)`. `UpdateProfileSchema.fullName` was the same 200 against
`users.full_name`, also `VARCHAR(150)`. Anything between 151 and 200 characters
passed validation, reached Postgres, and came back as `22001` — which neither
handler names, so both answered **500** to a request their own schema had just
accepted, with nothing in the response naming the field at fault.

The same shape as M12, and found the same way the M-series were: by asking what
the boundary actually promises. Both caps now match the column, so the refusal
happens at the boundary as a 400.

**FIXED** `6236ac4`. Both directions tested — over the cap refused, at the cap
accepted and persisted.

---

### N-14 — A photo upload could credit a guest on another wedding's quest
**Status** CONFIRMED · **Severity** Medium (cross-tenant integrity) · **Feature** Scavenger quests
**Files** `server/routes/photos/upload.ts`
`POST /api/photos` took `questId` from the request body and used it twice
without asking which event the quest belonged to: it stored it on the photo row,
and it recorded a quest completion for the uploading guest. A guest of one
wedding could therefore name any other wedding's quest. Quest ids are not
secret: `GET /api/events/:id/quests` lists them for anyone who has the event id,
and the slug endpoint hands out the event id.

Before the leaderboard the damage was small but real. The other wedding's quest
showed an outsider in its completion count, and the uploader's own feed labelled
the photo with the other wedding's quest title, which the feed joins by id. Once
a leaderboard ranks completions and a host hands a prize to the top of it, the
same row would put a stranger on another couple's board.

Unlike the rest of this section, this was not found by running anything. It
surfaced while designing the leaderboard query, by asking which rows the ranking
could trust. The leaderboard pins every join to the event as well, so a row like
this could not have ranked even without the fix. The fix is at the source
because the photo label leaked regardless.

**FIXED** `8db42dc`. The upload keeps `questId` only when it names a quest of
the upload's own event; otherwise it is dropped and the photo still uploads.
The spec uploads to one wedding with another wedding's quest, then asserts that
wedding's board is empty and the photo row's `quest_id` is null. It was
toggle-verified by widening the event check.

---

## 3c. The Feature Review (2026-09-21)

Six agents were asked a different question from the one the audit asks. Not
"is this code correct" but "does this app do what it says it does" — feature by
feature, tier by tier, following each one from the pricing page to the row it
writes. Fifteen findings, all fixed, numbered N-15 onwards.

What the shape of them says: the audit's read-only passes and the mutation
sweep had already been over most of these files. Nearly everything below was
found by asking what a *guest or host* would experience, not what a function
returns. Four of the five most serious ones are places where the code did
something reasonable at each step and the wrong thing overall — a purchase that
downgrades, a guest's expired token that logs the host out, a delete that
succeeds after the file it was meant to remove did not.

| ID | Finding | Severity | Files | Fixed |
|---|---|---|---|---|
| **N-15** | Buying a plan could **downgrade** an album. `applyTierUpgrade`'s upsert wrote `EXCLUDED.tier` unconditionally, so a host who already held VIP and bought a Celebration Pass lost the VIP features they had paid for. | Critical | `server/lib/subscriptionUpgrade.ts`, `server/routes/billing.ts` | `712528c` |
| **N-16** | A guest's 401 ended the **host's** session everywhere. The client treated every 401 as "your login expired", so an expired guest token on a shared device logged the host out of every album. | High | `src/api/apiClient.ts`, `src/services/authService.ts` | `712528c` |
| **N-17** | Photo deletion removed the database row first and the stored object second. A storage failure then left an orphan nothing pointed at, counted against nobody's quota, found only by the orphan sweep. | High | `server/routes/photos/moderation.ts` | `712528c` |
| **N-18** | The R2 adapter's `delete` swallowed its error and returned as though it had worked. Every caller above it believed the object was gone. | High | `server/lib/storage.ts` | `712528c` |
| **N-19** | **Disposable camera mode was cosmetic.** Locked photos were sent to every guest's browser in full and hidden with CSS. Anyone with dev tools could see the whole album before the reveal — the one thing the feature sells. | Critical | `server/routes/photos/feed.ts`, `server/lib/photoQuarantine.ts`, `src/components/gallery/PhotoCard.tsx` | `15dec3f` |
| **N-20** | A quest retake **wiped the points already earned**. The leaderboard required the completion's own photo to survive, so replacing a photo scored zero until the new one was approved. | High | `server/lib/questLeaderboard.ts` | `15dec3f` |
| **N-21** | Rejected photos counted towards the tier photo caps. A host who moderated strictly hit the free tier's 50-photo ceiling with fewer than 50 photos in the album. | Medium | `server/middleware/tierGate.ts` | `afa3b65` |
| **N-22** | A non-default `themePalette` could be set at event **creation** on the free tier. The gate existed on update only. | Medium | `server/routes/events/crud.ts` | `afa3b65` |
| **N-23** | A truncated upload reached `sharp` without `failOn: 'truncated'`, so a half-transferred photo could be stored as a valid but incomplete image. | Medium | `server/lib/images.ts` | `afa3b65` |
| **N-24** | A deleted album left every guest still on it staring at a screen that never changed. No `EVENT_DELETED` handling, and the not-found screen offered no way out. | High | `src/services/realtimeMessages.ts`, `src/context/AppContext.tsx`, `src/components/common/EventNotFound.tsx` | `2416460` |
| **N-25** | Withdrawing an approval left the photo public. Setting a photo back to `pending` or `rejected` did not return it to quarantine, so the URL kept working. | High | `server/routes/photos/moderation.ts`, `server/lib/photoQuarantine.ts` | `2416460` |
| **N-26** | Four client actions failed silently — the optimistic update stayed on screen after the server refused it, and the next sync reverted it with no explanation. | Medium | `src/services/photoService.ts`, `src/services/eventService.ts` | `2416460` |
| **N-27** | **A quest could not be deleted.** `DELETE /api/quests/:id` existed and was documented; nothing called it, so a mistyped quest stayed in front of every guest for the whole reception. | Medium | `src/services/questService.ts`, `src/components/host/dashboard/QuestsTab.tsx` | `af2721e` |
| **N-28** | `storage-recount` treated a failed read as a file of zero bytes, so one transient storage error wrote a smaller number over a correct one. Accounting drifting downwards, with nothing to notice it. | Medium | `scripts/storage-recount.ts` | `af2721e` |
| **N-29** | Three untrue claims: `is_active` on `scavenger_quests` documented as retiring a quest when nothing writes or reads it; the README still selling White-label after the pricing page dropped it; the free tier advertised at 500 MB against an enforced 512. | Low | `docs/DATABASE_SCHEMA.md`, `README.md`, `src/config/plans.ts` | `af2721e` |

Two handlers for messages nothing sends were removed with N-27 (`REACTION_SENT`
on the client, superseded by the coalesced batch; `LEAVE_EVENT_ROOM` on the
server, where the close handler and heartbeat reaper do the work). Not defects
— dead code that reads like a contract.

Every fix is toggle-verified. Six tests had to be changed because they encoded
the old behaviour, each with the reason written beside it; three toggles were
equivalent mutants and are named as such in their specs rather than worked
around.

---

## 3d. The Accessibility Review (2026-09-21)

The first one. No audit pass, no review and no test had ever asked what this
app is like for someone who cannot see the screen or cannot use a mouse, and
it showed: the findings are systemic, not scattered. Six findings, all fixed
in `1762ded`, numbered A-1 to A-6.

Worth stating plainly, because it shapes what to do next: **an automated pass
cannot close this subject.** `tests/unit/accessibility.spec.tsx` runs axe over
three dialogs in jsdom, which has no layout and no pixels, so colour contrast,
focus order across a real page, touch-target size and what a screen reader
actually says out loud are all still unverified. They need a browser and a
person. What is fixed below is the part that was decidable from the source,
and it was the larger part.

| ID | Finding | Severity | Files | Fixed |
|---|---|---|---|---|
| **A-1** | **No overlay in the app was a dialog.** All five — lightbox, camera, guest sign-in, host profile, pricing — were `<div className="fixed inset-0">`: no `role`, so assistive technology read the page behind them as if the overlay were not there; no Escape; no focus management, so Tab walked out of the dialog into a page hidden under the backdrop, where every control is still focusable. The lightbox could be opened from the keyboard and not closed. | High | new `src/hooks/useDialog.ts`, 5 components | `1762ded` |
| **A-2** | **Thirty-eight form fields had a visible label attached to nothing** — 39 of 40 `<label>` elements had no `htmlFor` and 43 of 45 fields no `id`. Includes guest sign-in, which is the first thing every guest touches, and host sign-in. A placeholder is not a label: it vanishes on the first keystroke, and several screen readers never announce it. | High | 8 components | `1762ded` |
| **A-3** | Around twenty icon-only controls announced as "button" and nothing more: every close button, the like and comment counts (a bare number), the projector's arrows and thumbnails, the moderation and disposable-mode toggles, the ingest copy and revoke buttons. The two toggles also never said whether they were on. | Medium | 9 components | `1762ded` |
| **A-4** | `<html lang="bg">` is hardcoded in `index.html` and the language switcher never touched it, so with the app in English a screen reader read English words with Bulgarian pronunciation rules. | Medium | `src/i18n/index.ts` | `1762ded` |
| **A-5** | `prefers-reduced-motion` was honoured on the projector wall only — the one screen nobody holds. Every guest-facing fade, slide and pulse ignored it. For someone with vestibular sensitivity that is not a preference. | Medium | `src/index.css` | `1762ded` |
| **A-6** | One close button carried a hardcoded `aria-label="Close"` while the rest of the app ran in Bulgarian, and the test for it asked for the English word — so the test agreed with the bug. | Low | `GuestOnboardingModal`, its spec | `1762ded` |

**Not findings, recorded so they are not re-reported.** All 23 `<img>` elements
have alt text; the four a source scan flagged were the characters `<img` inside
code comments. All 37 uses of `focus:outline-none` pair with a visible focus
style. The app has a `<main>` landmark. Two toggles — public showcase and TV
leaderboard — already carried `aria-label` and `aria-pressed`, which is where
the pattern the others now follow came from.

### The browser pass (2026-09-22)

The list above was produced in jsdom, which has no layout and no pixels. Run
again in a real browser at desktop and 375px, with axe over the guest album,
the TV wall, the host sign-in and every dashboard tab, it produced seven more
findings, all fixed in `42f4aff`.

| ID | Finding | Severity | Fixed |
|---|---|---|---|
| **A-7** | `index.html` carried `maximum-scale=1.0, user-scalable=no`, so **pinch-zoom was disabled on every page** (WCAG 1.4.4). On an album read one-handed in a dark room, that blocked exactly the guest who needed to zoom into a face. | High | `42f4aff` |
| **A-8** | The host studio had **no `h1` at all**, on the sign-in page or the dashboard. | Medium | `42f4aff` |
| **A-9** | Heading levels were chosen for size, not structure: the guest feed jumped from the album's `h1` to `h4` for every photo card, and the TV wall and dashboard panels did the same. Each photo card is now an `h2` a screen reader can move between; dashboard panels are `h2` with `h3` sections. | Medium | `42f4aff` |
| **A-10** | The QR code was an `<svg role="img">` with no title — the one thing on the TV wall a guest is meant to act on, announcing nothing. | Medium | `42f4aff` |
| **A-11** | Three fields in the QR print studio still had labels attached to nothing. That tab was missed in the source pass because its markup nests the field two levels below its label. | Medium | `42f4aff` |
| **A-12** | The printed poster's smallest line was `#8C847E` on cream — **3.55:1 at 10px**, against the 4.5:1 it needs. This is the line a guest reads off a table card. Darkened to `#6F6862` (5.3:1). | Medium | `42f4aff` |
| **A-13** | The phone's bottom bar — the main navigation on a phone — was a bare `div` outside every landmark, so skipping by landmark never reached it. | Medium | `42f4aff` |

**What the browser confirmed rather than found**, which is worth as much:
contrast passes everywhere else, including 91 elements at the stricter AAA
threshold; **all 78 touch targets meet the 24px minimum**, so the 36px
suspicion recorded above was wrong; and the dialog roles and field labels from
the source pass do work in a real browser, with `<html lang>` following the
language switch.

**Still open, and still needs a person:** a pass with an actual screen reader,
and keyboard order through a whole page under a real user's hands rather than
a rule. Everything a tool can decide is now decided, at two viewports.
*2026-10-15:* the keyboard order was walked through the album page, the
lightbox, the camera, the sign-in page and every studio section, and what each
control is announced as was read from the accessibility tree (§3j, nine
findings). Listening with an actual screen reader still needs a person.

**How to re-run it:** start the API and Vite (`npm run server`, `npm run dev`),
then in the browser inject `/node_modules/axe-core/axe.min.js` and call
`axe.run(document, { rules: { 'target-size': { enabled: true } } })`. The dev
server serves the package directly, so nothing needs building or vendoring.

---

## 3e. The Performance Pass (2026-09-22 to 23)

Performance had never been measured: no bundle budget checked, no Lighthouse
run, no Core Web Vitals number, for an app whose entire use is a phone on a
venue's Wi-Fi during a party. Measuring it produced four findings, and the
worst of them was not about speed.

| ID | Finding | Severity | Fixed |
|---|---|---|---|
| **N-30** | **Every guest's name was sent to a third party.** A guest without a selfie was given `https://api.dicebear.com/7.x/micah/svg?seed=<their name>`, requested from every device rendering the feed. Both the client and `POST /api/guests` wrote it into the guest's row, so the name also sat in Postgres, went out over the socket to every other guest, and travelled in the album export. Found by reading the network panel during the performance trace, not by looking for it. | High (privacy) | `f98028b` |
| **N-31** | A guest downloaded the whole application to look at photographs: one 600 kB chunk (160 kB gzipped) containing the host dashboard, QR print studio, moderation queue, projector wall, photographer's portal, pricing table and landing page — none of which a guest can open. Over the 150 kB budget in `rules/ecc/web/performance.md`. | Medium | `6721d47` |
| **N-32** | The hero cover image is the largest contentful paint and was discoverable only after the bundle parsed and the event loaded: 1.6s of a 3.2s LCP was the browser not yet knowing it existed. It also carried the album title as alt text while sitting blurred at 35% opacity behind that same title. | Medium | `6721d47` |
| **N-33** | The projector wall hotlinked flaticon.com for the icon in the middle of its QR code — an external request held open all evening on the venue's Wi-Fi, and one that tells flaticon where the wedding is. The print studio had replaced the same hotlink with inline data URIs when it broke PNG export; the wall kept it. | Low | `330e17f` |

**Numbers, measured on Slow 4G with 4x CPU throttling** (a phone at a
reception, not a laptop on a desk), against the production build:

- Main chunk **600.30 kB → 406.22 kB**, gzip **159.73 → 118.81 kB**.
- CLS 0.00 throughout.
- LCP **3.2s**, essentially unchanged by the above: what remains is a serial
  chain — document, then the bundle, then `GET /api/events/slug/:slug`, then
  the cover image. Cutting it further means overlapping the API round trip
  with the bundle's parse, or rendering something before the event arrives.
  **Still open.** *Closed 2026-10-15 (§3j), from the other end:* the bundle
  was crossing the wire uncompressed (N-134), and the page waited for four
  more requests made one after another (N-136).

**Also found and not yet acted on:** two lazily-split chunks
(`HostEventsList`, `PricingPlansModal`) are still requested on the guest page
because they are mounted unconditionally with an `isOpen` prop rather than
rendered only when open. The parse cost is gone; the request is not.
*Fixed 2026-10-15 in `664f80a`:* both mount only while open.

The camera was rewritten in the same stretch (`e24c2cf`) — full-screen
viewfinder, a shutter that freezes the frame before encoding rather than
after, and burst shooting. That was a product change the owner asked for, not
an audit finding, but the cause was the same shape: `canvas.toDataURL` at full
sensor resolution, synchronously, on the main thread, before anything was
drawn.

---

## 3f. The Security Review, Three Domains of Eight (2026-09-25 to 26)

**All 25 fixed** (N-34 to N-58).

Eight reviewers were each given one domain and told to hunt for what earlier
passes miss: races, transaction boundaries, one route missing a check its
siblings have, error paths that leave the database and storage disagreeing,
and features that interact badly. Each reviewer was followed by a second
agent whose job was to refute every finding against the code. The weekly
usage limit stopped the run after three domains — **billing, lifecycle and
auth**. Twenty-five findings came back. None was refuted: 23 confirmed, 2
plausible (N-50 and N-58, where the path is real but the input that triggers
it is uncommon). The results sat in the workflow's output file for eight days
and were written here on 2026-10-04. Numbered N-34 onwards.

**Not yet reviewed:** media, infra, db, guest-ui and host-ui.

What the shape of them says: **six are earlier fixes that closed one route and
left its sibling open.** H7 stopped the self-service downgrade from leaving a
customer paying, but the dunning path (N-35) and a transient Stripe error
(N-42) still do it. SEC-07 gated disposable-mode leaks in `GET /api/audio`
but not the showcase feed (N-36) or the audio upload broadcast (N-37). H9
re-checks a host's socket on AUTH but not on room join (N-38). H8 stopped
guest-row minting on comments and quests but not on audio (N-57). When a
finding names one route, the fix needs to cover every route that does the
same thing.

Severity is the verifier's, which sometimes differs from the reviewer's.
Line numbers are left out on purpose: at least one verifier quoted the wrong
range for a function it had correctly identified.

| ID | Finding | Severity | Files | Review ID | Fixed |
|---|---|---|---|---|---|
| **N-34** | **An album's expiry date moves forward every night, so retention can never act.** `refreshExpiryDates` recomputes each album's expiry from its tier and then floors it at now + 30 days, the H7 grace floor. `retention-sweep` calls it for every album, every night, before it sweeps. Any album within 30 days of expiry, or already past it, is pushed back to about now + 30 days. No notice ever falls due (that needs < now + 14 days), no album ever passes grace (that needs < now − 30 days), and the expiry the host sees is always a month away. This happens whether or not `RETENTION_ENFORCED` is set, so resolving D1 would change nothing. | High | `server/lib/retention.ts`, `scripts/retention-sweep.ts` | lifecycle-1 | `c0846e9` |
| **N-35** | **A dunning downgrade cannot be undone, and the customer keeps paying.** The grace sweep, the expired `past_due` branch and `unpaid` (treated as ended) all call `applyTierDowngradeToFree`. That sets the tier to free and clears `stripe_subscription_id` without asking Stripe whether the subscription is still live. A payment that recovers later grants nothing, because `invoice.paid` finds nothing to refresh, and Stripe keeps charging. With the id cleared, checkout will also open a second subscription. This is the H7 outcome by a route H7 did not cover. It needs `GRACE_ENFORCED=true`, and the 7-day grace is shorter than Stripe's retry window of about two weeks. | High | `server/routes/billingWebhook.ts`, `server/lib/subscriptionUpgrade.ts`, `scripts/subscription-grace-sweep.ts` | billing-1 | `e70c78f` |
| **N-36** | **The public showcase serves disposable-locked photos before the reveal.** Its preview query filters on status only. A disposable-mode upload is stored as `approved` with `is_locked` set, so on any public album the four newest locked photos go out with their captions and, on R2, working quarantine URLs. This is the showcase half of SEC-07, which was fixed for audio only. | Medium | `server/routes/events/crud.ts` | lifecycle-2 | `63e6d61` |
| **N-37** | Voice messages reach every guest live during a disposable-mode lock. The SEC-07 fix gated `GET /api/audio`, but `POST` still broadcasts each new recording to the room. | Medium | `server/routes/audio.ts` | auth-4 | `49e5f08` |
| **N-38** | A WebSocket opened before logout keeps host privileges. The session token is re-checked only when an AUTH frame arrives, `JOIN_EVENT_ROOM` reuses the stale identity, logout never touches open sockets, and the client sends AUTH only on open. A signed-out tab keeps receiving host broadcasts, including pending photos with preview tokens. This is H9, incomplete. *Fixed for one process:* logout closes the user's open sockets, and a room join re-checks the session. With several server instances, a socket held by another instance loses host privileges at its next join rather than at logout. | Medium | `server/ws/wsServer.ts`, `src/services/realtimeSocket.ts` | auth-2 | `36d9f55` |
| **N-39** | Revoking an ingest key does not end an FTP session that is already logged in, and FTP sessions never time out. The key is checked at login only, every later `STOR` ingests without re-checking it, and `FtpSrv` is built with no timeout (the library's default is 0). | Medium | `server/ftp/ftpServer.ts` | auth-3 | `3f98b0c` |
| **N-40** | The published demo host credential controls the only public showcase album, and that album accepts unmoderated anonymous uploads. Whatever anyone uploads there can appear on the landing page. | Medium | `database/migrations/022_event_public_showcase_optin.sql`, `database/migrations/002_seed_data.sql` | auth-5 | `07b4336` |
| **N-41** | Login's fallback for a host with no albums creates one without the DB-06 lock or the event-limit check that `POST /api/events` uses. Concurrent logins each create an album on the paid tier, each with its own allowance. | Medium | `server/routes/auth.ts` | auth-1 | `71cee77` |
| **N-42** | The H7 guard fails open on any Stripe error, not only a missing subscription. A timeout, 429 or 5xx while the host clicks "downgrade to free" skips the guard. The tier drops to free while the subscription keeps billing, and renewals then refresh nothing. | Medium | `server/lib/stripe.ts`, `server/routes/subscriptions.ts` | billing-7 | `ce8815e` |
| **N-43** | When any of a user's subscriptions ends, the account is downgraded, even if another subscription on file is still live. The `deleted` and `past_due` handlers never compare the event's subscription id with the stored one. Two subscriptions arise from N-35's cleared id, or from two checkouts opened in parallel. | Medium | `server/routes/billingWebhook.ts` | billing-2 | `01fbebb` |
| **N-44** | Webhook handlers act on each event's snapshot. They never check `event.created` or re-read the subscription, and Stripe does not guarantee delivery order. A redelivered `past_due` after recovery stamps a new 7-day deadline on a paid-up account. A `checkout.session.completed` processed after `deleted` attaches Pro to a cancelled subscription permanently. | Medium | `server/routes/billingWebhook.ts` | billing-3 | `eb28e21` |
| **N-45** | Upgrading from a one-time pass to Pro Planner and later cancelling loses the pass. The grant overwrites the single subscriptions row, nothing records the earlier purchase, and when the subscription ends the account drops to free. | Medium | `server/routes/billing.ts`, `server/lib/subscriptionUpgrade.ts` | billing-4 | `14c9987` |
| **N-46** | After any downgrade, photos waiting for moderation are stranded. The moderation queue is the only screen that can approve a photo, and it locks below Celebration Pass. The pending photos still count against the free tier's cap. | Medium | `src/components/host/HostDashboard.tsx`, `server/middleware/tierGate.ts` | billing-6 | `17342ec` |
| **N-47** | Deleting an album takes a snapshot of its media, deletes the files one by one, then deletes the rows, and nothing stops uploads, FTP ingests or promotions in between. A photo that arrives mid-purge loses its row but keeps its file. On R2 the file stays publicly reachable. Locally it stays under the served `/uploads`, because the directory removal ignores `ENOTEMPTY`. | Medium | `server/lib/retention.ts`, `server/routes/events/crud.ts`, `server/lib/storage.ts` | lifecycle-4 | `47aa6eb` |
| **N-48** | The ZIP export takes a snapshot of every photo's path at the start and silently skips any photo whose file moves during the download (approved, withheld or revealed). The archive still finishes as if it were complete. | Medium | `server/routes/events/export.ts` | lifecycle-5 | `ea9c79f` |
| **N-49** | On local storage, `storage:orphans` reads the event list before walking the directories and has no age guard. `--delete` can therefore remove an album created in the seconds between. The R2 branch and `storage-orphan-sweep` both avoid this. | Medium | `scripts/storage-orphans.ts` | lifecycle-6 | `6151298` |
| **N-50** | *Plausible.* Postgres matches event ids regardless of case, but storage paths keep the caller's casing, and the orphan sweeps and the export compare them case-sensitively. An upload with an uppercase event id would have its live photos classed as orphans. No first-party client sends one; a third-party tool or a hand-typed id would. | Medium | `server/routes/photos/upload.ts`, `server/routes/ingest.ts`, `scripts/storage-orphan-sweep.ts`, `scripts/storage-orphans.ts`, `server/lib/storage.ts` | lifecycle-3 | `762adf4` |
| **N-51** | One click on the Free plan card forfeits a paid one-time pass. There is no confirmation, and the click fires confetti. | Low | `src/components/host/PricingPlansModal.tsx`, `server/routes/subscriptions.ts` | billing-5 | `efba479` |
| **N-52** | Pro Planner's pooled storage cap is checked under a per-event lock. Concurrent uploads to different albums of one host all see the same total and all pass. The overshoot is limited to the uploads in flight at once. | Low | `server/lib/photoWrite.ts`, `server/middleware/tierGate.ts` | billing-8 | `b673e90` |
| **N-53** | The pricing page sells custom palettes as a Deluxe Keepsake feature (`plan.deluxe.f4`), but they unlock at Celebration Pass. | Low | `src/i18n/translations/en.ts`, `src/i18n/translations/bg.ts` | billing-9 | `aebf7ed` |
| **N-54** | After checkout, the banner says "Your plan is now active" before the webhook has granted the plan, and the tier is refetched at most once. For delayed payment methods such as SEPA, the banner stays wrong. | Low | `src/App.tsx` | billing-10 | `72da0d4` |
| **N-55** | A quest retake moves the guest's tie-break time later, so the guest who reached the top score first can lose the prize to someone who finished after them. | Low | `server/routes/photos/upload.ts`, `server/lib/questLeaderboard.ts` | lifecycle-7 | `3cad956` |
| **N-56** | A 0-point quest is stored as 10 points (`points \|\| 10`). Only a direct API call can send 0; the host UI clamps the input to 5–100. | Low | `server/routes/quests.ts` | lifecycle-8 | `5b2fa5d` |
| **N-57** | `POST /api/audio` still creates a new guest row on every unproven request, with no per-IP backstop limit. This is H8's residual; its scope did not include audio. | Low | `server/routes/audio.ts` | auth-6 | `656fed0` |
| **N-58** | *Plausible.* Another host can claim a deleted album's custom slug immediately, so old QR codes send guests, and their uploads, to a stranger's album. Arguably a policy question rather than a defect. | Low | `server/routes/events/crud.ts` | lifecycle-9 | `f19f8ca` |

**Checked and found sound, recorded so it is not re-reported:** webhook
signature verification (the raw body is mounted before `express.json`, and a
missing secret answers 503); webhook idempotency (claim and dispatch share one
transaction); price authority (the client names only a tier, and the webhook
cross-checks the Price); the redirect allow-list; the no-lowering upsert from
N-15; the per-event photo-count lock; and a server-side gate on every
`FEATURE_GATES` item except `live_tv`, which is presentation-only by design.

**Review of these fixes (2026-10-05).** Four reviewers read the 52 fix
commits by area — billing, media lifecycle, auth and ingest security, client —
and every finding was checked against the code before anything changed. The
review found one regression the fixes introduced and a dozen smaller gaps;
all of them are fixed:

| Commit | What the review found |
|---|---|
| `e67ea06` | **Regression from N-54:** the post-checkout poll went through `loadEventBySlug`, so the app showed its full-screen spinner every 3 s and moved the host to the guest feed. Also: the delayed banner promised something polling did not do; blocked `sessionStorage` made any paid plan count as arrived. The plan bought now travels on the return URL. |
| `8928f3f` | The downgrade confirmation survived closing the modal; focus stayed behind it; the lapsed-moderation notice told the host to switch off something already off. |
| `dc24dc1` | **Security:** the audio route let a guest claim the reserved `photographer` device and, before the first FTP upload, a token for the photographer's row. The device is now read from the header the limiter uses, after the plan's pre-check; FTP refuses `APPE`/`STOU`. |
| `94e7707` | The grace sweep could suspend an account that paid after it made its list; a lapse record outlived a new subscription; choosing Free kept the remembered pass; checkout refused one-time passes when Stripe was unreachable. |
| `7a5f17c` | An album saving its own address could be renamed by a reservation; a crash left the deletion mark blocking uploads; the export dropped rows outside the album's folder without saying so; the export's disk fallback ignored id case. |

**Left as they are, deliberately:** `amount_paid_cents` written as 0 by some
monthly writes (write-only audit data, M-5); a socket held by another server
instance keeps host privileges until its next room join, and an open socket
outlives its JWT's expiry (both pre-date this work; one instance today); a
revoked FTP key still lands the one file in flight before the session closes,
which is then deleted; a demo visitor logging out ends other demo visitors'
sockets as it already ended their HTTP sessions; the N-34 floor gives a
downgrade at most the deadline the album already had, not a fresh 30 days.

**A workspace incident during the run.** On 2026-09-25 `OPEN_ITEMS.md`,
`MASTER_AUDIT.md` and `FIX_PLAN.md` were each cut to their first 50 lines
within 4 ms of each other, while every reviewer was read-only. The likely
cause is the ruflo-core `post-command` hook. On Windows it passes the Bash
command text to `cmd.exe` with `shell: true`, which re-tokenizes it, and a
read like `sed -n 1,50p … OPEN_ITEMS.md MASTER_AUDIT.md FIX_PLAN.md` can be
turned into an in-place edit. The files were restored from git. After any
agent session that reads these documents, check `git diff --stat` before
trusting them.

---

## 3g. The Remaining Five Domains (2026-10-05)

**All 36 fixed.**

The rest of the review §3f began: media, infra, db, guest UI and host UI, one
reviewer each, with the same brief — races, missing checks, inconsistent
state, contract mismatches — and the audit docs to skip what was already
known. Thirty-three findings, numbered N-59 onwards. *Verified* means the
finding has been checked against the code here, not only reported; every
finding is verified again before it is fixed.

Two of them are regressions from §3f's own fixes, which is worth saying first:
N-59 is a consequence of N-57 (the audio route now asks for a device, and the
offline queue's replay never sent one), and N-62 is made worse by N-58 (a
reserved address is swapped for a variant the client never hears about). Both
are the same lesson as §3f's review: a fix on the server is only half a fix
until every client path that calls it has been read.

| ID | Finding | Severity | Files | Verified | Fixed |
|---|---|---|---|---|---|
| **N-59** | **An offline voice message is refused on replay and then deleted.** Since N-57, `POST /api/audio` needs a guest token or the `x-device-fingerprint` header; the offline queue's replay sends neither, gets 401, and drops the recording after five tries. | High | `src/services/offlineQueueService.ts` | Yes | `e8b29af` |
| **N-60** | **A flapping venue Wi-Fi deletes queued photos.** A network error counts toward the five-retry limit exactly like a server refusal, and the item is then removed with only a console warning. | High | `src/services/offlineQueueService.ts` | Yes | `e8b29af` |
| **N-61** | Queued uploads are never flushed when the app starts — only on an `online` event or the next enqueue — and a stalled request with no timeout blocks every later flush until reload. | High | `src/services/offlineQueueService.ts`, `src/services/storageService.ts` | Yes | `e8b29af` |
| **N-62** | **The server renames an album's address and the dashboard never learns it.** A taken or reserved slug is stored as a variant, but `updateEvent` discards the PUT response, so the QR studio, projector and PDFs keep the requested address — someone else's album, or nothing. The slug field also commits every pause in typing as a separate permanent rename. | High | `src/services/eventService.ts`, `server/routes/events/crud.ts` | Yes | `972542b` |
| **N-63** | The photographer upload route buffers up to 10 files of 50 MB in memory before it checks the ingest key, with only a device-keyed limiter whose key the caller chooses. A few parallel unauthenticated requests can exhaust the heap. | High | `server/routes/ingest.ts` | Yes | `586753e` |
| **N-64** | A retention notice is stamped once and never cleared when the deadline later moves. An album warned, then extended by a purchase, then lapsed again is deletable with no warning about the new deadline. Latent while `RETENTION_ENFORCED` is off. | High | `server/lib/retention.ts`, `server/lib/retentionNotice.ts` | Yes | `cbb0d89` |
| **N-65** | The 40-megapixel decode cap added for guest phones also applies to photographer ingest: a 45–61 MP frame from a professional body is reported as "not an image" and, over FTP, deleted after the camera was told it arrived. | Medium-High | `server/lib/images.ts`, `server/lib/ingestPipeline.ts` | Yes | `22a288d` |
| **N-66** | Graceful shutdown never reaches the WebSocket close or `pool.end()` while any socket is open — `server.close()` waits for upgraded sockets — so every deploy ends at the 8-second hard exit. H-3, incomplete. | Medium | `server/index.ts` | Yes | `e2f8e5e` |
| **N-67** | A photo approved from the moderation queue never appears in guests' feeds live: approval broadcasts only `{photoId, status}`, and guests never held the photo. | Medium | `server/routes/photos/moderation.ts`, `src/services/realtimeMessages.ts` | Yes | `aa620e6` |
| **N-68** | Nothing re-syncs after a WebSocket reconnect, so photos added, approved or deleted during a drop never reach the guest or the projector wall until a reload; reconnect backoff has no jitter. | Medium | `src/services/realtimeSocket.ts` | Yes | `bfa49bc` |
| **N-69** | `docker-compose.yml` does not persist the quarantine directory: pending and reveal-locked originals live in the container's writable layer and are lost on any recreate (local storage). | Medium | `docker-compose.yml` | Yes | `cff659d` |
| **N-70** | Promote and withhold move three files in one `Promise.all` and update the row only if all succeed; a partial failure leaves a source missing that every retry then fails on, permanently. | Medium | `server/lib/photoQuarantine.ts` | Yes | `c38269d` |
| **N-71** | A rejection that races an in-flight promotion can leave a photo marked rejected with its files public. | Medium | `server/lib/photoQuarantine.ts`, `server/routes/photos/moderation.ts` | Yes | `4a65521` |
| **N-72** | The guest feed can return approved photos with still-quarantined URLs when the reveal promotion is running elsewhere or failed for one photo. | Medium | `server/routes/photos/feed.ts` | Yes | `93b1175` |
| **N-73** | The retention sweep purges without the N-47 deletion mark, so an upload mid-purge loses its row and keeps its file; and the mark's one-hour staleness can expire during a very large purge. N-47, incomplete. | Medium | `server/lib/retention.ts` | Yes | `e38d95b` |
| **N-74** | The retention sweep works from a candidate list read once; an album extended after the list was made can still be purged. | Medium | `server/lib/retention.ts` | Yes | `e38d95b` |
| **N-75** | A photographer batch upload reports failure on the first bad file while the other files keep uploading in the background; a retry of the batch duplicates them on the wall. | Medium | `src/api/ingestApi.ts`, `src/components/ingest/PhotographerIngestPortal.tsx` | Yes | `37fe996` |
| **N-76** | Host sign-in and registration errors are always English: the server's message always wins over the translated fallback. | Medium | `src/services/authService.ts`, `src/components/host/HostAuthPage.tsx` | Yes | `1252213` |
| **N-77** | The landing showcase fills any missing field of a real opted-in album from the sample weddings — a new album with no photos shows someone else's stock photos and invented counts. | Medium | `src/components/home/PublicWeddingsShowcase.tsx` | Yes | `7b3c4d1` |
| **N-78** | An offline replay is not idempotent: a server that committed an upload whose response was lost receives it again and stores a duplicate. | Medium | `src/services/offlineQueueService.ts`, `server/routes/photos/upload.ts` | Yes | `8768de4` |
| **N-79** | The preview stream is piped with no error handler and is not destroyed when the client disconnects: a storage error can crash the process, and an abort leaks the R2 socket or file handle. | Medium | `server/routes/photos/feed.ts` | Yes | `de2cde2` |
| **N-80** | The microphone stays live if `MediaRecorder` throws after permission was granted. | Low | `src/components/audio/AudioGuestbook.tsx` | Yes | `3448753` |
| **N-81** | A host who signs in while the page's socket is already open stays a guest on it: `joinEventRoom` never re-sends AUTH. | Low | `src/services/realtimeSocket.ts` | Yes | `115ce7b` |
| **N-82** | A database error during the WebSocket host check caches "not host" for 60 seconds. | Low | `server/ws/wsServer.ts` | Yes | `5ce1d30` |
| **N-83** | The production image installs an unpinned `tsx` at build time, and CI never builds the image. | Low | `Dockerfile`, `.github/workflows/ci.yml` | Yes | `e6332fe` |
| **N-84** | The per-guest photo cap is checked only outside the upload lock, so parallel uploads from one device can exceed it. | Low | `server/routes/photos/upload.ts`, `server/lib/photoWrite.ts` | Yes | `6312afb` |
| **N-85** | Deleting one photo can half-delete it on a storage error, or orphan files a concurrent promotion just moved. | Low | `server/routes/photos/moderation.ts` | Yes | `f1a8bd2` |
| **N-86** | A voice message whose insert fails for any reason other than quota or a missing album leaves its file in storage. | Low | `server/routes/audio.ts` | Yes | `4bf3586` |
| **N-87** | A 101–120 character custom address passes validation and fails at the 100-character column with a 500; a 95–100 character one that needs a variant overflows the same way. | Low | `server/routes/events/shared.ts`, `server/routes/events/crud.ts` | Yes | `0835f37` |
| **N-88** | The feed cursor carries `createdAt` at millisecond precision against microsecond rows, so a photo in the same millisecond can be skipped between pages. | Low | `server/routes/photos/feed.ts` | Yes | `29b102b` |
| **N-89** | `storage-recount` reseeds totals without a lock, so an upload committing during it is undercounted. | Low | `scripts/storage-recount.ts` | Yes | `309c564` |
| **N-90** | A new album defaults to the date `2026-09-18`, already past, and clearing the date field throws. | Low | `src/components/host/HostEventsList.tsx` | Yes | `93c37cd` |
| **N-91** | The projector wall indexes into a list that new photos shift, so the slide changes mid-display and new photos wait a whole cycle; QR studio save failures are swallowed. | Low | `src/components/projector/LiveProjectorScreen.tsx`, `src/services/qrCanvasService.ts` | Yes | `f4a1627` |
| **N-92** | The live `PHOTO_ADDED` broadcast went to the whole room with `originalUrl`: the untouched camera file, EXIF and GPS included, which the REST feed gives to the host only (MED-02). Found while fixing N-67. | High | `server/lib/photoWrite.ts`, `server/ws/wsServer.ts` | Yes | `aa620e6` |
| **N-93** | The N-73 deletion mark could lapse without the purge noticing: a failed renewal was only logged, a mark taken off by something else was renewed into nothing, the rows were deleted without checking the mark was still held, and two deletions of one album shared one mark, each clearing it under the other. Found by the background security review of e38d95b. | Medium | `server/lib/retention.ts`, `server/routes/events/crud.ts` | Yes | `7a4ae79` |
| **N-94** | Three production dependencies had published high or critical advisories, and the CI audit gate was failing on all three: `proxy-addr` 2.0.7 (critical: IP spoofing through an IPv4-mapped IPv6 trust subnet, under Express), `sharp` 0.35.4 (high: librsvg CVE in the decoder every upload goes through), `brace-expansion` 5.0.9 (high: CPU and stack-exhaustion DoS, under archiver). Found while fixing N-83. | High | `package.json`, `package-lock.json` | Yes | `56dbb2d` |

---

## 3h. The Review of the §3g Fixes (2026-10-10)

**All 12 fixed.**

The same four-way review as after §3f, over everything §3g changed
(`4795c58..HEAD` at the time): media and quarantine, album lifecycle and
infrastructure, identity and the realtime server, and the client. No
Critical or High findings. Every finding below was checked against the code
here before it was recorded; several remarks were left out as not defects
(an informational notice shown through the error toast, rename answers
crossing in flight, repeated offline QR save errors).

Most of these are edges of §3g's own fixes: N-95 of N-70, N-96 of N-59 and
N-60, N-97 and N-98 of N-91, N-99 of N-78 and N-84, N-100 and N-101 of N-73
and N-74, N-103 of N-75, N-104 of N-62.

| ID | Finding | Severity | Files | Verified | Fixed |
|---|---|---|---|---|---|
| **N-95** | **Rejecting a photo whose promotion half-failed leaves its moved files public.** Since N-70 a promotion that moves some of a photo's files records them but keeps `is_quarantined` true until all have moved. `withholdPhotoToQuarantine` returns early on that flag, so a rejection or a step back to pending withholds nothing, and the copies already moved stay reachable by URL. | Medium | `server/lib/photoQuarantine.ts` | Yes | `5407b7d` |
| **N-96** | **One upload that always times out blocks the offline queue for good.** The 120-second replay timeout (N-59) is a network error to the queue, which spends no retry and ends the pass (N-60). A voice message too large for a slow link stays first in line and nothing queued behind it is ever sent. | Medium | `src/services/offlineQueueService.ts` | Yes | `a4cada6` |
| **N-97** | The projector pins no slide until its first tick, so a photo arriving before then (on a new wall, the usual case) still swaps the slide on screen, and the arrival is then shown a second time. | Medium | `src/components/projector/LiveProjectorScreen.tsx` | Yes | `0a86f36` |
| **N-98** | The projector picks the slide's Ken Burns pan from its position, so every arriving photo changes the class on the image already showing and restarts its animation mid-slide. | Medium | `src/components/projector/LiveProjectorScreen.tsx` | Yes | `0a86f36` |
| **N-99** | Two copies of one upload arriving together at a full cap or allowance: the second is refused by the locked re-check (N-84) before its insert can meet the duplicate, so the phone is told a stored photo, or voice message, was refused and reports it lost. N-78 covers only a replay that arrives after the first copy is stored. | Low | `server/lib/photoWrite.ts`, `server/routes/photos/upload.ts`, `server/routes/audio.ts` | Yes | `ded71e2` |
| **N-100** | A deletion mark records a time, not an owner. A purge stalled for over an hour has its mark taken over by another deletion, carries on under it, and on failure clears it, reopening uploads under the other deletion's purge. | Low | `server/lib/retention.ts`, `server/routes/events/crud.ts` | Yes | `f183562` |
| **N-101** | An album extended after the retention sweep's last check (N-74) is still purged: nothing re-checks during a purge that can run for an hour, and `refreshExpiryDates` takes no lock. | Low | `server/lib/retention.ts` | Yes | `4c67d32` |
| **N-102** | The voice-message route takes `localId` with no length limit (the photo schema caps it at 100). A long one fails the insert on the unique index with a 500. | Low | `server/routes/audio.ts` | Yes | `21b130b` |
| **N-103** | The photographer portal's "photos sent" count is replaced, not added to, on a retry: after 8 of 10 frames and a retry of the other 2, it says 2 were sent. | Low | `src/components/ingest/PhotographerIngestPortal.tsx` | Yes | `a99b6f3` |
| **N-104** | Since N-62 the album address is saved on leaving the field, but the address bar follows each keystroke: a reload before then opens an address that does not exist. A cleared field is never saved and leaves the field and bar empty. | Low | `src/components/host/dashboard/OverviewTab.tsx`, `src/components/host/HostDashboard.tsx` | Yes | `b75af02` |
| **N-105** | The portal's translated batch-failure message quotes the server's English reason, and the client's own fallbacks ("Network error", "Not a supported image file") are English too. | Low | `src/components/ingest/PhotographerIngestPortal.tsx`, `src/api/ingestApi.ts` | Yes | `a99b6f3` |
| **N-106** | A failed advisory unlock on the reveal promotion's shared connection returns that connection to the pool still holding a photo's move lock; every later approve or delete of that photo then waits for ever. | Low | `server/lib/photoQuarantine.ts` | Yes | `bee1ce3` |

---

## 3i. The Running-App Feature Pass (2026-10-14)

**27 findings (N-133 found while re-checking the fixes): 26 fixed; N-112 kept by the owner's decision (2026-10-16).**

Every review since §3c has read code. This one ran it: the API on local
storage, Vite, Postgres, a desktop host browser, phone-sized guest browsers,
a Chrome with a fake camera and microphone, the TV wall, the photographer
portal, and a real Stripe sandbox checkout paid with the 4242 test card. The
webhook cannot reach localhost, so the purchased tier was applied with
`applyTierUpgrade`, the same function the webhook calls. Each feature was
followed from the screen to the row it wrote and back to a second device.
Numbered N-107 onwards.

The four most serious findings all passed their unit tests, because each one
lives where two parts meet: the onboarding modal and the guest schema, the
camera's error overlay and its review screen, the disposable toggle and the
reveal time nothing sets, and the sign-in response and the dashboard that
reads it. The same lesson as §3b: these were found by using the app, not by
reading it.

| ID | Finding | Severity | Files | Verified | Fixed |
|---|---|---|---|---|---|
| **N-107** | **A guest who adds the optional selfie cannot upload anything.** `GuestOnboardingModal` sends the selfie as a `data:` URL in `avatarUrl`, and `POST /api/guests` caps that field at 1,000 characters, which every image exceeds. The request is refused with 400 and the modal closes silently. The guest stays local only, with an id like `guest-<timestamp>` and no token. Every later action is then refused: a like gets 400 "Invalid photoId or guestId format", and each photo upload gets 400 "guestAvatar … <=500 characters", retried and refused again. Adding a selfie to an existing profile fails the same way, and the picture shows only on the guest's own phone. The cap has been there since the baseline commit. The selfie is offered on the first screen every guest sees. | Critical | `src/components/guest/GuestOnboardingModal.tsx`, `src/services/guestService.ts`, `server/routes/guests.ts`, `server/routes/photos/upload.ts` | Yes | `677fb6f`, `a7cd7da` |
| **N-108** | **With no working camera, a guest cannot send a photo.** If `getUserMedia` fails (permission denied, no camera, or camera in use), an error overlay covers the whole capture modal at `z-30`. Its condition is `!isCaptured`, and `isCaptured` is set only by the live shutter. A photo picked from Gallery or taken with the phone's own camera app reaches the review screen, but the overlay stays on top of it. Send, the filters, the quest picker and the caption cannot be tapped: `elementFromPoint` at the Send button returns the overlay, and a real tap sent nothing. This came in with the camera rewrite, `e24c2cf`. | High | `src/components/camera/CameraCaptureModal.tsx` | Yes | `78adeda` |
| **N-109** | **Disposable camera mode, a Deluxe feature, reveals every photo immediately.** The toggle writes `is_disposable_mode` only. No client code ever sends `revealAt`, so `reveal_at` stays NULL. Uploads are still marked `is_locked`, and the guest is told the photo will be revealed the morning after. But the feed's `disposableLocked` requires `reveal_at`, so `promoteEligiblePhotos` publishes the photo, and the showcase filter (`reveal_at IS NOT NULL`) lets it through too. Verified: after a host approval, a second guest, the TV wall and the public landing showcase all showed the "locked" photo, with `isLocked:false`, while the uploader's card still said it was locked. | High | `src/components/host/dashboard/OverviewTab.tsx`, `server/routes/events/crud.ts`, `server/routes/photos/feed.ts` | Yes | `a16aa09` |
| **N-110** | **After sign-in or registration, the host studio shows the demo wedding's data.** On success, `App.tsx` passes the server's raw snake_case row to `updateEvent`, which merges it over `INITIAL_EVENT` or whatever album was cached. The camelCase fields keep the demo values: Моника и Александър, 18.09.2026 and Резиденция Бояна, София. The login response also omits every settings column. On a fresh device after login, the QR studio poster printed "Моника и Александър / Резиденция Бояна, София • 18 септември 2026 г.". The moderation, public-showcase and disposable toggles all showed off, and the palette showed champagne, while the database had all three on and `rose_blush`. A host is told the album is private while it is on the landing page. The saved QR headline was not loaded either. The same call PUTs the raw row back to the server on every sign-in. The state corrects itself only when something later calls `loadEventBySlug`, such as the post-checkout poll. | High | `src/App.tsx`, `src/services/eventService.ts`, `server/routes/auth.ts` | Yes | `5d68160` |
| **N-111** | **The landing page and pricing modal still sell things that do not exist.** This is H-1 by another route: `PLANS` was corrected, but the landing page has its own copy. (a) The Pro card says "Персонализиран брандинг" / "Custom branding", which is white-label, U-3. (b) The Deluxe card says "Доживотен архив" (lifetime archive), but the plan keeps albums for 1 year. (c) The hero and step 2 promise guests can share "снимки, видео и гласови пожелания", but there is no video upload. (d) "Пълна сигурност и безсрочен архив" (an indefinite archive), and FAQ 4 says the ZIP can be downloaded "at any time after the wedding", but albums expire and the ZIP is a paid feature. (e) FAQ 5 promises a moderator the couple can appoint, such as a кум or шаферка, but only the host account can moderate. (f) The pricing modal's Deluxe card says "Приоритетна облачна обработка през Cloudflare CDN", but no tier changes how photos are processed. | High | `src/i18n/translations/bg.ts`, `src/i18n/translations/en.ts` (`ui.landing_home_page.*`, `landing.*`, `plan.deluxe.f6`) | Yes | `4453935` |
| **N-112** | The landing page shows fabricated social proof: "4.9 / 5 от младоженци в България", "Защо стотици младоженци избират WedMoments?", and six sample weddings labelled "Активен албум" with photo and guest counts, under the heading "Истински спомени от нашите младоженци" (real memories from our couples). | Medium | `src/i18n/translations/*.ts`, `src/components/home/PublicWeddingsShowcase.tsx` | Yes | **Kept by the owner** (2026-10-16): demo content shown to potential clients until real albums can stand in for it; the owner removes it then. Found meanwhile: its 24 photos were hotlinked from images.unsplash.com, which the production CSP refuses, so every demo card was an empty box; they now ship with the app under `public/demo/` (Unsplash License). |
| **N-113** | The lightbox keeps a copy of the photo taken when it opened (`activeLightboxPhoto`). A like, reaction or comment made inside it reaches the server but never re-renders the dialog. A posted comment appears only after the dialog is closed and reopened, which invites duplicate comments. | Medium | `src/App.tsx`, `src/components/gallery/LightboxModal.tsx` | Yes | `4fddeec` |
| **N-114** | The lightbox's Download button builds `<a download>` to `fullUrl`, which is on another origin: `:6501` in development and `r2.dev` in production. The browser ignores `download` across origins, so the guest's tab navigates away from the album to the raw JPEG. It is also the filtered display copy, not the original. | Medium | `src/components/gallery/LightboxModal.tsx` | Yes | `1150655` |
| **N-115** | The "Присъстващи гости" (guests attending) figure counts the guests in the current device's localStorage and is never synced. The host dashboard showed 0 while the server counted 3, as the showcase feed reported. Guests see 0 or 1. | Medium | `src/context/AppContext.tsx`, `src/components/host/dashboard/OverviewTab.tsx`, `src/components/layout/WeddingHero.tsx` | Yes | `fdb91b2` |
| **N-116** | The "My events" switcher, which is the Pro Planner multi-event dashboard, has three problems. `GET /api/events` returns raw rows, and the list reads `hostName`, `eventDate` and `venueName`, so every real album shows only its title. The locally cached event is added to the list even when the host does not own it; the demo album was shown as "Активна". And choosing an album opens the guest view, not the studio, and shows the host the guest-profile prompt. | Medium | `src/components/host/HostEventsList.tsx`, `src/App.tsx` | Yes | `6cb05c8` |
| **N-117** | With no saved QR config, the server returns English defaults: "Capture the Love" and "Scan the QR code…". The client uses those in place of its translated defaults, so every Bulgarian poster printed English text, as the exported PNG showed. The INSERT's `COALESCE` default and the migration 001 column default are English too. | Medium | `server/routes/events/qr.ts`, `database/migrations/001_initial_schema.sql`, `src/components/host/QRCanvasStudio.tsx` | Yes | `a764223` |
| **N-118** | The QR studio's "Публичен домейн" target is hardcoded to `https://wedmoments.app` and is not read from configuration. Its "Локална Wi-Fi мрежа" option is `window.location.origin`, which in production is the real public domain. | Medium | `src/components/host/QRCanvasStudio.tsx`, `src/components/projector/LiveProjectorScreen.tsx` | Yes | `f5a5122` |
| **N-119** | "Нулирай" (reset local data), in the ZIP tab, clears localStorage. The signed-in host's studio then shows the demo album (`monika-and-alexander-2026`) as theirs, and every edit fails with "Forbidden: You do not own this event", shown in English inside the Bulgarian toast. | Medium | `src/services/storageSyncService.ts`, `src/components/host/HostDashboard.tsx` | Yes | `6cb05c8` |
| **N-120** | After an album is deleted, `active_event_id` still points at it, and "Студио за младоженци" opens the deleted album from the local cache. | Medium | `src/components/host/dashboard/OverviewTab.tsx`, `src/services/eventService.ts` | Yes | `6cb05c8` |
| **N-121** | Rejected photos disappear from every host screen: they are in neither the queue nor the gallery. The host cannot restore or delete them. They stay in storage, and the ZIP includes them with pending photos ("Всички 4 снимки" exported two rejected photos). | Medium | `src/components/host/ModerationQueue.tsx`, `server/routes/events/export.ts` | Yes | `fcd011f` |
| **N-122** | There is no way to reset or change a password, and no way to delete an account. `authRouter` has only `/register`, `/login`, `/me` and `/logout`. A paying host who forgets their password loses the album. | Medium | `server/routes/authAccount.ts`, `src/components/host/AccountSecurity.tsx` | Yes | `99eeed2` (password change and account deletion, with a live plan cancelled at Stripe first). Email reset waits for mail; meanwhile `npm run admin:reset-password -- <email>` |
| **N-123** | Free albums are seeded with five quests that guests can see and complete, because uploads record completions on any tier. But the host's quest tab is locked, so the host cannot delete them, and the leaderboard returns 403. | Low | `server/routes/auth.ts`, `server/routes/photos/upload.ts` | Yes | `5b4c67c` |
| **N-124** | Camera errors other than a denied permission show the browser's raw English message, for example "Requested device not found". A missing microphone is reported as a denied permission. The voice guestbook's re-record button says "Снимай отново", which is photo wording. | Low | `src/components/camera/CameraCaptureModal.tsx`, `src/components/audio/AudioGuestbook.tsx` | Yes | `7d20328` |
| **N-125** | English or untranslated text remains in the Bulgarian app. The default album title is "`<name>`'s Wedding". The "Photographer Ingest" tab label appears twice. The fallback guest name is "Guest". The portal says "N image(s) selected", which N-105 said was localized, and the default photographer name is "Official Photographer". Tier refusals embed raw ids ("изисква план \"celebration_pass\""). Event-save failure toasts show the server's English text. In EN mode the date placeholders stay "ДД.ММ.ГГГГ" and "ЧЧ:ММ". Ingest-key dates use the US format ("10/14/2026"). Album dates render as "13 Ноември 2026 Г.", with a capital month and "Г.". | Low | `server/routes/auth.ts`, `src/components/host/dashboard/TabNav.tsx`, `src/App.tsx`, `src/components/ingest/PhotographerIngestPortal.tsx`, `server/middleware/tierGate.ts`, `src/services/eventService.ts` | Yes | `cf89b4b` |
| **N-126** | A photo picked from the gallery gets the "Златен блясък" (golden glow) filter by default (`useState('golden_glow')`), so a guest's own picture is tinted unless they choose "Оригинал". | Low | `src/components/camera/CameraCaptureModal.tsx` | Yes | `10702a4` |
| **N-127** | A first-time visitor to `/e/<slug>` first fetches the demo album's photos, quests, audio and QR config (`a0eebc99…`) before the slug resolves. | Low | `src/services/defaultEvent.ts`, `src/context/AppContext.tsx` | Yes | `d0059e9` |
| **N-128** | After a quest photo is rejected, the quest still lists the guest as having completed it, both in the guest's tick and in the host's "1 завършено", while the leaderboard correctly gives 0 points. Moderation cards do not say which quest a photo was entered for. | Low | `server/routes/quests.ts`, `src/components/host/ModerationQueue.tsx` | Yes | `86601f2` |
| **N-129** | The photographer portal says "Изпратени към живия екран: 2" (sent to the live screen) while the photos wait in moderation. The ingest tab shows operator instructions to couples: `npm run ingest:watch` and the `FTP_ENABLED`, `FTP_PASV_URL` and `FTP_TLS_*` variables, with the FTP block shown while FTP is off. Revoking a key asks for no confirmation. | Low | `src/components/ingest/PhotographerIngestPortal.tsx`, `src/components/host/dashboard/*` | Yes | `c8e5571` |
| **N-130** | The PNG sold as "300 dpi" carries a 72 dpi `pHYs` tag, so print software opens it at 1.75 m wide. It is 4960×7022 px, against 4961×7016 for A2 at 300 dpi. The PDF is exact: 1190.55×1683.78 pt. | Low | `src/services/qrCanvasService.ts` | Yes | `abe7a4b` |
| **N-131** | An album without a cover hotlinks `images.unsplash.com` from every guest's device. `normalizeEvent` defaults to it, and new albums store an Unsplash URL. This is a third-party request, like N-33. | Low | `src/services/eventNormalization.ts`, `src/components/host/HostEventsList.tsx` | Yes | `843d04c` |
| **N-132** | Smaller problems found on the way. Registration refusals say only "check your data", not that the password is under 6 characters. "Създай безплатен сватбен албум" opens the sign-in tab. Plan names differ between the landing page and the pricing modal (Безплатен старт / Безплатен тест, Celebration Pass / Сватбен пропуск "Празник", Pro Planner / Сватбен агент & Диджей). The "My events" overlay is not a dialog: it has no role, Escape does not close it, and its close button has no name, so A-1 missed it. Re-joining after a guest-session reset creates a new guest id, which splits "Моите снимки" and quest progress from the old one. | Low | various | Yes | `e097cf5` |
| **N-133** | Found while re-checking N-108 in the running app. With the camera unavailable, its warning (`z-30`) lay over the viewfinder's own controls (`z-20`): the close button, the filters, the shutter and the gallery shortcut. Its background class, `bg-noir-950/95`, is not in the palette, so the controls stayed visible, but every tap landed on the warning: on a phone with no camera, or with the camera refused, a guest could not close the camera screen. | Medium | `src/components/camera/CameraCaptureModal.tsx` | Yes | `03b3697` |

**Checked and found working, recorded so they are not re-tested:**
registration and login (apart from N-110); Stripe sandbox checkout, the return
banner and the poll that flips it once the tier lands; every server tier gate
probed on a free album (quests, moderation, disposable, palette, export,
leaderboard, QR config, audio), the Deluxe one-album limit, a lower-tier
purchase refused as already included, and the Free downgrade confirmation;
moderation approve, reject and feature; photo delete, removing the row and the
files; likes, reactions and comments, with comment HTML shown as text; quest
create and delete, the prize, the TV leaderboard, and live reactions on the
wall; voice recording, playback and save on a real `MediaRecorder`; the live
camera shutter; the offline queue, which held a photo in IndexedDB and sent it
with 201 on reconnect; the PDF poster at exact A2; QR config persistence; the
ZIP export of originals and audio; ingest key generation and revocation, portal
uploads with the photographer's name, priority and caption, and the translated
refusal for a revoked key; slug rename, transliteration and the variant for a
taken slug; album delete with media purge; guest-session reset, after which
guests get 401 and are asked to join again; and the public showcase opt-in.
`retention:report` and `notify:report` both ran clean. The EN interface is
clean apart from N-125.

**Not covered:** Stripe webhooks against a reachable endpoint (V-1), R2
storage (this run used local storage), FTP from a real camera (V-3), and a
screen reader.

**A note on this run.** At 05:31 a person uploaded one photo of keys through
the visible guest browser window. It was not part of the test. It was rejected
in moderation and removed with the test data. All test accounts used
`@example.com` and were removed with `npm run db:purge-test-data`, which also
deleted their files.

---

## 3j. Follow-up on the Production Build (2026-10-15)

**16 findings, all fixed.** N-139 and N-149 were left to the owner first; on 2026-10-15 the owner asked for the recommended cover feature and a typeface with proper Cyrillic.

The two items §3e and §3d had left open: the album's first paint, and a
keyboard and screen-reader pass. Both were done against the production build
served by Express exactly as the shipped compose runs it (`npm run build`,
then the API serving `dist/`), not against Vite, which is how the first two
findings below had stayed invisible: Vite compresses, and sets no CSP.
Speed was measured on a 390 px phone profile, Slow 4G (562.5 ms, 1.44 Mbit/s)
with 4x CPU throttling, three runs each, against an album of four photos on
R2. The keyboard pass walked every screen with Tab and read what each control
is announced as; axe-core ran on each screen and each studio section, for a
free and for a Deluxe host. Numbered N-134 onwards.

| ID | Finding | Severity | Files | Verified | Fixed |
|---|---|---|---|---|---|
| **N-134** | **The client crossed the wire uncompressed.** The shipped compose publishes the app's port with nothing in front of it, and Express had no compression: the 428 kB main chunk arrived as 418 kB rather than 124 kB, 3.3 s of the 4.8 s before anything was painted. Hashed assets went out with `max-age=0`, so a guest reopening the album asked for every file again. | High | `server/index.ts`, `server/lib/builtClient.ts` | Yes | `b70a230` |
| **N-135** | **The production CSP refused the app's own fonts.** `index.html` loaded Cormorant Garamond and Plus Jakarta Sans from `fonts.googleapis.com`; the CSP allows styles and fonts from `'self'` only, so production never showed them and logged a CSP error on every page. Where no CSP applied (Vite), every guest's phone told Google which album it had opened. Now bundled from `@fontsource`. | Medium | `index.html`, `src/main.tsx` | Yes | `195e904` |
| **N-136** | **The album waited behind four requests made one after another.** The loading screen stayed up until the photos, quests, voice messages and poster layout had all arrived, each asked for only after the one before had answered: four more round trips, about 2.4 s on this profile, after the album's own record had already arrived. A failure in one also skipped every one after it. They now go out together, and the page waits only for the album's own record; the feed says the photos are on their way instead of inviting the guest to take the first one. | Medium | `src/services/storageSyncService.ts`, `src/context/AppContext.tsx`, `src/components/gallery/LiveFeed.tsx` | Yes | `87dd0c9` |
| **N-137** | Before the loading screen, the first render showed the built-in demo album for a frame — another couple's names — and requested its stock cover from `images.unsplash.com`, which the production CSP then refused. | Low | `src/context/AppContext.tsx` | Yes | `87dd0c9` |
| **N-138** | The lock badges showed each plan's pricing-page ribbon where the plan's name belongs: a lock reading "Requires Most popular with couples". On a free album's top section, "Най-предпочитан за младоженци" and "Пълно VIP изживяване" were too long for their tiles at 390 px, spilled over the next tile and pushed the Challenges label off its left edge. | Medium | `src/components/common/LockedFeatureBadge.tsx`, `src/config/plans.ts`, `src/components/layout/WeddingHero.tsx` | Yes | `db03ec3` |
| **N-139** | **No screen sets a cover photo.** The album's top section is designed around one, `PUT /api/events/:id` accepts `coverImageUrl`, but nothing in the studio writes it, and since N-131 no album has a stock one. Every album's top section is the gradient alone. Built as recommended to the owner: an "album cover" card in the studio's settings to upload a photo (the case before the wedding, when the album is empty), choose an album photo guests can already see, or remove it, on every plan. `POST /api/events/:id/cover` stores the server's own display-size copy under the album, so deleting the photo later keeps the cover and a pending or reveal-locked photo cannot leak through it; the general create and update no longer take a cover URL at all. | Low | `server/routes/events/cover.ts`, `src/components/host/dashboard/CoverPhotoField.tsx` | Yes | `98473d3` |
| **N-140** | The dialog focus trap counted controls that are not on screen, such as the camera's file inputs, kept with `display:none`. Tab from the last button a guest could see then fell out of the camera onto the page. | Medium | `src/hooks/useDialog.ts` | Yes | `1ff5a99` |
| **N-141** | The camera announced as "dialog" with no name: the full-screen rewrite (`e24c2cf`) dropped the heading its `aria-labelledby` pointed at. | Medium | `src/components/camera/CameraCaptureModal.tsx` | Yes | `1ff5a99` |
| **N-142** | Tabbing down the feed on a phone left the focused reaction buttons under the fixed bottom bar: focused and out of sight (WCAG 2.4.11). | Medium | `src/index.css` | Yes | `1ff5a99` |
| **N-143** | Every photo was announced as "Wedding moment" — or "Wedding Photo", "Pending review", "Approved", "Thumbnail" — in English whatever the page's language, and the same for every photo. A photo is now named by its caption, or by who took it. | Medium | `src/utils/photoAlt.ts` and its six callers | Yes | `1ff5a99` |
| **N-144** | Reaction buttons were named by their emoji alone, so what a screen reader said depended on its own emoji vocabulary, and nothing said whether the guest had already reacted. | Low | `src/components/gallery/PhotoCard.tsx`, `src/components/gallery/LightboxModal.tsx` | Yes | `1ff5a99` |
| **N-145** | The open studio section, the sign-in / sign-up / demo switch and the album's palette were shown by colour alone. | Medium | `src/components/host/dashboard/TabNav.tsx`, `src/components/host/HostAuthPage.tsx`, `src/components/host/dashboard/OverviewTab.tsx` | Yes | `9498d3e` |
| **N-146** | A failed sign-in appeared on screen and nowhere else: with a screen reader, a wrong password produced silence. | Medium | `src/components/host/HostAuthPage.tsx` | Yes | `9498d3e` |
| **N-147** | axe, in the browser: the lightbox's "no comments yet" line was under the contrast minimum; the lock badge on the studio's selected (gold) section button was gold on gold; and a locked feature's card titled itself h3 straight under the page's h1. | Low | `src/components/gallery/LightboxModal.tsx`, `src/components/common/LockedFeatureBadge.tsx` | Yes | `9498d3e` |
| **N-148** | **A returning visitor saw the album as it was on their last visit.** With the album already in the browser, the page took the record from the cache and never asked for it again. A guest reopening the link saw the old title and names after the host had changed them; a host who had bought a plan elsewhere opened the studio to find every paid section still locked. The same held for the moderation, reveal and disposable settings that decide what a guest's phone does. Found when the studio of a host upgraded for this pass stayed locked. | High | `src/services/storageService.ts`, `src/services/eventService.ts`, `src/context/AppContext.tsx` | Yes | `3f9b82a` |
| **N-149** | **Plus Jakarta Sans has no basic Cyrillic** (`@fontsource` ships latin, latin-ext, cyrillic-ext and vietnamese; Google Fonts the same), so in Bulgarian, the default language, all body text has always been the phone's system font. Only the headings, in Cormorant Garamond, render as designed. The body typeface is now Sofia Sans, by the Bulgarian foundry Lettersoup: full Cyrillic, and with `lang="bg"` the Bulgarian letterforms, as Cormorant Garamond already had; checked in the browser against the same words set with `lang="ru"`. One variable file per script, 25.6 kB for Cyrillic. | Low | `tailwind.config.js`, `src/main.tsx` | Yes | `d8df85b` |

**Numbers**, same profile, production build, median of three:

| | Before | After |
|---|---|---|
| Main chunk on the wire | 418 kB | 124 kB |
| First contentful paint | 4.8 s | 2.8 s |
| Album title on screen | 7.9 s | 3.0 s |
| Largest contentful paint | 8.4 s | 3.9 s |
| First photo on screen | 9.4 s | 4.5 s |
| Third-party requests | 2 (Google Fonts, Unsplash) | 0 |
| Host-only chunks on the guest page | 0 (already fixed in `664f80a`) | 0 |

On a second visit all twelve hashed files now come from the browser cache
without a request. The numbers above are for an album without a cover. Since
N-139 a host can set one; it is stored at display size (1600 px, JPEG) and
requested with `fetchpriority="high"`, but it still waits for the album's
record, so an album with a cover paints it after the title.

**Seen and left as they are:** axe flags the small "Сватбен албум на живо"
line on the QR poster preview for contrast. That is the poster's print
design, chosen per template, not interface text. The font files for the
Latin subsets still download on a Bulgarian page, for the Latin characters
in it ("WedMoments", digits), after the text is shown; since N-149 that is
one variable Sofia Sans file (40 kB) rather than five Plus Jakarta Sans ones.

**Not covered:** listening with an actual screen reader (NVDA, VoiceOver,
TalkBack), which still needs a person; a real phone on a real venue's
Wi-Fi.

---
## 3k. Stripe End to End, a Load Test, and a Third Pass Over the Running App (2026-10-16 to 17)

**15 findings: 13 fixed, 2 waiting on the owner (N-159, N-163).**

Three things the earlier passes had left open. Stripe's paid flow had never
run for real: the webhook had only met mocks, and §3i applied the purchased
plan by hand because Stripe could not reach a local server. The service's
capacity had never been measured past the uplink of the machine running it
(V-4). And the app had been used end to end twice, by people who knew where
to look; this pass looked at what a guest meets when something goes wrong.
Numbered N-150 onwards.

### Stripe in the sandbox (V-1)

The production build, served by Express, with the Stripe CLI (v1.53.1, a
standalone tool on this machine, not a project dependency; its download was
checked against Stripe's published SHA-256) forwarding the sandbox's events to
the local webhook under its own signing secret. Payments were made on Stripe's
real hosted Checkout in a browser, with the 4242 test card. Each step was
followed from the screen to the CLI's delivery log and to the `subscriptions`
row.

| Step | What Stripe sent | What the app did |
|---|---|---|
| Buy Celebration Pass (€49, one-time) | `checkout.session.completed` | Plan applied, €49 recorded, 10 GB, album kept 90 days after the wedding; "payment confirmed" banner on return |
| Buy Pro Planner (€49/month) on top | `invoice.paid`, then `checkout.session.completed` (invoice first) | Plan applied, monthly, customer and subscription ids stored, the pass kept underneath as `one_time_tier`, album retention open-ended |
| Choose a lower plan while subscribed | — | Refused as already included, in Bulgarian |
| Cancel in the billing portal (at period end) | `customer.subscription.updated` | Plan kept until the period ends, as it should be |
| Renewal fails (card 4000 0000 0000 0341 charged) | `invoice.payment_failed`, `customer.subscription.updated` (`past_due`) | Plan kept, 7-day grace set; the failed-invoice event is recorded and needs no handler |
| Card fixed, invoice paid | `invoice.paid`, `customer.subscription.updated` (`active`) | Grace cleared |
| Grace runs out (`npm run grace:sweep`) | — | Falls back to the pass the host owns; Pro Planner parked as `lapsed_tier` |
| Paid late, after the lapse | `invoice.paid`, `customer.subscription.updated` | Pro Planner restored |
| Subscription ended at once | `customer.subscription.deleted` | Falls back to the pass, subscription id cleared, album retention back to the pass's |
| Account deleted from the studio, Stripe customer on file | — | Account and album gone (N-122) |

Every forwarded event was answered 200 and none was retried. One detail for
whoever repeats this: on API version 2026-08-26.dahlia, resetting the billing
anchor with `proration_behavior=none` issued no invoice, so the failed renewal
was forced by a quantity change billed at once. Found on the way: N-152, N-155,
N-156 and N-164. Still not covered: live keys, and Stripe's own customer emails,
which the sandbox does not send.

### Load test (V-4, on this machine)

The image's own command (`tsx server/index.ts`) in production mode, a load
script with no packages beyond the repository's, both on one machine: an
i7-11700 (8 cores, 16 threads), 32 GB, Windows 10, Postgres in Docker Desktop.
Each virtual user sent its own `X-Forwarded-For` address with
`TRUST_PROXY=loopback`, so the per-IP limiter did not stand in for the server,
the way guests at many venues arrive from many NATs. Storage was local disk,
so the R2 bucket was not filled with test photos. Album opens are an album's
record plus its first 100 photos; uploads are a 1600 px, 347 kB JPEG, the
size the camera sends.

| Load | Throughput | p50 / p95 | Errors |
|---|---|---|---|
| Album opens, 10 users | 422 requests/s | 23 / 33 ms | 0 |
| Album opens, 100 users | 479 requests/s | 206 / 230 ms | 0 |
| Album opens, 400 users | 470 requests/s | 841 / 913 ms | 0 |
| Landing page, 200 users | 4,629 requests/s | 42 / 58 ms | 0 |
| Uploads into one album, 5 users | 9 photos/s | 528 / 745 ms | 0 |
| Uploads into one album, 40 users | 7 photos/s | 5.6 / 6.2 s | 0 |
| Uploads into four albums, 20 users | 23 photos/s | 875 ms (p50) | 0 |
| 1,000 sockets in one album's room | joined in 0.5 s; all 197,000 broadcasts of the busiest phase delivered | — | 0 |

Memory was 100 MB idle and 590 MB at the peak, with 400 users reading and
1,000 sockets open.

**Where it tops out, and why.** Reading is bound by the one Node thread:
the feed alone does about 570 requests a second (an album's record 2,800,
the health check 5,700), because each page of 100 photos is built and
serialised on the main thread. That is roughly 230 album opens a second.
Uploads into a single album stop at about 9.5 a second because the album's
upload lock is held until `COMMIT`, and one insert and commit takes 78 ms
(p50) on this machine's Docker Desktop volume, where every commit waits on
fsync; four albums together reach 23 a second. A Linux host or a managed
Postgres commits in a few milliseconds, which moves that ceiling far up.
Sixteen libuv threads instead of four changed nothing. Image encoding is not
the limit here: `mozjpeg` costs 192 ms a photo against 24 ms without it, for
display files about a fifth smaller on the test image, which is worth knowing
if uploads ever become CPU-bound. For scale: a wedding of 200 guests at its
busiest sends a few photos a second. Found on the way: N-157. Still open from
V-4: a run on real hosting with the generator elsewhere.

### The pass

| ID | Finding | Severity | Files | Verified | Fixed |
|---|---|---|---|---|---|
| **N-150** | **A guest's photo that a full album refused was shown as sent.** Every failed upload went to the offline queue, as if the network had failed. On a free album at its 50 photos the server answers 403, and the guest was told "1 sent to the album", saw the photo at the top of the feed and in "Моите снимки", and watched "uploading to the live wall…" for as long as the phone retried it, five times, before it was dropped with a message about having had no connection. The per-guest cap answered 429 with no code, the rate limiter's status, so it was retried as well. Voice messages took the same path. The drop message said the item "was removed from this phone", and nothing removed it. A refusal is now recognised by the app's own code (every 403 the app sends carries one), so a bare 403 from a venue's captive portal or proxy still leaves the photo queued. | High | `src/services/photoService.ts`, `src/services/audioService.ts`, `src/services/offlineQueueService.ts`, `src/services/storageService.ts`, `server/routes/photos/upload.ts` | Yes | `67f4781` |
| **N-151** | **Guests were shown the couple's upsells.** The free-plan limit banner, with its "Надгради" button, and the upgrade button on every locked feature, appeared on guests' phones. A guest who chose a plan reached checkout with no session and read "Unauthorized: Missing or invalid token", in English. Guests now see that the album is full, or that the couple can turn a feature on; a visitor with no account who picks a plan from the pricing page is taken to sign-up; a bare 401 is said in the app's language. | Medium | `src/App.tsx`, `src/components/gallery/LiveFeed.tsx`, `src/components/common/LockedFeatureBadge.tsx`, `src/components/host/PricingPlansModal.tsx`, `src/api/apiClient.ts` | Yes | `67f4781` |
| **N-152** | **A failed renewal was silent.** The webhook keeps the plan for seven days after a failed charge and the grace sweep ends it then, but nothing told the host: no email can be sent while SMTP is unset, and the studio looked like any paid-up plan. The studio now says the payment failed and when the plan will end, and once the grace has run out that the plan is suspended until the subscription is paid, each with a button to the billing portal to fix the card (`GET /api/billing/status`). | Medium | `server/routes/billing.ts`, `src/components/host/BillingNotice.tsx` | Yes | `67f4781` |
| **N-153** | **Albums were open to search engines.** No page carried `noindex` and there was no robots.txt: a guest posting the album's link publicly was all a crawler needed to index the couple's names, venue and guests' photos. `/robots.txt` and `/favicon.ico` answered with the app's page. Every page but the landing and pricing pages (and those too when they carry an album's address in their query), and every uploaded file, now carries `X-Robots-Tag: noindex, nofollow`; robots.txt keeps crawlers off `/api/` only, since a crawler kept off a page never reads its `noindex`. Photos served from the R2 domain are outside this server and cannot carry the header from here. | Medium | `server/lib/builtClient.ts`, `server/index.ts`, `public/robots.txt` | Yes | `67f4781` |
| **N-154** | The sign-in and sign-up fields had no `autocomplete`, so password managers could not tell sign-in from sign-up and phones could not offer the saved address or password (WCAG 1.3.5). | Low | `src/components/host/HostAuthPage.tsx` | Yes | `67f4781` |
| **N-155** | The pricing dialog offered "Choose plan" on plans the host's plan already includes: a Pro Planner subscriber could pick either one-time pass, which the server then refused. They now read "Included in your plan". | Low | `src/components/host/PricingPlansModal.tsx` | Yes | `67f4781` |
| **N-156** | Opening the site at an address other than `PUBLIC_BASE_URL` (the `www.` form against the bare domain, say) made checkout and the billing portal fail with "Invalid redirect URL" in English. The refusal is right; it now has a code and words the host can act on. | Low | `server/routes/billing.ts`, `src/api/apiClient.ts` | Yes | `67f4781` |
| **N-157** | The guest feed went out uncompressed: 96 kB for a page of 100 photos, 9 kB gzipped, loaded by every guest on the venue's Wi-Fi. API answers stay uncompressed on purpose (N-134), because a secret next to text a caller chose can leak through the compressed size; the guest feed carries no secret, so it alone is now compressed. The host's copy, which carries signed preview links, is not. | Low | `server/lib/httpEdges.ts`, `server/index.ts` | Yes | `67f4781` |
| **N-158** | The navigation bar's palette picker was shown to guests. A guest's choice repainted the phone, was sent as an album edit, which the server refused (401), and then changed back with the refusal shown in English. It is now the album host's alone. | Low | `src/components/layout/Navbar.tsx`, `src/App.tsx` | Yes | `67f4781` |
| **N-159** | **An album keeps taking photos after its time is up.** No route reads `expires_at`: the free plan sells "7 days of active access", but an album stays fully open to guests, uploads included, until the retention sweep deletes it, and that is switched off (U-4, decision D1). U-4 covers the deletion only. Recommended: from `expires_at` an album turns read-only (viewing and download stay, uploads, comments and reactions stop) and the host is told why, with deletion still left to D1. | Low | `server/routes/photos/upload.ts`, `server/routes/audio.ts` | Yes | **For the owner** |
| **N-160** | An `/api` address no route answers fell through to Express's HTML "Cannot GET" page instead of a 404 the client can read. | Low | `server/lib/httpEdges.ts`, `server/index.ts` | Yes | `67f4781` |
| **N-161** | `docs/DATABASE_SCHEMA.md` described `subscriptions.storage_limit_gb` as the storage quota. It is never read, and holds its default of 10 on every plan, a Pro Planner's included (whose allowance is 100 GB). | Low | `docs/DATABASE_SCHEMA.md` | Yes | `67f4781` |
| **N-162** | A full unit run still left two or three album folders on disk: an upload whose response came back after its spec had cleaned up, which happens only with the suite running in parallel, never with a spec alone. The teardown now removes folders created during the run whose album no longer exists, and nothing older; the first run with it removed three. The 1,334 such folders already under `uploads/events/` and 371 under `uploads-quarantine/events/` (1.7 GB, September and October) were left in place for the owner. | Low | `tests/globalSetup.ts`, `tests/helpers/orphanSweep.ts` | Yes | `67f4781` |
| **N-163** | **There is no privacy notice, no terms and no operator identity anywhere in the app.** It collects guests' names, table numbers and selfies, photos of people, hosts' emails and payments, but nothing says who runs it, what is kept, for how long, who processes it (Stripe, Cloudflare, the host) or how to have it removed — not on the landing page, not at the guest's first screen, not before payment. For an EU service that is a GDPR Article 13 notice owed at the point of collection, plus the operator details and terms of sale owed to consumers before they pay. The text needs the operator's legal details, so it was not written here. | High | — | Yes | **For the owner** |
| **N-164** | Ending a subscription from the pricing dialog asked "give up Pro Planner and switch to Free?" and warned that everything would be lost, while a one-time pass bought earlier stays: the account falls back to it. The question now names the pass that is kept, and the review of the fix found the promise could still break: with the subscription already over at Stripe, or Stripe not configured, choosing Free set the account to free and forgot the pass. It now falls back to the pass there too. | Low | `server/routes/billing.ts`, `server/routes/subscriptions.ts`, `src/components/host/PricingPlansModal.tsx` | Yes | `67f4781` |

**Checked and found working, recorded so they are not re-tested:** the whole
Stripe round trip above; password change (a wrong current password, a
mismatched repeat, then success, with the other devices signed out) and the
profile name; account deletion from the studio; the account dialog in English;
an album address that does not exist; the host studio at 390 px, with no
sideways scroll (the section strip scrolls, as designed); the free album's
50-photo cap itself.

**Seen and left as they are:** a signed-in host who opens the pricing page from someone else's album sees that album's plan as theirs; the server still refuses anything their own plan includes, with a clear message. The test teardown's sweep assumes the test database is the one the uploads folder belongs to, which holds for one database per checkout.

**Not covered:** live Stripe keys; a load run on real hosting; R2 under load
(local disk here); and, as before, a real screen reader and a real venue's
Wi-Fi.

---

## 4. Confirmed Low

**All eight fixed in `9e6f239`**, except L-1, which was not a defect: `vercel.json`
is genuinely used by the documented frontend deploy, so it was kept and what it
is and is not for was written beside that section of `docs/DEPLOYMENT.md` —
JSON cannot carry the comment itself. L-6 and L-7 were stale documentation
claiming shipped work was missing, which is the same failure this refresh exists
to correct.

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
| **V-1** | Stripe with live keys | **Sandbox half done 2026-10-16 (§3k):** real hosted Checkout, the Stripe CLI delivering signed events to the local webhook, and every path — one-time pass, subscription, period-end and immediate cancellation, failed renewal, grace, lapse and recovery — applied correctly. What is left needs live keys: a real charge, and Stripe's own customer emails. |
| **V-2** | SMTP with a real provider | Deliverability, SPF/DKIM, bounce-webhook ingestion. The rehearsal used a local sink. |
| **V-3** | FTP ingest against real photographer software | Lightroom tethering / camera FTP. The integration test drives `basic-ftp` only. |
| **V-4** | Service capacity ceiling (G2, second half) | The 2026-09-13 benchmark saturated the host uplink at 8.7 MB/s — CPU 17–49%, pool 12/40 — so the service's own limit was never reached. **Measured on one machine 2026-10-16 (§3k):** about 230 album opens a second, bound by the Node thread; uploads into one album about 9.5 a second, bound by commit latency on Docker Desktop's volume; 1,000 sockets with every broadcast delivered; no errors at any load. Still wanted: a run on real hosting with the generator elsewhere. |
| **V-5** | ~84 unread spec files | **Substantially addressed, by a different method than proposed.** Reading was the wrong instrument: every bad test found this session was invisible on the page. A mechanical scan of all 126 spec files for shapes that cannot fail found two more (N-11), and mutation testing — breaking the source and checking the suite notices — found gaps in files that *had* been read. 35 modules swept, every one under `server/` and `shared/` bar three named in §8; see §8 for scores and what is left. |

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

**Mutation testing, 2026-09-17 to 19.** The method that actually worked: apply
one small semantic change to a module, run every spec that reaches it, and
record whether any failed. A mutation that survives is a behaviour nothing
asserts. Every module under `server/` and `shared/` was swept except three,
named below with the reason.

Scores are *after* the gaps below were closed. A score of n/n means every
mutation the harness could make was caught; where survivors remain they are
listed, and each was determined equivalent by reading the code rather than
assumed to be.

| Module | Score | What the sweep found |
|---|---|---|
| `middleware/tierGate` | 18/18 | unrecognised tier must fail closed to free |
| `middleware/auth` | 18/18 | both session-token guards had no direct test |
| `middleware/rateLimit` | 8/8 | body and query fingerprint branches unasserted |
| `middleware/uuid` | 0/1 | 1 equivalent: the `['id']` default is unreachable, every call site names its params |
| `middleware/validate` | 0/3 | all three sites in a fallback `instanceof ZodError` makes unreachable |
| `lib/guestIdentity` | 11/11 | no direct test; impersonation and token version unasserted |
| `lib/guestAuth` | 11/12 | 1 equivalent: `typeof` check both branches end at the same catch |
| `lib/retention` | 11/13 | 2 equivalent: Date comparisons at exact equality |
| `lib/retentionNotice` | 7/7 | `escapeHtml` asserted for one of four characters |
| `lib/photoWrite` | 13/13 | — |
| `lib/photoQuarantine` | 10/10 | promotion skipped a photo in a mixed state |
| `lib/planLimits` | 3/3 | — |
| `lib/images` | 2/2 | — |
| `lib/downloadToken` · `lib/previewToken` | 4/4 · 4/4 | — |
| `lib/subscriptionUpgrade` | 9/9 | — |
| `lib/ingest` | 9/9 | — |
| `lib/ingestPipeline` | 9/9 | magic-byte gate removable without changing the outcome; an event deleted mid-upload |
| `lib/emailBounces` | 7/7 | — |
| `lib/storage` | 15/20 | survivors equivalent, or the R2 coverage hole (M-4) |
| `lib/migrate` | 7/10 | 3 survivors in the CLI `main()`, reached by no spec |
| `ws/wsServer` | 20/22 | N-7, two cross-tenant holes; the heartbeat reaper; 2 equivalent |
| `routes/photos/upload` | 13/14 | four survivors in one block, all identity; 1 dead assignment |
| `routes/photos/engagement` | 8/8 | uuid guard vacuous; reveal rule uncovered |
| `routes/photos/moderation` | 7/10 | rejecting a photo would have published it |
| `routes/photos/feed` | 7/8 | 1 equivalent: millisecond boundary |
| `routes/auth` | 12/14 | `companyName` never persisted-tested; the login fallback could create five events; N-13 |
| `routes/billingWebhook` | 18/18 | which customer the advisory lock keys on |
| `routes/quests` | 9/9 | defaults nulled; malformed photoId reached a uuid column |
| `routes/guests` | 4/4 | table number and avatar silently nulled |
| `routes/events/reactions` | 2/2 | the reactor's name silently nulled |
| `routes/events/export` | 14/16 | 2 equivalent, both guarded twice already |
| `routes/subscriptions` | 4/5 | 1 equivalent: unreachable past the CHECKOUT_REQUIRED return |
| `shared/planCaps` | 2/2 | — |
| `shared/transliterate` | 4/4 | the slug year branch is reachable only from the browser |
| `routes/events/qr` | 6/6 | the upsert saved nothing the host typed |
| `lib/stripe` | 3/3 | the failure path fails open, and nothing checked it |

**Four lessons, each learned by getting it wrong first.**

*Equivalent mutants are not gaps.* Several survivors change no observable
behaviour: `>` versus `>=` on Date instants that are equal either way, a
redundant `existsSync` whose caller already guarantees the file exists, a
conjunct made unreachable by an earlier return. Each was read before being
dismissed, and one that looked serious — `export:237`, a containment check
whose failure would leak another event's files — turned out to be guarded
twice over. A line number is never enough; the statement has to be read.

*A test written for an equivalent mutant is worse than no test.* One was
written for `subscriptions:65` and passed with the mutation applied. It was
deleted rather than tightened: it killed nothing and duplicated an existing
assertion. Adding a test that cannot fail, in a sweep whose purpose is finding
tests that cannot fail, would have been perverse.

*A harness that under-selects specs manufactures survivors.* Selecting only
direct importers reported 10 survivors in `guestAuth` where the transitive set
reported 4. The harness runs a canary — it corrupts the module outright and
refuses to report if the specs still pass — because a survivor list containing
impossible mutations is a list nobody trusts.

*A flaky spec manufactures kills, and those are the dangerous direction.* The
harness reads a failing run as "the mutation was caught". Re-sweeping
`routes/auth` reported `auth:121` — the first-attempt slug ternary — killed;
toggling it by hand and running all 132 spec files left the suite green. No
test kills it; one of the 55 specs in that selection had failed for its own
reasons. A false survivor wastes an afternoon and corrects itself on reading.
A false kill is silent, and it inflates the score. Any survivor that turns into
a kill without a test being written for it is worth re-checking by hand.

**Not swept, deliberately.** `lib/config.ts`, `lib/db.ts` and `lib/errors.ts`
are imported by nearly everything, so each mutation re-runs all 131 spec files —
roughly three quarters of an hour for config parsing, a pool constructor and a
string formatter. The cost is real and the information is not; a sweep is worth
running where a surviving mutant would mean something.

**Open leads — none remain.** Every module under `server/` and `shared/` is
swept, and every survivor is either killed or read and explained below. What
was open, and how each closed:

- `shared/transliterate:33` — **closed, `0d34de0`.** The slug year fallback is
  reachable only from the browser: `HostEventsList` calls
  `generateEventSlug(hostName, eventDate)` while every server call site omits
  the argument, so a server-and-shared sweep could not reach it. Weakened, every
  wedding gets a 2026 slug regardless of when it is.
- `routes/auth` — **chased, `6236ac4`.** Of the six, one was a real hole: the
  login event-auto-creation fallback (DB-13) stops looping only because of its
  `&& !event` guard, and nothing asserted it. Weakened, one login creates five
  weddings — five albums, five slugs, five QR codes — and the existing test
  still passed because it read only the last one. Two more were defaulting
  expressions reading a column straight back from the INSERT that wrote it, so
  the fallback could never fire: deleted rather than tested. Two are slug-shape
  only, and one was measured false (see the fourth lesson above). The sixth —
  the retry-on-collision guard at `auth:165` — is observable only through a
  transient non-collision failure or five consecutive slug collisions; both need
  a mocked pool, and for a persistent failure the mutated code returns the same
  500 the original does. Recorded, not tested.
- `lib/ingestPipeline:176` — **closed, `0d34de0`.** Not message text only: the
  tier gate refuses a missing event long before the write, so this branch fires
  only when the event is deleted *between* the two — an FTP drop racing a host
  deleting the album. `event_not_found` is the one refusal `photoWrite` returns
  with no message attached, so without the pipeline's text the photographer gets
  an empty failure. The first test written for it passed with the mutation
  applied, because it was reaching the tier gate's identical message instead;
  repointed at the real branch with a mock rather than kept.

**Still genuinely uncovered, and recorded rather than closed:**

- `lib/storage`'s R2 branch, which is M-4: the tests exist and the CI lane is
  wired, but it skips until the repository secrets are set.

**The heartbeat reaper, closed `958deea` and `74c6631`.** It was recorded as a
decision rather than taken unilaterally, because covering it meant either fake
timers against live sockets or a testability refactor. The refactor turned out
to be four lines: the `setInterval` body becomes `runHeartbeat()`, and a test
drives two passes in one tick — the first marks the client unanswered and pings
it, the pong cannot land before the second pass, the second reaps. A mirror test
lets the pong arrive and asserts the connection survives, because a reaper that
kills everything is the same outage seen from the other side. Both waits are
bounded so a regression reports an assertion rather than hanging to the timeout.

Re-sweeping then surfaced one more, which was not equivalent: the AUTH branch
ends in an unconditional `return`, so widening its guard from *and* to *or*
means any frame carrying a `token` field is swallowed there. A `JOIN_EVENT_ROOM`
that carries one never joins, and the client waits for a `ROOM_JOINED` that is
not coming. `ws/wsServer` is 20/22; the two survivors are both the
`typeof msg !== 'object' || msg === null` guard, redundant with the enclosing
`try/catch` that drops malformed frames in either direction.

**The client sweep, 2026-09-21.** The September sweep covered `server/` and
`shared/`. `src/` had never been swept at all, and the result says what that
was worth: **157 of 237 killed**, eighty behaviours nothing asserted. The
weakest modules were the ones a guest touches most.

| Module | Before | After | What the gap was |
|---|---|---|---|
| `services/guestService` | 3/19 | 18/19 | Who this phone is at this wedding, and therefore who every photo belongs to. Nothing pinned that a stored guest from another album is refused, that a token is never carried across to a different guest id, or that re-registering keeps one identity instead of making a second row for one person. |
| `services/photoStore` | 6/10 | 10/10 | The preview a guest sees while their photo is still uploading (H1). Neither the thirty-preview cap nor the quota shedding was tested. |
| `services/questService` | 2/7 | 7/7 | Quest creation and the local tick. |
| `services/photoService` | 24/37 | 37/37 | The quarantine preview rule, the merge target, the reaction toggle, and the status rollback added the same week. |
| `services/authService` | 15/22 | 21/22 | Session restore from a half-written localStorage; the logout `keepalive`; the expired-session clear. |
| `services/eventNormalization` | 21/34 | 34/34 | Thirteen `??` fallbacks: an empty value is the host clearing a field, not an absence to be filled from the other spelling. |
| `services/offlineQueue` | 25/33 | 29/33 | Which temp-id rows are still in flight, and the base URL a flush posts to. |
| `services/realtimeMessages` | 37/42 | 41/42 | The `localId` dedupe (another device's id is not proof of a local copy) and the no-echo flag on a settings broadcast. |
| `api/apiClient` | 8/9 | 9/9 | The translated error message. |
| `services/eventService` | 7/8 | 8/8 | A slug nobody has taken. |
| `services/storageService` | 2/3 | 3/3 | The sync-to-server default. |
| `utils/date` | 2/4 | 4/4 | A `Date` argument, and text the parser cannot read. |

The harness is now committed as `scripts/mutate.mjs` (`npm run mutate -- <module>`)
rather than rebuilt each time. It keeps the three guards the last sweep learned
the hard way: a canary that corrupts the module outright and refuses to report
if the specs still pass, a separate "invalid" verdict for a mutation that will
not parse (which otherwise fails every spec and looks like a kill), and a spec
set taken from the transitive importers rather than the direct ones. Building
it re-taught two of them: a closure over a loop variable made every mutation
unparseable and the run called all 15 invalid, and an app log line reading
"Failed to parse URL from …" matched the broken-module detector and did the
same. **Run one sweep at a time** — two vitest processes against one database
produce failures that are read as kills.

**Eight survivors remain, and none is worked around:**
- `useQuestLeaderboard:52` and `:68` — the same condition is checked in the
  effect and again in the loader it calls, so either mutation alone is masked
  by the other. Equivalent in isolation.
- `tierGating:92` and `:94` — `TIER_WEIGHTS[tier] ?? 0` where the free tier's
  weight is already 0, so `||` cannot differ.
- `authService:85` — `isAuthenticated` needs one of user/token set without the
  other, which the constructor's own guard makes unreachable.
- `offlineQueue:92`, `:210`, `:212` and `photoService`-style `typeof window`
  checks — jsdom always satisfies them; they are there for the server-side
  import path, which no client spec exercises.
- `offlineQueue:81` — the fallback error for a transaction aborted from
  outside the service. Reachable only by aborting one.
- `guestService:111` and `realtimeMessages:225` — `??` against a value that is
  never the empty string in practice.

**Structural gaps:**
- **The production storage adapter has no automated coverage at all** (M-4).
- **`src/components/` is still unswept.** The sweep covered the client's logic
  modules; the components themselves are mostly JSX, where an operator swap
  usually breaks the render outright rather than isolating a behaviour. Visual
  regression, not mutation, is the instrument there.
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

**All three are cleared in code.** What remains is operational.

| # | Finding | Why it blocked | State |
|---|---|---|---|
| 1 | **H-2** Node 22 in the container vs 24 everywhere else | The runtime serving production was untested at that version, and the guard built to catch this could not see the Dockerfile. | **Cleared** `a423a38` |
| 2 | **H-3** No graceful shutdown | Every deploy under load could strand R2 objects, and with H-4 nothing would ever reclaim them. | **Cleared** `fadbd7c` |
| 3 | **H-1** Selling three unbuilt capabilities | Commercial, not technical: taking €49/mo for a feature that cannot be delivered. | **Cleared** `35e19b4` |

**Remaining before customers, none of them code:**

| # | Action | Why it matters |
|---|---|---|
| 1 | ~~Add the R2 repository secrets~~ **Done 2026-10-16.** The first run failed every R2 call ("Invalid character in header content"): four of the pasted values carried quotes or a line break. Since `975e0db` the config strips those and names the variable it cleaned; the live-storage job passed on the next run. | Without them the `live-storage` job skips nightly and M-4 is closed only on paper. |
| 2 | Regenerate the exposed R2 keys | `.env` still carries the warning that the stored keys were exposed and must be replaced in the Cloudflare dashboard (OPEN_ITEMS M14). Not verifiable from the repository. **Deferred by the owner on 2026-09-19** while this is a development environment. It becomes a go-live prerequisite: the exposed keys reach the same account as production storage. |
| 3 | Configure SMTP, then notices, then `RETENTION_ENFORCED=true` — in that order | U-1 and U-4. Nothing deletes until the third step; `npm run retention:rehearse` passes 24/24 against a local sink. **Deferred by the owner on 2026-09-19**: no mail provider has been chosen yet. Retention stays off, which is the safe resting state. |
| 4 | Publish a privacy notice, terms and the operator's details (N-163, §3k) | The app collects guests' names, selfies and photos of people, hosts' emails and payments, and says nowhere who runs it, what is kept or how to have it removed. For an EU service that notice is owed where the data is collected, and the operator details and terms before payment. Needs the owner's legal details; the text can then be drafted from what the code does, for legal review. |

Done 2026-09-19: the R2 lifecycle policy, H-4's last net, confirmed on the
bucket with an Admin Read & Write token.

**No longer close to blocking:** V-5. The sweep is finished — every module under
`server/` and `shared/` bar the three named in §8, with no survivor left
unexplained. Reading the 84 files was never going to find what it found; three
of the ~38 that *were* read passed for the wrong reason and none was visible on
the page. The suite's size is still not the same as its strength, but it is now
measured rather than assumed.

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
