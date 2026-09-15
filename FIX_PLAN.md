# FIX PLAN — Momenta / WedMoments

**Source:** `MASTER_AUDIT.md` only. **Scope:** CONFIRMED findings only —
18 of them (4 High, 6 Medium, 8 Low). No code has been modified in producing this
plan.

**Excluded by design:** unfinished planned features (U-1 – U-4, §11), false
positives (FP-1 – FP-3), and items still needing manual verification
(V-1 – V-5). None of those is a defect, and none belongs in a fix queue.

## Ordering principle

Batches are ordered by **dependency and blast radius**, not by effort. Three
rules drove the sequence:

1. **Settle the runtime before changing runtime behaviour.** H-2 alters the Node
   major the service runs on. Anything merged before it is validated against a
   runtime that is about to change; anything merged with it makes a failure
   ambiguous. It ships alone, early.
2. **Stop producing a problem before cleaning it up.** H-3 (graceful shutdown)
   must land before H-4 (orphan reclamation), or reclamation runs while orphans
   are still being created on every deploy.
3. **Gate new code before writing it.** M-4 wires the existing R2 test lane into
   CI. It must precede H-4b, which adds new R2 code to a path that currently has
   no automated coverage at all.

Batch 1 is first despite being trivial because it is a production blocker with
zero technical risk and no dependencies — there is no reason for it to wait
behind engineering work.

---

# PART A — DEFECTS

---

## Batch 1 — Commercial unblock

Independent of everything else. No code. Ships alone and immediately.

### Fix 1.1 — H-1: stop advertising three unbuilt capabilities

| | |
|---|---|
| **Finding** | H-1 (High, production blocker) |
| **Feature** | Billing / Pro Planner pricing |
| **Files** | `src/i18n/translations/bg.ts:375`, `src/i18n/translations/en.ts:346-349`, possibly `src/config/plans.ts:57-70` |

**Exact intended change.** Three feature strings are rendered at the point of
sale for a plan that cannot deliver them: `plan.pro.f2` (white-label),
`plan.pro.f4` (custom subdomains), `plan.pro.f5` (archive hand-off). Choose one
of two treatments per string, in both languages:

- **Remove** — delete the key from both translation tables *and* its entry from
  `plans.ts` `pro_planner.features`. The array is rendered by index, so removing
  a translation key without removing the array entry renders a raw key string to
  a buyer.
- **Mark as forthcoming** — keep the string, reword it to state it is not yet
  available, and render it visually distinct from delivered features.

This is a copy and product decision. It should not be made by whoever implements
it.

**Regression test required.** No for the copy itself. **Yes** for the class:
a test asserting every key in each plan's `features` array resolves in both `bg`
and `en` — cheap, and it catches the half-removal failure mode above.

**Verification command**
```
npm run test:unit -- pricingPlansModal
npm run lint -- --max-warnings=0
```

**Possible side effects.** Removing an array entry shifts the rendered list;
snapshot-style assertions on feature counts would need updating. The i18n
completeness test in the suite will fail if a key is removed from one language
and not the other — which is the desired behaviour.

**Rollback.** Revert the commit. No data, schema or runtime involvement.

**Dependencies.** None.

---

## Batch 2 — Runtime foundation

Ships alone. Nothing else in this plan should be in the same commit or the same
deploy.

### Fix 2.1 — H-2: align the container's Node major with every gate that tests it

| | |
|---|---|
| **Finding** | H-2 (High, production blocker) |
| **Feature** | Build / runtime |
| **Files** | `Dockerfile:9,34`, `.github/workflows/ci.yml` (pin step, ~line 56) |

**Exact intended change.** Two parts, both required — the first without the
second re-opens the same gap on the next bump.

1. Change both `FROM node:22-alpine` lines to the major pinned by `.nvmrc`
   (currently `24`).
2. Extend CI's existing "Node version pins agree" step to parse the major out of
   the Dockerfile's `FROM node:` lines and include it in the comparison, so the
   check covers four sources rather than three. Fail on any disagreement, with
   the Dockerfile named in the error.

**Regression test required.** **Yes** — the CI step extension *is* the test.
Verify it fails by temporarily setting the Dockerfile to a different major
before merging.

**Verification command**
```
docker build -t momenta:nodecheck .
docker run --rm momenta:nodecheck node -v      # expect v24.x
npm run typecheck && npm run lint -- --max-warnings=0
```
Then push and confirm the pin step passes; separately confirm it *fails* on a
deliberate mismatch.

**Possible side effects.** This is the substantive risk in the plan. Node 24
changes the bundled V8, `undici` and OpenSSL. Native dependencies — `sharp`,
`bcrypt`, `pg` — resolve prebuilds per ABI and must be re-verified in the image,
not only on a developer machine. A native module without a Node 24 prebuild will
compile from source or fail the build outright.

**Rollback.** Revert the `FROM` lines and redeploy the previous image tag. Keep
the CI pin extension — it is independently correct, and reverting it would hide
the drift again. Retain the last known-good image tag before deploying.

**Dependencies.** None. **Blocks:** Batches 3 and 5 should be validated against
the settled runtime.

---

## Batch 3 — Stop producing orphans

### Fix 3.1 — H-3: graceful shutdown

| | |
|---|---|
| **Finding** | H-3 (High, production blocker) |
| **Feature** | Runtime lifecycle / data integrity |
| **Files** | `server/index.ts`; possibly `Dockerfile` (init/signal forwarding) |

**Exact intended change.** Install `SIGTERM` and `SIGINT` handlers that, in order:

1. stop accepting new connections (`server.close()`);
2. allow in-flight HTTP requests to finish, under a bounded timeout shorter than
   the orchestrator's kill grace period (Docker's default is 10s; choose a
   budget below it and state it in a comment);
3. close WebSocket connections through `wsManager` so clients receive a close
   frame rather than a reset;
4. drain the pg pool (`pool.end()`);
5. exit with a success code.

Make the handler idempotent — a second signal during shutdown must not restart
the sequence. Confirm signals actually reach PID 1: `CMD ["tsx", …]` execs
directly, so this needs verifying in the image rather than assumed.

**Regression test required.** **Yes.** An integration test that boots the server,
starts a slow request, sends `SIGTERM`, and asserts the in-flight request
completes while a new connection is refused.

**Verification command**
```
npm run test:unit -- gracefulShutdown
docker run --rm -d --name momenta-sig momenta:latest && \
  docker stop --time 15 momenta-sig && docker logs momenta-sig
```
Expect an orderly shutdown log, not an abrupt truncation.

**Possible side effects.** A shutdown budget longer than the orchestrator's
grace period produces `SIGKILL` anyway — worse than today, because the code now
*looks* handled. Draining the pool while a background scheduler holds a client
can throw on exit; the maintenance scheduler runs as a separate service and
should be checked. Deploys become marginally slower by design.

**Rollback.** Revert. The pre-existing behaviour is an abrupt exit, which is the
current state — rollback restores it exactly.

**Dependencies.** Batch 2 (validate on the final runtime). **Blocks:** Batch 5 —
reclaiming orphans while still creating them on every deploy is wasted effort.

---

## Batch 4 — Gate the storage adapter

Must precede Batch 5. Adds no production code.

### Fix 4.1 — M-4: run the existing R2 lane in CI

| | |
|---|---|
| **Finding** | M-4 (Medium) |
| **Feature** | CI / storage |
| **Files** | `.github/workflows/ci.yml` |

**Exact intended change.** `tests/integration/r2Storage.spec.ts` contains six
real-R2 tests that no workflow runs. Add a job — scheduled, or on `main` only —
that runs `npm run test:storage:r2` with R2 credentials from repository secrets.
Do **not** add it to the pull-request path: it writes to a live bucket, and PRs
from forks cannot access secrets.

If a dedicated test bucket is not available, the alternative is a provider
contract suite both adapters must satisfy, run against local in PRs and R2 on
schedule. That is more work and should be a separate decision.

**Regression test required.** No — the tests exist. This wires them up.

**Verification command**
```
npm run test:storage:r2          # locally, against the configured bucket
gh workflow run ci.yml           # confirm the new job appears and passes
```

**Possible side effects.** Writes objects to a real bucket on every run — the
spec must clean up after itself, which should be confirmed before scheduling it.
Class A operations have a cost, negligible at this volume. A flaky network turns
into a red build; keep it off the required-checks list until it has proven
stable.

**Rollback.** Remove the job. No production impact.

**Dependencies.** None. **Blocks:** Fix 5.2 — new R2 code should not land on an
ungated path.

---

## Batch 5 — Reclaim orphans

Two independent halves: one operational, one code. Both address H-4.

### Fix 5.1 — H-4(a): apply the R2 lifecycle policy

| | |
|---|---|
| **Finding** | H-4 (High) |
| **Feature** | Storage lifecycle |
| **Files** | None — operational. `scripts/r2-lifecycle.ts` already holds the policy. |

**Exact intended change.** The policy (multipart abort at 7 days, `quarantine/`
expiry at 400 days, and deliberately **no** age rule on `events/`) is written and
correct. It has never been applied: the app's R2 token is Object Read & Write and
cannot manage lifecycle rules. Apply it once, by either route:

- Cloudflare dashboard → R2 → bucket → Settings → Object lifecycle rules; or
- `npm run r2:lifecycle:apply` run once with a **separate admin token** that is
  not the token the application carries.

Do not widen the application's own token. The current scope is correct for a
runtime credential.

**Regression test required.** No — this is configuration, not code.

**Verification command**
```
npm run r2:lifecycle     # report mode; expect the two rules to be present
```

**Possible side effects.** The `quarantine/` expiry deletes objects older than
400 days under that prefix. Confirm nothing legitimate is parked there
long-term before applying — a quarantined photo is meant to be promoted or
deleted, never to sit indefinitely.

**Rollback.** Remove the rules in the dashboard. Note the asymmetry: **objects
already expired cannot be recovered.** This is the one step in the plan with an
irreversible failure mode, which is why the report-mode check comes first.

**Dependencies.** Batch 3 — apply after orphan *production* has stopped, so the
first run is not chasing a moving target.

### Fix 5.2 — H-4(b): make orphan detection see R2

| | |
|---|---|
| **Finding** | H-4 (High) |
| **Feature** | Storage lifecycle / ops tooling |
| **Files** | `scripts/storage-orphans.ts`, possibly `scripts/storage-orphan-sweep.ts` |

**Exact intended change.** `storage:orphans` currently prints
`STORAGE_PROVIDER=r2 — this script only walks local disk.` and exits, so the
detection net does not function in the mode production runs. Add an R2 path:
list the bucket by `events/` and `quarantine/` prefix, extract the event id from
each key, and compare against `SELECT id FROM events`. Report objects whose
prefix has no row.

Keep the existing two-stage shape — `storage:orphan-report` reports,
`storage:orphan-sweep` deletes behind `SWEEP_CONFIRM=true`. Deletion must stay
opt-in and explicit.

**Regression test required.** **Yes.** A test with a seeded bucket prefix that
has no matching event row, asserting it is reported — and, critically, that a
prefix *with* a live row is not.

**Verification command**
```
npm run storage:orphans          # expect a real report, not the skip message
npm run test:unit -- storageOrphans
```

**Possible side effects.** This is the highest-consequence code in the plan: a
false positive here, followed by a sweep, deletes a customer's wedding photos.
The event-id extraction must handle both `events/{id}/…` and
`quarantine/events/{id}/…`, and must treat an unparseable key as *not* an orphan.
Bucket listing is paginated; a partial listing treated as complete would mark
live objects as orphaned — the listing must be proven exhaustive before any
result is acted on.

**Rollback.** Revert the script. Detection returns to non-functional under R2 —
no worse than today, and no data is touched by the report path.

**Dependencies.** Batch 4 (R2 code must be gated). Batch 3 (stop producing
first).

---

## Batch 6 — Operational truth

### Fix 6.1 — M-1: make the health check able to fail

| | |
|---|---|
| **Finding** | M-1 (Medium) |
| **Feature** | Ops / observability |
| **Files** | `server/index.ts` (`/api/health`) |

**Exact intended change.** The endpoint returns `status:'ok'` without touching
any dependency, and the Dockerfile's `HEALTHCHECK` curls it. Add a cheap
dependency probe — `SELECT 1` with a short timeout — and return `503` with the
failing dependency named when it fails. Keep the payload otherwise unchanged; it
runs every 30 seconds.

Consider separating liveness (process up) from readiness (dependencies
reachable) if an orchestrator will consume both. That is a design choice worth
making explicitly rather than by default.

**Regression test required.** **Yes.** A test asserting 503 when the pool
rejects, and 200 when it resolves.

**Verification command**
```
npm run test:unit -- health
docker compose stop db && curl -i http://localhost:6501/api/health   # expect 503
docker compose start db && curl -i http://localhost:6501/api/health  # expect 200
```

**Possible side effects.** A health check that can fail *will* fail — including
during a brief database blip, which may now restart a container that would
previously have ridden it out. Choose the timeout and the orchestrator's
`retries` together. A per-30s `SELECT 1` is negligible pool load, but it is not
zero.

**Rollback.** Revert. The endpoint returns to unconditional `ok`.

**Dependencies.** None.

---

## Batch 7 — Input validation

### Fix 7.1 — M-3: stop `/api/audio` accepting images

| | |
|---|---|
| **Finding** | M-3 (Medium) |
| **Feature** | Audio guestbook |
| **Files** | `server/lib/validation.ts:44-63`, `server/routes/audio.ts:22-24,50` |

**Exact intended change.** `validateMagicBytes` has exactly one caller
(`/api/audio`) and one purpose, yet accepts JPEG, PNG, GIF and WebP, and any
ISO-BMFF `ftyp` container with no brand allowlist. Either:

- split an audio/video-only validator and leave `validateMagicBytes` for any
  future general use; or
- narrow `validateMagicBytes` itself, since it has a single caller.

Either way: drop the four image branches, and constrain `ftyp` to audio/video
brands (`M4A`, `mp42`, `isom`, …) rather than accepting every brand — mirroring
what `isImageMagicBytes` already does on the image side. Consider also rejecting
when `req.file.mimetype` is neither `audio/*` nor `video/webm`, so the
declared type and the bytes must agree.

**Regression test required.** **Yes.** "Refuses an image posted to the audio
guestbook", plus positive cases for every format the recorder actually produces —
webm/opus (Chrome/Firefox), mp4/aac (Safari), ogg.

**Verification command**
```
npm run test:unit -- audioGuestbookRoutes audioCodecSelection mediaValidation
npm run test:e2e
```

**Possible side effects.** The real risk is over-narrowing and rejecting a
legitimate recording from a browser nobody tested. `MediaRecorder` output varies
by platform; the existing codec-negotiation spec enumerates what the client asks
for and is the reference. Any existing `audio_guestbook` rows holding image bytes
will remain — this changes admission, not stored data.

**Rollback.** Revert. Admission returns to permissive; no stored data is
affected either way.

**Dependencies.** None.

---

## Batch 8 — Bilingual completeness

### Fix 8.1 — M-2: translate the nine unmapped error codes

| | |
|---|---|
| **Finding** | M-2 (Medium) |
| **Feature** | i18n / error handling |
| **Files** | `src/api/apiClient.ts:31-37`, `src/i18n/translations/{bg,en}.ts` |

**Exact intended change.** Add the nine missing codes to `ERROR_CODE_KEYS` with
corresponding `error.*` keys in both tables: `SESSION_REVOKED`,
`GUEST_TOKEN_REQUIRED`, `GUEST_IDENTITY_REQUIRED`, `CHECKOUT_REQUIRED`,
`ALREADY_SUBSCRIBED`, `MANAGE_SUBSCRIPTION_IN_PORTAL`, `NO_STRIPE_CUSTOMER`,
`CONFIRMATION_MISMATCH`, `STRIPE_NOT_CONFIGURED`.

`STRIPE_NOT_CONFIGURED` is already special-cased client-side; adding a
translation must not disturb that fallback path, which silently routes to the
pre-Stripe upgrade route.

**Regression test required.** **Yes**, and it should be the general form rather
than nine assertions: every `code:` string emitted under `server/` has an entry
in `ERROR_CODE_KEYS`, and every entry resolves in both languages. That catches
the tenth code when someone adds it.

**Verification command**
```
npm run test:unit -- apiClient i18n
npm run lint -- --max-warnings=0
```

**Possible side effects.** Translated text replaces the server's English string
in the UI, so any test asserting on the English wording will fail — correctly.
The completeness test will fail the build for any future code without a
translation, which is the point and should be stated in the PR.

**Dependencies.** None.

---

## Batch 9 — Hygiene, dead code and documentation

Low risk, independently reviewable, safe to batch together. Nothing here changes
runtime behaviour.

| Fix | Finding | Files | Intended change | Side effects |
|---|---|---|---|---|
| 9.1 | L-2 | `0)`, `5` | `git rm` two empty files committed by a shell-redirection accident. | None. Present in public history; removal does not rewrite it. |
| 9.2 | L-3 | `server/lib/images.ts`, `src/api/apiClient.ts`, `src/utils/date.ts` | Remove three exports referenced only at their own declaration: `isDecodableImage`, `ApiErrorResponse`, `formatEuDateTime`. | Confirm no dynamic/string reference before removing. `ApiErrorResponse` is a type — check it is not part of a public surface consumers rely on. |
| 9.3 | L-4 | `.env.example` | Document `NOTICE_INTERVAL_HOURS` alongside its two documented siblings. | None. |
| 9.4 | L-5 | `.github/workflows/ci.yml:145` | Drop the migration count from the comment rather than updating it — it goes stale by one per migration. | None. |
| 9.5 | L-6 | `OPEN_ITEMS.md:2842` | Mark the M10 "Not done" entry resolved: `guests.token_version` (migration 023), verification in `guestAuth.ts`, and the host reset route all exist. | None. Prevents a reader concluding a shipped control is missing. |
| 9.6 | L-7 | `OPEN_ITEMS.md:3368` | Note that the safe subset of the lifecycle policy now exists in `scripts/r2-lifecycle.ts`; keep the `events/` constraint, which is still binding. Cross-reference Fix 5.1. | None. |
| 9.7 | L-1 | `vercel.json` | Delete, or add one line stating it is SPA-preview-only and the API deploys via Docker. | Deleting breaks any existing Vercel preview deployment — confirm none is in use. |
| 9.8 | L-8 | `.dockerignore` | Add `uploads-quarantine/` and the agent dot-directories to shrink the build context. | None; none is `COPY`d into the image today. |
| 9.9 | M-6 | — | Operational: delete the 157 MB of stale local uploads left from before the R2 switch. | **Verify `STORAGE_PROVIDER=r2` and that no local-mode album still needs them.** Irreversible. Not a code change. |

**Regression test required:** none for 9.1–9.9.
**Verification:** `npm run typecheck && npm run lint -- --max-warnings=0 && npm run test:unit`
**Rollback:** revert the commit; for 9.9, restore from backup — there is none by
default, so confirm before deleting.
**Dependencies:** 9.6 should follow Fix 5.1 so the note reflects reality.

---

## Batch 10 — Requires a decision, not an implementation

### M-5 — `amount_paid_cents` and `stripe_webhook_events.received_at` are written but never read

**No fix is proposed, because the correct action depends on intent.** Two
coherent options:

- **If revenue reporting is wanted:** the column needs to accumulate rather than
  overwrite, and something needs to read it. That is a feature, and it belongs in
  Part B, not in a defect queue.
- **If it is not:** the columns are harmless write-only audit metadata. Document
  them as such in `docs/DATABASE_SCHEMA.md` and close the finding.

Billing correctness does not depend on this either way: nothing computes a charge
from either column. **Dependencies:** none. **Blocker:** no.

---

# PART B — UNFINISHED PLANNED FEATURES

Not defects. **No fix plan is given for these**, deliberately — they are product
decisions or deliberate resting states, and putting them in a defect queue would
misrepresent both.

| ID | Feature | State | What it actually needs |
|---|---|---|---|
| **U-1** | SMTP / email delivery | Complete in code, unconfigured. Notices cannot send, so retention deletes nothing — fails closed. | A provider choice and five env values. A rehearsal harness (`npm run retention:rehearse`, 24 checks) already exists and passed end-to-end against a local sink. |
| **U-2** | Custom subdomains per couple | Not started. No DNS, CNAME or host-header routing exists. | A design decision first: wildcard DNS, per-tenant certificates, and routing. Substantial. Its *advertising* is Fix 1.1. |
| **U-3** | White-label branding removal; archive hand-off to the couple | Not started. No branding-suppression setting; no ownership-transfer route. | Product definition. Hand-off in particular needs a decision about what transferring an album *means* — billing, retention and access all move with it. Its advertising is Fix 1.1. |
| **U-4** | Retention enforcement (decision D1) | Built, deliberately off. Two independent gates gate deletion; the celebration guard prevents the free tier warning couples before their wedding. | An owner decision, in order: SMTP → notices → `RETENTION_ENFORCED=true`. Nothing deletes anything until the third step. |

**None of U-1 – U-4 is a production blocker.** Unconfigured mail and disabled
retention are safe states: the system fails closed in both.

---

## Summary — batch sequence and gating

| Batch | Contents | Blocked by | Risk |
|---|---|---|---|
| 1 | H-1 pricing copy | — | None |
| 2 | H-2 Node major + CI pin | — | **High** — native modules, whole runtime |
| 3 | H-3 graceful shutdown | 2 | Medium — shutdown timing vs orchestrator |
| 4 | M-4 R2 lane in CI | — | Low — no production code |
| 5 | H-4a lifecycle apply, H-4b R2 orphan detection | 3, 4 | **High** — 5.1 irreversible; 5.2 can delete live photos if wrong |
| 6 | M-1 health check | — | Low — may restart on DB blips |
| 7 | M-3 audio validation | — | Medium — over-narrowing rejects real recordings |
| 8 | M-2 i18n error codes | — | Low |
| 9 | L-1 – L-8, M-6 hygiene | 5.1 (for 9.6) | Low; 9.9 irreversible |
| 10 | M-5 decision | — | None |

**Production blockers cleared by:** Batch 1 (H-1), Batch 2 (H-2), Batch 3 (H-3).
Batch 5 does not clear a blocker but gates onboarding real customers.

Batches 1, 4, 6, 7 and 8 have no dependencies and may run in parallel with the
2 → 3 → 5 chain, which is strictly sequential.

*No code modified in producing this plan.*
