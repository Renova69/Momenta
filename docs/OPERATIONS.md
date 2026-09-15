# Operations Runbook

The scheduled jobs and maintenance scripts that keep a running deployment
healthy, and the security-relevant configuration that has to be decided before
production.

---

## 1. Scheduled maintenance

Three sweeps must run continuously. All were written to be run "from cron", and
for a long time nothing ran them at all — which is invisible until it isn't:

- **Retention notices** — without them no host is ever warned, and an unwarned
  album can never be deleted however retention is configured. This one is
  first because the other two are downstream of it.
- **Retention** — without it, storage grows forever against a one-time fee,
  which is exactly the gap album retention exists to close.
- **Subscription grace** — without it, a Pro Planner subscription whose dunning
  ends without another Stripe webhook keeps its tier indefinitely.

`docker-compose.yml` runs all three via the `maintenance` service
(`scripts/maintenance-scheduler.ts`): notices and grace hourly, retention
daily, and each once at boot so a deploy reports the current position
immediately rather than an hour later.

### The notice sweep is what makes retention real

`RETENTION_ENFORCED=true` on its own deletes **nothing** while `SMTP_HOST` is
unset, because the sweep refuses to delete an album whose
`retention_notified_at` is null or younger than `RETENTION_NOTICE_DAYS` — a
code constant of 14 days (`server/lib/retention.ts:47`), not an environment
variable, because how long someone gets to rescue their wedding photos is not
a deployment tuning knob. That was a safe rehearsal for as long as no mailer
existed; it is not one any more.

With SMTP configured and notices sent more than `RETENTION_NOTICE_DAYS` ago,
`RETENTION_ENFORCED=true` **permanently deletes wedding photos**. Read the
notice report before enabling it, not after:

```bash
npm run notify:verify      # check SMTP credentials without sending anything
npm run notify:report      # who is due a warning, sends nothing
npm run notify:send        # send the warnings
```

A notice that bounces does not count as a warning — `npm run bounce:list`
shows addresses that have hard-bounced, and those albums stay undeletable
rather than being deleted on the strength of mail nobody received.

### Rehearse it before you point it at anyone

```bash
npm run retention:rehearse
```

Creates its own throwaway albums covering each case the chain distinguishes —
past grace and warned, past grace and never warned, warned only yesterday,
still inside grace, indefinite retention, a wedding that has not happened yet,
a hard-bounced host — runs the notices and an *enforced* sweep against them,
asserts what survived and what did not, and removes everything it made.

Every query it issues is scoped to the ids it just created (`sendRetentionNotices`
and `sweepExpiredAlbums` both take an `eventIds` filter), so it cannot touch an
album it did not create. It refuses to run with `NODE_ENV=production`, and
refuses to start at all without SMTP, because a notice that cannot be sent
leaves every album unstamped and proves nothing.

Point SMTP at a capture service (Mailtrap, MailHog) rather than a real
provider. A burst of "your album will be deleted" from a domain without
SPF/DKIM is how a sending reputation is spent before the first real message.

The value is that this is free while there is nothing you would mind losing.
Once real weddings exist, the delete path can never again be tested against
anything expendable.

**What a retention sweep actually does:** it purges an album's *media* and
leaves the album row. A host following an old link after their window closes
reaches an empty album, not a 404 that reads as "your wedding is gone".
Removing the album itself is a separate, host-initiated act
(`DELETE /api/events/:id`), and only that one is recorded in `event_deletions`.

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

npm run maintenance:once   # run every scheduled job a single time, then exit
```

A sweep reports `leakedPaths`: objects the storage adapter refused to delete
while their rows were removed anyway. Those bytes are now unreferenced and
will be billed indefinitely, so a nonzero count there is a real finding rather
than noise — `npm run storage:orphans` is how to go and collect them.

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
