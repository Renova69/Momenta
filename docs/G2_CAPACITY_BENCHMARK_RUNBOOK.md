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

## Results — 2026-09-13

Run on the dev machine, with the generator **co-resident** with the app. That
breaks the separate-host rule above, and the results below say where it
mattered and where it did not.

### Rig

| | |
|---|---|
| App host | Windows 10, 16 cores, 32 GB RAM |
| Generator | same machine |
| Postgres | Docker container on the same machine, `DB_POOL_MAX` default 40 |
| Storage | live Cloudflare R2, `STORAGE_PROVIDER=r2` |
| Baseline | `GET /api/health` 0.206–0.225 s, five samples before load |
| Payload | 12 MP: 8.5 MB original + 0.6 MB display = **9.1 MB per upload** |

### The ladder

| Concurrency | Uploads | Wall | Throughput | p50 | p95 | p99 | Failures |
|---|---|---|---|---|---|---|---|
| 5 | 60 | 63.25 s | 0.95/s | 4.90 s | 8.41 s | 8.68 s | 0 |
| 10 | 150 | 156.29 s | 0.96/s | 10.07 s | 15.34 s | 18.55 s | 0 |
| 20 | 120 | 124.96 s | 0.96/s | 19.24 s | 30.53 s | 32.41 s | 0 |

**Zero failures at every step**, and no `429` at any point — throughput of
0.96/s is 57 uploads/min against a 600/min per-IP ceiling, so the limiter
never engaged and did not have to be raised. The warning above about a 429
wall is real but only bites at throughputs this link cannot reach.

### What bound it

Throughput is **identical at c=5, c=10 and c=20**. Latency scales linearly
instead. That is a saturated resource with a queue in front of it, and
Little's Law confirms it — predicted p50 (`concurrency ÷ throughput`) lands
within 3–8% of measured at every step:

| Concurrency | Predicted p50 | Measured p50 |
|---|---|---|
| 5 | 5.26 s | 4.90 s |
| 10 | 10.42 s | 10.07 s |
| 20 | 20.83 s | 19.24 s |

The saturated resource is **the host's uplink to R2**, measured independently
by pushing buffers straight through the storage adapter with sharp, Postgres
and HTTP removed from the path:

| Parallel writes | Throughput |
|---|---|
| 1 | 7.1 MB/s (57 Mbps) |
| 4 | 8.6 MB/s (69 Mbps) |
| 8 | 8.7 MB/s (70 Mbps) |

8.7 MB/s against the load test's implied 9 MB/s: **the application adds
essentially nothing to the wire time.** Image derivation and the database
round-trip are free relative to the network at this bandwidth.

Nothing local came close to binding. During the c=10 run, total CPU sat at
17–49% of 16 cores — *including* the generator, which is itself doing 12 MP
sharp work — and Postgres held 12 connections against a pool of 40.

### What this does and does not answer

It does **not** produce "one instance serves N receptions", because the
network ceiling here is hit far below the service's own. The co-resident
generator turned out not to be the problem the runbook anticipated: both
processes were starved by the same pipe long before they competed for CPU.

What it does produce is more portable than a single number — capacity here is
arithmetic, not mystery:

```
uploads/sec  =  uplink MB/s  ÷  9.1 MB
```

which reproduces every measured row (8.7 ÷ 9.1 = 0.96). On a 1 Gbps host that
is ~13.7 uploads/sec **if the network stays the constraint**; whether CPU takes
over before then is still unmeasured, and this rig cannot measure it.

### The lever worth knowing about

**8.5 MB of the 9.1 MB payload is the retained original — 93%.** Capacity, and
the storage bill in `STORAGE_AND_FINANCIAL_PLAN.md`, are both dominated by one
product decision: whether full-resolution originals are uploaded. Not a change
to make casually — originals are what a host takes to a print shop — but it is
the only lever here worth an order of magnitude.

### Still open

A service-capacity number needs the app on real hosting with a real uplink and
the generator elsewhere. The procedure above is unchanged; what this run
removes is the uncertainty about *what* to look for, since the resource
ordering on a fast link is now the open question rather than the whole thing.

---

## Closing G2

Record in `OPEN_ITEMS.md`: the concurrency reached, the binding resource, the
raw numbers per step, and the app/generator host specs. A number without the
hardware it was measured on cannot be compared against a later run, which is
the main reason to run this at all.
