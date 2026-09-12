# 🐳 Local Docker PostgreSQL & Unified Container Setup

This guide details how to run the WedMoments environment locally via Docker on port `6501` (App) and `6532` (PostgreSQL).

---

## 1. Start Fullstack Production Environment (Unified Docker Compose)

```bash
docker compose up --build -d
```

This starts:
- **WedMoments Unified Fullstack App**: `http://localhost:6501`
- **PostgreSQL 16 Database**: `localhost:6532` (`wedmoments_db`)

---

## 2. Database Migrations

Two mechanisms exist — know which one actually ran:

- **Postgres's own init-script mechanism**: `docker-compose.yml` mounts
  `./database/migrations` as `/docker-entrypoint-initdb.d` (read-only). The
  official Postgres image runs every `*.sql` file in that directory, in
  order, **exactly once** — only the very first time a container starts
  against a brand-new, empty volume. Deleting the `db` container without
  deleting its volume does **not** re-run these.
- **The app's own ledger-based runner** (`server/lib/migrate.ts`) is what
  actually keeps a real, already-running database current. It tracks what
  it has applied in a `schema_migrations` table, is idempotent, and runs
  automatically on server boot unless `AUTO_MIGRATE=false`. Run it directly
  with:
  ```bash
  npm run migrate
  ```
  This is the mechanism to reach for once there are migrations past 001-003
  that a fresh-volume container never saw (there are 12 as of this writing —
  see `docs/DATABASE_SCHEMA.md` §3). Do not hand-run individual
  `psql -f .../NNN_*.sql` files against an already-initialized database: the
  ledger runner won't know they were applied, and a file like
  `002_seed_data.sql` would insert its fixtures a second time.

---

## 3. Starting the Stack in Local Development Mode

```bash
# Terminal 1: Start Database Container
docker compose up -d db

# Terminal 2: Backend Express & WebSockets Server (Port 6501)
npx tsx server.ts

# Terminal 3: Frontend Vite Development Server (Port 6500)
npm run dev
```

- **Root Landing Page**: `http://localhost:6501/` (or `http://localhost:6500/` in dev)
- **Guest Mobile Experience**: `http://<your-lan-ip>:6501/e/monika-and-alexander-2026`
- **Venue Projector TV Screen**: `http://localhost:6501/e/monika-and-alexander-2026/tv`
- **Host & Planner Studio**: `http://localhost:6501/host`
- **Backend API & Health Check**: `http://localhost:6501/api/health`
