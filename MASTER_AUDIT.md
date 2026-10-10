# MASTER AUDIT — Momenta / WedMoments

**Audited:** 2026-09-15, read-only. **Fixes applied and recorded:** 2026-09-17.
**Post-audit findings added:** 2026-09-18, extended 2026-09-19 (§3b).
**Feature review:** 2026-09-21 (§3c). **Accessibility review:** 2026-09-21 (§3d).
**Client mutation sweep:** 2026-09-21 (§8).
**Performance pass:** 2026-09-22 to 23 (§3e).
**Security review, partial:** 2026-09-25 to 26, recorded 2026-10-04 (§3f). **All 25 findings fixed.**
**Remaining five domains:** reviewed 2026-10-05 (§3g). **7 of 36 findings open.**

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
  **Still open.**

**Also found and not yet acted on:** two lazily-split chunks
(`HostEventsList`, `PricingPlansModal`) are still requested on the guest page
because they are mounted unconditionally with an `isOpen` prop rather than
rendered only when open. The parse cost is gone; the request is not.

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

**Open: 7 of 36.** Fixed so far: N-59, N-60, N-61, N-62, N-63, N-64, N-65, N-66, N-67, N-68, N-69, N-70, N-71, N-72, N-73, N-74, N-75, N-76, N-77, N-78, N-79, N-80, N-81, N-82, N-83, N-84, N-92, N-93, N-94.

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
| **N-85** | Deleting one photo can half-delete it on a storage error, or orphan files a concurrent promotion just moved. | Low | `server/routes/photos/moderation.ts` | No | Open |
| **N-86** | A voice message whose insert fails for any reason other than quota or a missing album leaves its file in storage. | Low | `server/routes/audio.ts` | No | Open |
| **N-87** | A 101–120 character custom address passes validation and fails at the 100-character column with a 500; a 95–100 character one that needs a variant overflows the same way. | Low | `server/routes/events/shared.ts`, `server/routes/events/crud.ts` | No | Open |
| **N-88** | The feed cursor carries `createdAt` at millisecond precision against microsecond rows, so a photo in the same millisecond can be skipped between pages. | Low | `server/routes/photos/feed.ts` | No | Open |
| **N-89** | `storage-recount` reseeds totals without a lock, so an upload committing during it is undercounted. | Low | `scripts/storage-recount.ts` | No | Open |
| **N-90** | A new album defaults to the date `2026-09-18`, already past, and clearing the date field throws. | Low | `src/components/host/HostEventsList.tsx` | No | Open |
| **N-91** | The projector wall indexes into a list that new photos shift, so the slide changes mid-display and new photos wait a whole cycle; QR studio save failures are swallowed. | Low | `src/components/projector/LiveProjectorScreen.tsx`, `src/services/qrCanvasService.ts` | No | Open |
| **N-92** | The live `PHOTO_ADDED` broadcast went to the whole room with `originalUrl`: the untouched camera file, EXIF and GPS included, which the REST feed gives to the host only (MED-02). Found while fixing N-67. | High | `server/lib/photoWrite.ts`, `server/ws/wsServer.ts` | Yes | `aa620e6` |
| **N-93** | The N-73 deletion mark could lapse without the purge noticing: a failed renewal was only logged, a mark taken off by something else was renewed into nothing, the rows were deleted without checking the mark was still held, and two deletions of one album shared one mark, each clearing it under the other. Found by the background security review of e38d95b. | Medium | `server/lib/retention.ts`, `server/routes/events/crud.ts` | Yes | `7a4ae79` |
| **N-94** | Three production dependencies had published high or critical advisories, and the CI audit gate was failing on all three: `proxy-addr` 2.0.7 (critical: IP spoofing through an IPv4-mapped IPv6 trust subnet, under Express), `sharp` 0.35.4 (high: librsvg CVE in the decoder every upload goes through), `brace-expansion` 5.0.9 (high: CPU and stack-exhaustion DoS, under archiver). Found while fixing N-83. | High | `package.json`, `package-lock.json` | Yes | `56dbb2d` |

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
| **V-1** | Stripe with live keys | Webhook signature verification and the checkout → webhook → tier round trip have run only against mocks and `sk_test`. |
| **V-2** | SMTP with a real provider | Deliverability, SPF/DKIM, bounce-webhook ingestion. The rehearsal used a local sink. |
| **V-3** | FTP ingest against real photographer software | Lightroom tethering / camera FTP. The integration test drives `basic-ftp` only. |
| **V-4** | Service capacity ceiling (G2, second half) | The 2026-09-13 benchmark saturated the host uplink at 8.7 MB/s — CPU 17–49%, pool 12/40 — so the service's own limit was never reached. Needs real hosting with the generator elsewhere. |
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
| 1 | Add the R2 repository secrets | Without them the `live-storage` job skips nightly and M-4 is closed only on paper. |
| 2 | Regenerate the exposed R2 keys | `.env` still carries the warning that the stored keys were exposed and must be replaced in the Cloudflare dashboard (OPEN_ITEMS M14). Not verifiable from the repository. **Deferred by the owner on 2026-09-19** while this is a development environment. It becomes a go-live prerequisite: the exposed keys reach the same account as production storage. |
| 3 | Configure SMTP, then notices, then `RETENTION_ENFORCED=true` — in that order | U-1 and U-4. Nothing deletes until the third step; `npm run retention:rehearse` passes 24/24 against a local sink. **Deferred by the owner on 2026-09-19**: no mail provider has been chosen yet. Retention stays off, which is the safe resting state. |

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
