# MASTER AUDIT — Momenta / WedMoments

**Audited:** 2026-09-15, read-only. **Fixes applied and recorded:** 2026-09-17.
**Post-audit findings added:** 2026-09-18, extended 2026-09-19 (§3b).

> **Read this first.** The audit below is preserved as written — each finding
> still describes the code as it was on 2026-09-15, because a finding rewritten
> to match the fix stops being evidence that the fix was needed. What changed is
> that every confirmed finding now carries a **FIXED** line naming the commit,
> and §9 records what is actually left.
>
> **State on 2026-09-18:** all three production blockers cleared in code. Of the
> 20 findings the audit itself produced (12 in §§2–3, 8 in §4): **18 fixed**,
> **1 partly** — H-4, whose lifecycle rule is written and waiting on a
> credential — and **1 resolved as not a defect**: L-1's premise was wrong,
> `vercel.json` is genuinely in use.
>
> **§3b records 13 further findings the audit did not produce, all of them
> fixed.** Every one was found by *running* something the audit had only read. That is
> the most useful thing in this document: reading code does not catch a
> container that will not start, a sweep that reports work it did not do, or a
> teardown that deletes another process's data. One of them, N-3, is the root
> cause of the intermittent suite failures that had previously been blamed on
> database contention.
>
> What remains is operational (§9).

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

**Totals as of 2026-09-19:** of the audit's own 20 findings — 18 fixed, H-4
partly (lifecycle rule written, not applied), L-1 resolved as not a defect. Of
the 13 post-audit findings in §3b — 13 fixed. Production blockers 0 in code, 4
operational actions outstanding (§9). The 4 unfinished features are unchanged
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
**PARTLY FIXED.** Two of the three nets are up; the third needs a credential.

1. **Orphan detection sees R2** — `bfbbcb7`. Paginated listing that aborts on a
   truncated page rather than reporting a partial one as complete, an
   unrecognised key never treated as an orphan, and a refusal to act when the
   events table is empty while the bucket is not. Exercised against the live
   bucket with four seeded objects (live / orphan / quarantined orphan /
   unrecognised): correct on all four, and the empty-events guard refused to
   delete. `bce0e6a` then fixed the local half, which had never walked the
   quarantine tree at all and reported removals it had not performed.
3. **Orphan production stopped** — `fadbd7c` (H-3).

2. **Lifecycle rules are still not on the bucket.** `4bf398d` made the script
   usable — it takes `R2_ADMIN_*` credentials instead of requiring you to
   overwrite the app's token in `.env`, refuses to write over a configuration it
   could not read, and names any rule on the bucket the policy would destroy
   rather than dropping it silently. Applying it remains an **owner action**: it
   needs an Admin Read & Write token, which is deliberately not what the
   application carries.

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

## 3b. Found After the Audit (2026-09-17 / 18)

None of the findings below came from the read-only passes. Every one was found
by **running** something the audit had only read — the container, the storage
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
| `lib/ingestPipeline` | 8/9 | magic-byte gate removable without changing the outcome; 1 message-only |
| `lib/emailBounces` | 7/7 | — |
| `lib/storage` | 15/20 | survivors equivalent, or the R2 coverage hole (M-4) |
| `lib/migrate` | 7/10 | 3 survivors in the CLI `main()`, reached by no spec |
| `ws/wsServer` | 18/22 | N-7, two cross-tenant holes; 2 equivalent; heartbeat untested |
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
| `shared/transliterate` | 3/4 | 1 open |
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

**Open leads, measured but not yet chased.** Recorded with line numbers so the
next pass starts from evidence rather than re-deriving it:

- `shared/transliterate:33` — the slug year fallback.
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
- `lib/ingestPipeline:176` — message text only.

**Still genuinely uncovered, and recorded rather than closed:**

- `ws/wsServer`'s heartbeat reaper. Covering it means either fake timers against
  live sockets, which this suite does not need more of, or extracting the reap
  decision into a predicate — a testability refactor of production code, left
  as a decision rather than taken unilaterally.
- `lib/storage`'s R2 branch, which is M-4: the tests exist and the CI lane is
  wired, but it skips until the repository secrets are set.

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

**All three are cleared in code.** What remains is operational.

| # | Finding | Why it blocked | State |
|---|---|---|---|
| 1 | **H-2** Node 22 in the container vs 24 everywhere else | The runtime serving production was untested at that version, and the guard built to catch this could not see the Dockerfile. | **Cleared** `a423a38` |
| 2 | **H-3** No graceful shutdown | Every deploy under load could strand R2 objects, and with H-4 nothing would ever reclaim them. | **Cleared** `fadbd7c` |
| 3 | **H-1** Selling three unbuilt capabilities | Commercial, not technical: taking €49/mo for a feature that cannot be delivered. | **Cleared** `35e19b4` |

**Remaining before customers, none of them code:**

| # | Action | Why it matters |
|---|---|---|
| 1 | Apply the R2 lifecycle policy with an Admin Read & Write token | The last of H-4's three nets. The script is ready (`4bf398d`); it needs a credential the application deliberately does not carry. |
| 2 | Add the R2 repository secrets | Without them the `live-storage` job skips nightly and M-4 is closed only on paper. |
| 3 | Regenerate the exposed R2 keys | `.env` still carries the warning that the stored keys were exposed and must be replaced in the Cloudflare dashboard (OPEN_ITEMS M14). Not verifiable from the repository. |
| 4 | Configure SMTP, then notices, then `RETENTION_ENFORCED=true` — in that order | U-1 and U-4. Nothing deletes until the third step; `npm run retention:rehearse` passes 24/24 against a local sink. |

**Close to blocking, not yet:** V-5 — roughly 84 spec files have been executed
but never read. Three of the ~38 that *were* read turned out to pass for the
wrong reason, and none of the three was visible without breaking the source, so
the rate over the remainder is not zero. The suite's size is not the same as its
strength.

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
