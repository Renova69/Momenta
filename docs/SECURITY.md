# 🔒 WedMoments — Security & Access Control

## 1. Authentication & Tier Architecture

WedMoments implements a multi-role access and tier-gated security model:
1. **Zero-Friction Guest Access**: Guests join anonymously by scanning QR codes (`/e/:slug`). They are assigned a client session and persistent `deviceFingerprint` without needing passwords or app store installs.
2. **Secured Host Studio**: Wedding couples and planners log in via `/host` and receive cryptographic JSON Web Tokens (JWT) signed with `HS256`. `jwt.verify()` pins `{ algorithms: ['HS256'] }` on every call — an unpinned `verify()` would accept whatever algorithm the token itself claims (OPEN_ITEMS.md SEC-A5).
3. **Server-Side Tier Gating**: Server middleware validates plan tiers before allowing access to premium features (such as Audio Guestbook, custom domains, or extended limits).

```
Host Login / Register -> bcrypt verification -> JWT Token issued -> Authorization: Bearer <token> -> Protected Host Routes
```

---

## 2. Protected Routes & Tier Matrix

| Endpoint | Method | Guest Access | Host Auth Required (`requireAuth`) | Tier Gate Enforcement |
| :--- | :--- | :--- | :--- | :--- |
| `/api/auth/register` | POST | ✅ Public | ❌ | ❌ |
| `/api/auth/login` | POST | ✅ Public | ❌ | ❌ |
| `/api/auth/me` | GET | ❌ | ✅ Bearer Token | ❌ |
| `/api/events/showcase/feed` | GET | ✅ Public | ❌ | ❌ |
| `/api/events/slug/:slug` | GET | ✅ Public | ❌ | ❌ |
| `/api/events/:id` | PUT | ❌ | ✅ Bearer Token | 🔒 Per field — see below |
| `/api/events/:id/qr-config` | GET | ✅ Public | ❌ | ❌ |
| `/api/events/:id/qr-config` | PUT | ❌ | ✅ Bearer Token | 🔒 `celebration_pass`+ |
| `/api/events/:id/reactions` | POST | ✅ Public | ❌ | ❌ (rate limited, nothing persisted) |
| `/api/events/:id/export-token` | POST | ❌ | ✅ Bearer Token (owner) | 🔒 `celebration_pass`+ |
| `/api/events/:id/export-zip` | GET | ❌ | ✅ Bearer Token **or** download token | 🔒 `celebration_pass`+ |
| `/api/events/:id/usage` | GET | ❌ | ✅ Bearer Token (owner) | ❌ |
| `/api/photos` | GET | ✅ Public (scoped) | ❌ | Non-hosts see approved/featured only, `originalUrl` nulled |
| `/api/photos` | POST | ✅ Public | ❌ | Free-tier photo cap + `max_photos_per_guest`; guest identity via `guestToken` |
| `/api/photos/:id/status` | POST | ❌ | ✅ Bearer Token | ❌ |
| `/api/photos/:id` | DELETE | ❌ | ✅ Bearer Token | ❌ |
| `/api/events/:id/quests` | POST | ❌ | ✅ Bearer Token | 🔒 `celebration_pass`+ |
| `/api/quests/:id` | DELETE | ❌ | ✅ Bearer Token | ❌ |
| `/api/audio` | POST | ✅ Public (multipart) | ❌ | 🔒 `deluxe_keepsake`+; guest identity via `guestToken` |
| `/api/audio` | GET | ✅ Public (scoped) | ❌ | Non-hosts see `[]` before reveal time in disposable mode |
| `/api/subscriptions/upgrade` | POST | ❌ | ✅ Bearer Token | No payment gateway — see below |
| `/api/ingest/keys` | POST / GET / DELETE | ❌ | ✅ Bearer Token (owner) | ❌ |
| `/api/ingest/:eventId/photos` | POST | ❌ | ✅ Ingest key (header only) | Free-tier photo cap |

> `/api/photos/upload/raw` existed in an earlier revision and was **removed**
> (OPEN_ITEMS.md SEC-02): it wrote bytes to storage without ever inserting the
> DB row that `storage_bytes` accounting depends on, so uploads through it
> were permanently invisible to quota enforcement.

> `POST /api/subscriptions/upgrade` sets the caller's own tier directly, with
> **no payment verification behind it** (OPEN_ITEMS.md SEC-05/P1,
> `STORAGE_AND_FINANCIAL_PLAN.md` §8). It exists only to stop the client from
> showing a fake "upgraded" state that reverted on reload; replace its trigger
> with a verified payment webhook before charging real users.

### Tier-gated event settings

`PUT /api/events/:id` refuses these fields below the required tier, regardless of
what the client interface allows:

| Field | Requires |
| :--- | :--- |
| `isModerationEnabled` | `celebration_pass` |
| `themePalette` (anything but `champagne_gold`) | `celebration_pass` |
| `isDisposableMode`, `revealAt` | `deluxe_keepsake` |

Entitlement is read from the `subscriptions` table only. The denormalised
`events.plan_tier` column is never trusted for an access decision, and no route
lets a client write its own tier.

---

## 3. Security Protections Implemented

### 1. Cryptographic Password Hashing
- Passwords are salted and hashed using `bcryptjs` with work factor 10.
- Raw passwords and `password_hash` fields are strictly hidden from API responses.

### 2. Magic Byte File Signature Verification
- In addition to MIME type checks, all incoming binary uploads are inspected at the byte level for authentic image/audio headers (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP, MP4 `ftyp`, MP3 `ID3`/sync frames). Executable formats (ELF, DOS PE) are rejected immediately.

### 3. Path Traversal Containment
- Disk storage operations enforce absolute path containment within the designated upload directory, preventing directory traversal attacks (`../`).

### 4. Rate Limiting & DoS Protection
- **Upload Rate Limiting**: `uploadLimiter` restricts uploads to 20 requests per minute **per device** (keyed on `deviceFingerprint`, falling back to IP only when none is supplied) — a wedding is the pathological case for a per-IP budget, since 80 guests behind one venue NAT would otherwise share a single ceiling. `uploadIpLimiter` layers a 600 requests per minute **per-IP** backstop on top, sized for a large reception in full flow rather than for one person.
- **Auth Brute Force Protection**: `authLimiter` limits login/register attempts to 25 requests per 15 minutes per IP address.
- **Reaction Rate Limiting**: `reactionLimiter` caps live reaction taps at 30 per minute per device.
- **API Read Limiting**: `apiLimiter` caps general `/api` traffic at 3000 requests per minute — sized per venue (feed loads, likes, comments, gallery refreshes for the whole reception), not per person.

### 5. Input Validation via Zod Schemas
- All JSON request payloads (`CreatePhotoSchema`, `RegisterSchema`, `UpdateEventSchema`, `QRConfigSchema`, `CreateQuestSchema`, `CompleteQuestSchema`, `RegisterGuestSchema`, `UpgradeSchema`) are strictly validated against strongly-typed Zod schemas before reaching business logic or SQL queries. `POST /api/audio` is multipart (binary `audio` field), so its fields are validated manually against the actual uploaded bytes (magic-byte check) rather than through a JSON body schema.

### 6. Parameterized SQL Queries
- All database queries use PostgreSQL parameterized placeholders (`$1`, `$2`, `$3`) to completely prevent SQL injection attacks.

### 7. Multi-Tenant WebSocket Room Isolation
- Upgrades are checked against `CORS_ORIGIN` before the socket is accepted; CORS
  headers do not apply to WebSockets, so this is enforced explicitly. An unset
  `CORS_ORIGIN` fails **closed** (rejects cross-origin upgrades) rather than
  open — the reverse used to allow any third-party page to open a socket to
  this server out of the box (OPEN_ITEMS.md SEC-A4).
- The host session JWT travels in an `AUTH` message sent right after the socket
  opens, not in the connection URL's query string — a `?token=` ends up in
  access logs, proxy logs, and browser history (OPEN_ITEMS.md SEC-A5).
- Clients joining a room with `JOIN_EVENT_ROOM(eventId)` receive only that event's
  broadcasts. Per-connection messages are rate-limited (20 / 10s) and
  `JOIN_EVENT_ROOM`'s host-ownership check is cached for 60s rather than
  re-querying the database on every message (OPEN_ITEMS.md SEC-D6). A slow
  consumer whose send buffer exceeds 512KB is disconnected instead of being
  allowed to accumulate unbounded server memory (OPEN_ITEMS.md DB-04).
- Room membership is deliberately unauthenticated — guests arrive by scanning a QR
  code — so anything guests must not see goes to hosts only:
  - photos awaiting moderation are broadcast to verified hosts, never to the room;
  - `EVENT_UPDATED` carries a public projection of the event, without
    `host_email` or `host_user_id`.

### 8. Stored URLs
- Absolute media URLs are built from `PUBLIC_BASE_URL`, never from the request's
  `Host` header. These values are persisted on the photo and audio rows, so a
  forged header would otherwise write an attacker-chosen origin into data served
  to every guest.

### 9. Storage quotas and retention

- Every upload path charges its real byte footprint against the plan's allowance
  before writing, and is refused with `STORAGE_LIMIT_REACHED` when the plan is
  spent. Usage is a trigger-maintained running total, so the check is O(1).
- Album retention deadlines are computed from the plan and stamped on the event.
  Deletion is opt-in: the sweep reports by default and only removes media past a
  30-day grace period when `RETENTION_ENFORCED=true` is set explicitly.

### 10. Download tokens

- A browser cannot attach an `Authorization` header to a plain `<a href>`, so the
  ZIP export uses a signed token in the URL. Buffering the archive client-side
  instead would hold gigabytes in memory and fails outright on a phone.
- The token expires in five minutes, carries a `purpose` claim, and is bound to a
  single event and user. An ordinary session JWT is rejected, and a token minted
  for one event will not open another.
- This is deliberately narrower than the ingest keys below, which are refused
  from query strings entirely: those are long-lived and grant *write* access.
- The reverse direction — this token replayed *as* a session token — is what
  §11 below closes.

### 11. Session token purpose pinning
- Session JWTs, download tokens, and guest tokens are all signed with the same
  `JWT_SECRET`, distinguished only by a `purpose` claim (or its absence).
  `requireAuth`/`optionalAuth` and the WebSocket `AUTH` handler call
  `isSessionTokenPayload()`, which rejects any decoded payload carrying a
  `purpose` field or missing `email` — a real session token never sets
  `purpose` and always carries `email`; download and guest tokens are the
  opposite on both counts. Without this, a five-minute export-zip download
  token (which itself carries a real `userId`, and travels in a URL query
  string where it can end up in logs) could be replayed as `Bearer <token>`
  for full host-session equivalence (OPEN_ITEMS.md SEC-01).

### 12. Guest identity tokens
- A `guestToken` (`server/lib/guestAuth.ts`) binds a browser to the specific
  guest row it created or resolved, and is required (matching the claimed
  `guestId`) for likes, comments, quest completions, photo uploads, and audio
  entries. A `guestId` alone is not proof of identity — every photo/comment
  response includes it, so it is public, not secret (OPEN_ITEMS.md SEC-A2).
- A token is only issued when a request actually created the guest row, or the
  caller already held a valid token for it. A bare `deviceFingerprint` match
  onto an *existing* guest no longer mints a fresh, durable credential for
  that identity — fingerprints are client-generated and non-secret, so
  minting one from a match alone would let anyone who observed a fingerprint
  (a shared device, a log) take over that guest's identity indefinitely
  (OPEN_ITEMS.md SEC-03).
- `RESERVED_DEVICE_FINGERPRINTS` (`photographer`, `system`) are rejected at
  both `POST /api/guests` and `POST /api/photos` — the official photographer
  badge is resolved by exactly this fingerprint elsewhere in the pipeline, and
  an unauthenticated guest supplying it would overwrite that profile.
- Every guest-scoped lookup (likes, comments, uploads, quest completions,
  audio entries) filters `WHERE id = $1 AND event_id = $2` — a `guestId`
  harvested from one event cannot act as that guest in a different event
  (OPEN_ITEMS.md SEC-D3).

### 13. Photographer ingest keys
- Generated with 32 bytes of CSPRNG entropy, stored only as a SHA-256 hash, and
  returned in plaintext exactly once at creation.
- Accepted from the `Authorization` or `X-Ingest-Key` header only. Query-string
  keys are refused because they leak into access logs and proxy history. The
  host's shareable portal link carries the key in a URL *fragment*, which is
  never transmitted to a server.
- Scoped to a single event, revocable, and optionally expiring.
- The in-process FTP server sends credentials in the clear unless `FTP_TLS_CERT`
  and `FTP_TLS_KEY` are set; it logs a warning at startup when they are not.
