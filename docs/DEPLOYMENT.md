# Deployment

**Supported today: one server running `docker-compose.yml`, behind a reverse
proxy that terminates TLS.** That is the shape the code is built for. The app
is one Node process holding the live connection's rooms, the rate limits and
the optional FTP server in its own memory, and the maintenance scheduler and
the daily backup run beside it as their own containers.

Where production will run has **not been decided by the owner** (2026-10-18).
Until it is, other hosting is unsupported — see "Not supported" at the end
before choosing one.

---

## 1. What you need

- A Linux server with Docker Engine and the Compose plugin. 2 vCPU and 4 GB
  of memory carry a large wedding comfortably (MASTER_AUDIT §3k measured about
  230 album opens and 9 uploads a second into one album on a desktop machine).
- A domain name pointed at the server, for example `album.example.com`.
- A Cloudflare R2 bucket for the photos (recommended), or disk on the server.
- Stripe keys, when payments are to be taken.

## 2. Configure `.env`

```bash
cp .env.example .env
```

Set at least these. Compose refuses to start without the first three, and in
production the server refuses an example or missing value for each.

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | Random, letters and digits: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Postgres takes it only when its volume is first created. |
| `JWT_SECRET` | Random, 48 bytes: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PUBLIC_BASE_URL` | The address guests open: `https://album.example.com`. It is written into stored photo addresses, so set it before the first upload. |
| `TRUST_PROXY` | `1` behind one reverse proxy (as below). |
| `APP_BIND` | `127.0.0.1`, so the app is reached only through the proxy. With `TRUST_PROXY=1` and the port open to the world, a client could set its own `X-Forwarded-For` and walk around the rate limits. |
| `CORS_ORIGIN` | `https://album.example.com` |
| `STORAGE_PROVIDER` | `r2`, with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` (docs/CLOUDFLARE_R2_SETUP_GUIDE.md). `local` keeps photos in Docker volumes on this server. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | From the Stripe dashboard. **Without a secret key the unpaid self-serve plan switch stays open**, so set it before real hosts sign up. |
| `BACKUP_UID`, `BACKUP_GID` | The host user (`id -u`, `id -g`) who copies the backups elsewhere. |

Mail (`SMTP_*`) is not set up yet; the app runs without it, and retention
deletion stays off until it is (docs/OPERATIONS.md, section 1).

## 3. Start it

```bash
docker compose up -d --build
docker compose ps
```

Four services start: `db` (Postgres 16, reachable from this server only, on
`127.0.0.1:6532`), `app` (the site, the API and the live connection, on
`APP_BIND:6501`), `maintenance` (the scheduled sweeps, report-only by
default) and `backup` (a database dump every day into `./backups`). The app
applies pending migrations as it starts. `GET /api/health` answers 200 once
the app can reach the database.

## 4. Put TLS in front

Any reverse proxy works if it passes WebSockets through. With Caddy, which
fetches and renews the certificate itself:

```
album.example.com {
    reverse_proxy 127.0.0.1:6501
}
```

With nginx, the upgrade headers have to be passed on:

```nginx
location / {
    proxy_pass http://127.0.0.1:6501;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 30m;
}
```

Open only 80 and 443 in the firewall. Docker's published ports go around a
Linux firewall such as ufw, which is why the database and (with `APP_BIND`)
the app listen on `127.0.0.1` only.

## 5. Stripe

In the Stripe dashboard, add a webhook endpoint
`https://album.example.com/api/billing/webhook` for these events, and put its
signing secret in `STRIPE_WEBHOOK_SECRET`:

`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `invoice.paid`,
`customer.subscription.updated`, `customer.subscription.deleted`.

Price IDs are optional (`STRIPE_PRICE_*`); without them checkout prices from
`server/lib/stripePlans.ts`. The sandbox walk-through in MASTER_AUDIT §3k is
the test to repeat with live keys.

## 6. Photographers' FTP (optional)

The in-process FTP server is off, and `docker-compose.yml` neither passes the
`FTP_*` settings to the app nor publishes its ports. To use it, add those
variables (see `.env.example`) and the control and passive ports to the `app`
service, and give it a TLS certificate: in production it refuses plain FTP
unless `FTP_ALLOW_PLAINTEXT=true`.

## 7. Updates

```bash
docker compose run --rm -e BACKUP_ONCE=1 backup   # a fresh dump first
git pull
docker compose up -d --build                      # migrations apply on start
```

## 8. Before real guests or payments

These are outside the code and recorded in MASTER_AUDIT §9:

- Replace the R2 keys that were exposed during development.
- Fill in the operator's details (`src/config/operator.ts`) and have the
  privacy policy and terms read by a lawyer.
- Copy `./backups` somewhere other than this server, on a schedule
  (docs/OPERATIONS.md, section 6).
- Choose a mail provider, then follow docs/OPERATIONS.md, section 1, before
  retention deletion is ever switched on.

## Not supported

**Serverless or autoscaling hosting (Google Cloud Run, AWS Lambda, Vercel
functions) and a frontend split from the backend.** The rooms of the live
connection and the rate limits live in one process's memory: with two
instances, a guest connected to one does not see photos sent through the
other, and with scale-to-zero the connections and the in-process FTP server
die between visits. The maintenance and backup services have no equivalent
there either. This guide used to describe Cloud Run; following it, the server
refused to start (no `TRUST_PROXY`) and nothing ran the grace sweep. Running
on such a platform would need one fixed instance, the sweeps as scheduled
jobs, and no FTP — decide that with the owner first.

`vercel.json` (one SPA rewrite) belongs to that split deployment and is not
used by the one above.
