# G2 — Cloud Capacity Benchmark Runbook

`OPEN_ITEMS.md` lists G2 as **OPEN — owner will run it**. It is the last item in
that audit with no result, and it cannot be closed from a dev machine: it needs
real Cloudflare R2 and a load generator on a *different* host from the app.
This is the procedure for whoever has that second machine.

## What this measures, and why the existing tests do not

Everything green in CI today runs against **local disk** — `vitest.config.ts`
pins `STORAGE_PROVIDER=local` deliberately, because network latency made
timing-sensitive specs fail unpredictably. The opt-in
`npm run test:storage:r2` lane does hit live R2, but its heaviest case is a
10-photo burst; that is a correctness check, not a capacity one.

So the open question is narrow and specific: **how many concurrent guests can
one app instance accept photos from, writing to R2, before uploads start
failing or queueing past what a guest will tolerate?** Nothing measured so far
answers it.

## Why the generator must be on a separate host

Running the generator beside the app makes the app compete with it for CPU,
memory and — decisively — the same outbound network path to R2. The number that
comes out is then a property of the test rig, not of the service. On the dev
machine used during this work, 47 unrelated node processes were already holding
4.5 GB of RAM and an esbuild run crashed mid-suite; a benchmark taken there
would have measured that, not WedMoments.

## Prerequisites

**On the app host**

- App reachable from the generator host (note the URL; `PUBLIC_BASE_URL` and
  `CORS_ORIGIN` must match it, or uploads fail on validation rather than on load)
- `.env` with `STORAGE_PROVIDER=r2` and all four R2 values set
- `TRUST_PROXY` set correctly — behind a proxy and left unset, the app now
  refuses to start in production; set to a blanket `true` while directly
  exposed, per-IP limits become spoofable and the numbers are meaningless
- `DB_POOL_MAX` at its default `40`, and Postgres `max_connections` comfortably
  above it (default 100 is fine for one instance)

**On the generator host**

- This repo checked out, `npm ci`
- Network path to the app host with known, stable latency — record it
  (`ping`, or `curl -w '%{time_total}'` against `/api/health`)

## Baseline first

Take a single-upload timing before any load, from the generator host:

```bash
curl -s -o /dev/null -w 'health: %{time_total}s\n' https://<app-host>/api/health
```

Without a baseline the loaded numbers have nothing to be compared against, and
a slow *network* reads as a slow *service*.

## The runs

The script takes `--url`, so the generator drives the remote app:

```bash
# Warm-up — confirms plumbing, not a measurement. Discard the result.
npm run loadtest -- --url https://<app-host> --concurrency 5 --uploads 25

# Step the load. Run each to completion, record, then move on.
npm run loadtest -- --url https://<app-host> --concurrency 10 --uploads 150
npm run loadtest -- --url https://<app-host> --concurrency 20 --uploads 300
npm run loadtest -- --url https://<app-host> --concurrency 40 --uploads 600
```

`--megapixels` defaults to 12, which is about right for a phone camera. Do not
lower it to make runs faster: image derivation via sharp is a real part of the
cost being measured. `--ws-clients` adds WebSocket subscribers, which is worth
including at the top step — at a live wedding the guests uploading are also the
guests watching the feed.

The container form from `OPEN_ITEMS.md`, if the app runs under compose:

```bash
docker exec wedmoments-app npm run loadtest -- --concurrency 10 --uploads 150
```

Note this runs the generator *inside the app container* and so contradicts the
separate-host requirement. Use it only for a smoke check.

## What to record

For each step, capture from the script output:

- uploads attempted / succeeded / failed, and the failure status codes
- p50 / p95 / p99 upload latency
- wall-clock throughput (uploads per second)

And from the app host during the run:

- CPU and RSS of the node process
- Postgres connections in use:
  `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();`
- Any `[Postgres Pool]` or `429` lines in the app log

## Reading the result

The number G2 wants is the concurrency at which **either** of these first
happens:

1. p95 upload latency crosses ~10s — beyond a guest's patience at a party
2. the failure rate crosses 1%

Then identify which resource bound it, because the fix differs entirely:

| Signal | Bound by | Likely fix |
|---|---|---|
| Pool at `DB_POOL_MAX`, latency climbing, CPU low | Postgres connections | raise `DB_POOL_MAX` (keep under `max_connections`) |
| CPU pinned at 100% | sharp derivation | more instances, or offload derivation |
| CPU and pool both idle, latency high | R2 round-trip | batch or parallelise uploads; check bucket region |
| `429` responses | own rate limiter | tune `uploadLimiter` / `uploadIpLimiter` in `server/middleware/rateLimit.ts` |

A 429 wall is the one to watch for: it looks like a capacity limit and is not.
`uploadLimiter` allows 20/min per guest and `uploadIpLimiter` 600/min per IP —
and every generator request arrives from **one** IP, so the IP limiter can cap
the test long before the service is under real strain. If the run plateaus at
roughly 600 uploads/min, that is the limiter, not the platform. Raise it for
the duration of the benchmark and say so in the results.

## Closing G2

Record in `OPEN_ITEMS.md`: the concurrency reached, the binding resource, the
raw numbers per step, and the app/generator host specs. A number without the
hardware it was measured on cannot be compared against a later run, which is
the main reason to run this at all.
