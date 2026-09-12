# Operations Runbook

The scheduled jobs and maintenance scripts that keep a running deployment
healthy, and the security-relevant configuration that has to be decided before
production.

---

## 1. Scheduled maintenance

Two sweeps must run continuously. Both were written to be run "from cron", and
for a long time nothing ran them at all — which is invisible until it isn't:

- **Retention** — without it, storage grows forever against a one-time fee,
  which is exactly the gap album retention exists to close.
- **Subscription grace** — without it, a Pro Planner subscription whose dunning
  ends without another Stripe webhook keeps its tier indefinitely.

`docker-compose.yml` runs both via the `maintenance` service
(`scripts/maintenance-scheduler.ts`): grace hourly, retention daily, and both
once at boot so a deploy reports the current position immediately rather than
an hour later.

### Enforcement is opt-in

Both default to **report-only**. Deleting irreplaceable wedding photos, or
taking away a plan someone paid for, must never be a side effect of deploying a
service.

```bash
RETENTION_ENFORCED=true    # retention sweep may delete expired album media
GRACE_ENFORCED=true        # grace sweep may downgrade accounts past their deadline
```

Leave them unset to watch what *would* happen first. That is the recommended
first week in production.

### Running a sweep by hand

```bash
npm run retention:report   # what is due, deletes nothing
npm run retention:sweep    # deletes (RETENTION_ENFORCED baked in)

npm run grace:report       # accounts past their dunning deadline
npm run grace:sweep        # downgrades them
```

Inside a container: `docker exec wedmoments-app npm run grace:report`.

---

## 2. Reclaiming orphaned storage

Deleting an event row does **not** delete its photos. Nothing cascades from
Postgres into a filesystem or an object store, so a row removed by anything
other than the retention purge — a manual `DELETE`, a purge that failed
halfway, a test suite cleaning up after itself — strands its media permanently:
once the row is gone there is no path left to look the files up by.

```bash
npm run storage:orphan-report   # list orphans, delete nothing
npm run storage:orphan-sweep    # delete them
```

Sweeps local disk **and** R2 whenever credentials exist, not just the currently
configured provider — media outlives a `STORAGE_PROVIDER` switch, and files
written before such a change are precisely the ones nothing else revisits.

### Safety properties

"Delete storage with no matching database row" is one bad query away from
deleting every wedding photo in the system, and there is no undo:

1. **Dry run by default.** `SWEEP_CONFIRM=true` is required to delete anything.
2. **Refuses on an empty `events` table** — the state in which a naive sweep
   deletes everything.
3. **Ignores anything newer than `MIN_AGE_MINUTES` (default 60).** An upload in
   flight has written its file before it has committed its row; without that
   window the sweep races live traffic and deletes real photos.
4. **Only `events/<uuid>/…` paths.** Anything else is left alone.

Run the report first, always. It prints exactly what the sweep would remove.

---

## 3. Test data

Specs register hosts and create events on every run; a spec that fails
mid-way skips its cleanup entirely. Left alone this accumulates fast — at one
point 5,461 events and 13,763 users, enough to slow the retention report and
bury its output.

The unit suite now purges its own rows in `tests/globalSetup.ts` (which runs
whether or not tests passed) and the e2e runner does the same in its `finally`.
To clean up by hand:

```bash
npm run db:purge-test-data                    # report
PURGE_CONFIRM=true npm run db:purge-test-data # delete
```

Fixtures are identified by an **allow-list of email domains** only the specs
use — `test.com`, `test.local`, `example.com` — never by slug pattern. Patterns
drift as specs are added, and one slightly too broad deletes a real wedding.
Genuine accounts are excluded by construction rather than by an exceptions list
someone has to maintain.

Never point this at a production database.

---

## 4. Production configuration that fails closed

These refuse to start rather than run misconfigured. All were chosen because
the failure they prevent is silent.

| Setting | Behaviour |
|---|---|
| `JWT_SECRET` | Required, ≥32 chars, and in production must not be one of the example values committed to this repo — those are public, so every token signed with them is forgeable. |
| `TRUST_PROXY` | **Required in production.** Behind a proxy and left unset, every request looks like it comes from the proxy and the per-IP limiters throttle all users as one. Set to a blanket `true` while directly exposed and any client can spoof `X-Forwarded-For` to pick its own rate-limit identity. Nothing in front? Say so with `TRUST_PROXY=false`. |
| `STORAGE_PROVIDER=r2` | Requires all four R2 values. Without `R2_PUBLIC_URL` every upload succeeds and is then permanently unloadable in a browser. |
| `STRIPE_SECRET_KEY` | Not merely a payments switch: leaving it unset **reopens** the unpaid self-serve tier write in `routes/subscriptions.ts`, so anyone with an account can grant themselves a paid plan. |

Security response headers (CSP, HSTS in production, `nosniff`, `X-Frame-Options: DENY`)
are set by helmet in `server/index.ts`. The CSP is written out rather than taking
helmet's defaults because two of those defaults break this app — see the comment
there before changing it.

---

## 5. Capacity

`docs/G2_CAPACITY_BENCHMARK_RUNBOOK.md` — how many concurrent guests one
instance can accept uploads from before latency or failures cross the line.
Requires real R2 and a load generator on a **separate host**; still open.
