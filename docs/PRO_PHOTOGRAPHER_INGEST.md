# 📸 Professional Photographer Ingest

Bridge high-end DSLR/mirrorless photography with the live guest feed. Professional photos
are pushed to the venue's TV screens and the mobile guest gallery in real time, tagged with
an **Official Photographer** badge and given **high-priority placement** in the projector
rotation.

All pro-ingested photos are stored with `source = 'photographer'` and `priority = 10`, so they
sort ahead of guest snapshots in both the API feed and the live projector.

---

## 1. Event-scoped ingest keys

The Host Studio ("Photographer Ingest" tab) generates a revocable, event-scoped key
(`wmi_…`). Only its SHA-256 hash is stored; the plaintext is shown once at creation.
Keys can be revoked at any time and support optional expiry.

| Endpoint | Auth | Purpose |
| :--- | :--- | :--- |
| `POST /api/ingest/keys` | Host JWT | Create/rotate a key (returns plaintext once) |
| `GET /api/ingest/keys?eventId=` | Host JWT | List keys (masked) |
| `DELETE /api/ingest/keys/:id` | Host JWT | Revoke a key |

## 2. Ingest endpoint

```
POST /api/ingest/:eventId/photos
```

Authenticate with **one** of:

- `Authorization: Bearer wmi_…`
- `X-Ingest-Key: wmi_…`

Header-only, by design (`server/lib/ingest.ts`): a key passed as `?key=` ends
up in access logs, proxy history and browser referrers — a credential leak
that outlives the request. `extractIngestKeyFromRequest()` never reads the
query string, so a `?key=wmi_…` request is refused, not silently accepted.

Multipart form fields:

| Field | Type | Notes |
| :--- | :--- | :--- |
| `file` | file | Repeatable; JPEG/PNG/WebP/GIF, magic-byte validated |
| `photographerName` | text | Optional; defaults to `Official Photographer` |
| `caption` | text | Optional |

Response: `201` with `{ success, uploaded, photos: [...] }`.

Each photo is auto-approved and broadcast over WebSockets as `PHOTO_ADDED` with
`source: 'photographer'` and `priority: 10`.

---

## 3. Ingestion workflows

### A. In-camera FTP background transfer (in-process FTP server)
WedMoments ships an in-process FTP/FTPS server (`server/ftp/ftpServer.ts`). Enable it and
point the camera's native FTP profile (Sony, Canon, Nikon, Fujifilm) directly at the server:

```
FTP_ENABLED=true            # enable the in-process FTP server
FTP_PORT=2121               # FTP control port (default 2121)
FTP_PASV_URL=192.168.0.35   # server's reachable IP/hostname (passive mode behind NAT)
FTP_STAGING_DIR=ftp-staging # staging folder for camera uploads
# FTPS (AUTH TLS) — optional, provide both to enable:
FTP_TLS_CERT=/path/cert.pem
FTP_TLS_KEY=/path/key.pem
```

Camera FTP settings:

| Setting | Value |
| :--- | :--- |
| Protocol / host | `FTP_PASV_URL` (or the server IP) |
| Port | `FTP_PORT` (default `2121`) |
| Username | the **event id** (or the event slug) |
| Password | the **photographer ingest key** (`wmi_…`) |
| Transfer mode | Passive (PASV) |

Each shutter press writes the RAW to the SD card and silently streams a high-quality JPEG
to the FTP server, which ingests it (magic-byte validated, auto-approved, `source=photographer`,
`priority=10`) and broadcasts it to the live screen within seconds.

> Plain FTP should only be used on a trusted venue LAN. Enable FTPS (provide a cert/key) when
> the camera crosses a public network. Some cameras require you to import/trust the TLS
> certificate — a self-signed cert often triggers a trust warning, so a real cert is recommended.

### B. Tethered hot-folder synchronization
Configure Lightroom/Capture One to export selected or lightly graded images into a watched
directory:

```bash
INGEST_WATCH_DIR=/path/to/exports \
INGEST_API_URL=https://your-api-host \
INGEST_EVENT_ID=<event-uuid> \
INGEST_API_KEY=wmi_… \
npm run ingest:watch
```

The watcher (`scripts/ingest-watcher.ts`) is dependency-free (Node `fs` + `fetch`), polls the
folder, uploads new images, and moves them to a `.processed/` subfolder. It also registers an
`fs.watch` handler for instant pickup where supported.

### C. VIP Photographer Ingest Portal
A passwordless web portal for drag-and-drop batch uploads (e.g. between ceremony milestones):

```
https://<your-host>/e/<slug>/ingest#key=wmi_…
```

The Host Studio's "copy portal link" button always generates the `#key=`
**fragment** form, never a `?key=` query string — a fragment is never sent to
a server, so it never lands in access logs, proxy history, or the `Referer`
header the way a query parameter would. (`PhotographerIngestPortal.tsx` still
reads a `?key=` query parameter too, as a fallback for links generated before
this changed — but don't hand out new links shaped that way.)

The photographer inserts an SD card, drags dozens of images onto the page, and the portal
uploads them with multi-threaded parallelism (configurable concurrency) straight to the live
screen.
