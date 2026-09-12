# 📡 WedMoments — Complete API Reference

All endpoints are served from the API root (Default: `http://localhost:6501` or `/api` via Vite dev proxy).

---

## 1. Authentication Endpoints

### `POST /api/auth/register`
Creates a host account, generates an initial wedding event, seeds default scavenger quests, and returns a signed JWT.
- **Rate Limit**: 25 requests / 15 minutes
- **Request Body**:
```json
{
  "email": "gergana.dimitrova@weddings.bg",
  "fullName": "Гергана Димитрова",
  "password": "securePassword123",
  "role": "planner",
  "companyName": "Сватбена Агенция Димитрова & Ко."
}
```
- **Response** `201 Created`:
```json
{
  "user": { "id": "uuid", "email": "...", "fullName": "...", "role": "planner" },
  "event": { "id": "uuid", "slug": "gergana-dimitrova-2026", "title": "Сватбата на Гергана" },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### `POST /api/auth/login`
Authenticates host by email and password, returns user profile, wedding event, and signed JWT.
- **Request Body**: `{ "email": "host@example.com", "password": "your-password" }`
- **Response** `200 OK`: `{ "user": {...}, "event": {...}, "token": "..." }`

### `GET /api/auth/me`
Fetches authenticated host profile and linked event.
- **Headers**: `Authorization: Bearer <JWT>`
- **Response** `200 OK`: `{ "user": {...}, "event": {...} }`

### `PUT /api/auth/me`
Updates the host's own account profile. Email is intentionally not
editable through this route — it's how the host signs in, and there is no
email-change/re-verification flow.
- **Headers**: `Authorization: Bearer <JWT>`
- **Request Body**: `{ "fullName": "Кирил и Мадалина" }`
- **Response** `200 OK`: `{ "user": {...} }`

### `POST /api/auth/logout`
Ends the account's sessions for real, by incrementing `users.token_version`
(migration 019). Every token minted before this call stops working immediately.
- **Headers**: `Authorization: Bearer <JWT>`
- **Response** `204 No Content`
- **Response** `401` — unauthenticated
- **This is "sign out everywhere", deliberately.** A host presses logout
  precisely because someone else may have access to a device, and ending only
  the session that happens to be asking would miss the one they are worried
  about.
- Clearing localStorage on the client is **not** a substitute: it stops that
  browser presenting the token but leaves it valid for the rest of its
  `JWT_EXPIRES_IN` window (7 days by default). `authService.logout()` therefore
  sends this request *before* clearing local state, and clears it either way —
  a user signing out on a shared laptop must never stay signed in because the
  network hiccuped.
- Any request presenting a superseded token gets
  `401 { "code": "SESSION_REVOKED" }`, which the client can tell apart from an
  ordinary expiry.

---

## 2. Wedding Event Endpoints

### `GET /api/events/showcase/feed`
Returns public showcase weddings with live preview photo ribbons for the homepage social proof feed.
- **Response** `200 OK`:
```json
[
  {
    "id": "uuid",
    "slug": "monika-and-alexander-2026",
    "title": "Сватбата на Моника и Александър",
    "host_name": "Моника и Александър",
    "event_date": "2026-09-18T16:30:00.000Z",
    "venue_name": "Резиденция Бояна, София",
    "cover_image_url": "https://...",
    "photos_count": 54,
    "guests_count": 88,
    "previewPhotos": [
      {
        "id": "uuid",
        "thumbnail_url": "https://...",
        "full_url": "https://...",
        "caption": "Вече сме семейство! Най-вълнуващата церемония!"
      }
    ]
  }
]
```

### `GET /api/events/slug/:slug`
Resolves event configuration by URL slug (e.g. `monika-and-alexander-2026`).

### `GET /api/events/:id`
Retrieves event details by UUID.

### `PUT /api/events/:id`
Updates wedding event configuration (moderation toggles, theme, venue name, countdown).
- **Headers**: `Authorization: Bearer <JWT>`
- **Request Body**:
```json
{
  "title": "Сватбата на Моника и Александър",
  "themePalette": "champagne_gold",
  "isModerationEnabled": true,
  "isDisposableMode": false,
  "maxPhotosPerGuest": 50
}
```

### `POST /api/events/:id/reactions`

Broadcast an ephemeral live reaction to everyone watching the event, including the
projector wall. Nothing is persisted.

```json
{ "reaction": "heart", "guestName": "Silvia" }
```

`reaction` is one of `heart`, `clap`, `cheers`, `laugh`, `party`.
Responds `202 Accepted`. Rate limited to 30 per minute **per device**
(falls back to per-IP only when no device fingerprint is supplied).

### `GET /api/events/:id/qr-config`
Retrieves printable poster canvas settings for A2/A3/Table cards.

### `PUT /api/events/:id/qr-config`
Updates printable canvas framing, typography, and accent colors.
- **Headers**: `Authorization: Bearer <JWT>`

### `POST /api/events/:id/export-token`

Host only, Celebration Pass or higher. Returns a five-minute token plus the
suggested filename:

```json
{ "token": "eyJ...", "expiresIn": 300, "filename": "monika-and-alexander-2026-memories.zip" }
```

The browser cannot put an `Authorization` header on a plain `<a href>`, and
buffering the archive into a Blob first holds gigabytes in memory. This token
lets the download stream straight to disk. It is bound to one event and one
user, and an ordinary session JWT is not accepted in its place.

### `GET /api/events/:id/export-zip`
Streams a high-resolution `.zip` archive of all wedding photos and audio recordings.

---

## 3. Photo Feed & Upload Endpoints

> `POST /api/photos/upload/raw` existed in an earlier revision and has been
> **removed** (OPEN_ITEMS.md SEC-02): it wrote bytes to storage without ever
> inserting a `photos`/`audio_guestbook` row, so `storage_bytes` accounting —
> which only increments on those inserts — never saw the bytes. Every upload
> path below writes storage and its DB row together.

### `GET /api/photos?eventId=:id&limit=50&cursor=:cursor`
Retrieves photos for an event (ordered `priority DESC, created_at DESC`),
including nested comments and like arrays. `cursor` is the composite
`"priority:isoTimestamp"` pair returned alongside the previous page — a plain
timestamp cursor (the original shape) silently skipped photographer-priority
photos across a page boundary (OPEN_ITEMS.md DB-03), so it is no longer
accepted on its own. `originalUrl` is nulled out for non-host requests
(OPEN_ITEMS.md MED-02 — camera originals can carry embedded GPS EXIF data).

### `POST /api/photos`
Creates photo record, checks guest photo limits, saves image, and broadcasts `PHOTO_ADDED`.
- **Request Body**:
```json
{
  "eventId": "uuid",
  "guestId": "uuid",
  "guestName": "Силвия Георгиева",
  "fullUrl": "data:image/jpeg;base64,...",
  "caption": "Най-красивата булка на света! Честито!",
  "filterApplied": "vintage_warmth",
  "questId": "optional-quest-uuid",
  "deviceFingerprint": "dev-...",
  "guestToken": "optional — proves a client-supplied guestId (OPEN_ITEMS.md SEC-A2)"
}
```
`fullUrl`/`thumbnailUrl`/`originalUrl` must be `data:` URLs — an already-stored
`/uploads/...` or R2 path is rejected (SEC-A1), since accepting one would let a
caller plant another event's file as their own and pull it back out through
their own `export-zip`. `deviceFingerprint` cannot be the reserved values
`photographer` or `system`.

### `POST /api/photos/:id/like`
Toggles guest like on photo in `photo_likes` table and broadcasts `PHOTO_LIKED` / `PHOTO_UNLIKED`.
- **Request Body**: `{ "guestId": "uuid", "guestToken": "optional" }`
- `403` unless the photo is `approved`/`featured` and (not disposable-locked, or
  the event's reveal time has passed) — OPEN_ITEMS.md SEC-W4.

### `POST /api/photos/:id/reactions`
Toggles one emoji reaction in `photo_reactions`, independent of the others —
unlike `/like`'s single boolean, a guest can hold several different
`reaction` kinds on the same photo at once (Slack-style), and broadcasts
`PHOTO_REACTION_ADDED` / `PHOTO_REACTION_REMOVED`.
- **Request Body**: `{ "reaction": "heart", "guestId": "uuid", "guestToken": "optional" }`
- `reaction` is one of `heart`, `clap`, `cheers`, `laugh`, `party` — the same vocabulary as the ambient live-reaction bar (`POST /api/events/:id/reactions`).
- Same moderation/reveal gate and guest-identity proof as `/like` above.
- **Response** `200 OK`: `{ "success": true, "photoId": "uuid", "reaction": "heart", "isActive": true }`

### `POST /api/photos/:id/comments`
Inserts comment in `photo_comments` table and broadcasts `COMMENT_ADDED`.
- **Request Body**: `{ "guestId": "uuid", "guestName": "Мартин Василев", "commentText": "Истинска магия!", "guestToken": "optional" }`
- Same moderation/reveal gate as `/like` above.

### `POST /api/photos/:id/status`
Host moderation status change (`approved` | `pending` | `rejected` | `featured`).
- **Headers**: `Authorization: Bearer <JWT>`
- **Request Body**: `{ "status": "approved" }`

### `DELETE /api/photos/:id`
Host photo removal (deletes DB record, removes physical file, broadcasts `PHOTO_REMOVED`).
- **Headers**: `Authorization: Bearer <JWT>`

---

## 4. Scavenger Quests Endpoints

### `GET /api/events/:id/quests`
Lists scavenger photo challenges and guest completion lists.

### `POST /api/events/:id/quests`
Creates new photo challenge (Host Only).
- **Headers**: `Authorization: Bearer <JWT>`
- **Request Body**: `{ "title": "Танци на дансинга", "description": "Снимайте някой, който взривява дансинга", "points": 20 }`

### `DELETE /api/quests/:id`
Removes photo challenge (Host Only).
- **Headers**: `Authorization: Bearer <JWT>`

### `POST /api/quests/:id/complete`
Records quest completion by attendee.
- **Request Body**: `{ "guestId": "uuid", "photoId": "optional-uuid", "guestToken": "optional" }`

---

## 5. Audio Guestbook Endpoints

### `POST /api/audio`
Saves voice message recording, writes audio to storage, and broadcasts `AUDIO_ADDED`.
- **Tier Gated**: Requires `deluxe_keepsake` or `pro_planner` plan.
- **Request**: `multipart/form-data`, not JSON — an earlier JSON `{ audioUrl: "data:..." }`
  shape was replaced (OPEN_ITEMS.md SEC-M3/P7): the byte-inspection magic-byte
  check needs the real uploaded bytes, not a client-claimed MIME type or an
  already-hosted URL string handed straight through.
  - **Fields**: `audio` (binary file field, WebM/MP4/OGG, up to `MAX_UPLOAD_SIZE_MB`),
    `eventId`, `guestId`, `guestName`, `guestAvatar`, `durationSeconds`, `note`,
    `localId`, `guestToken` (all as regular form fields alongside `audio`)

### `GET /api/audio?eventId=:id`
Lists audio recordings for the event. For a non-host request, returns `[]`
before the event's disposable-mode reveal time if disposable mode is on
(OPEN_ITEMS.md SEC-07 — mirrors the same reveal gate photos already had).

---

## 6. Guest Profile Endpoints

### `POST /api/guests`
Registers or updates guest attendee profile with `deviceFingerprint` persistence.
- **Request Body**: `{ "eventId": "uuid", "name": "Силвия и Георги", "tableNumber": "Маса 4", "deviceFingerprint": "dev-..." }`
- `deviceFingerprint` cannot be the reserved values `photographer` or `system`
  (OPEN_ITEMS.md SEC-A2). The response's `guestToken` is only issued when this
  request actually created the row or the caller already held a valid token
  for it — a bare fingerprint match onto an *existing* guest no longer mints a
  fresh, durable credential for that identity (OPEN_ITEMS.md SEC-03).

### `GET /api/guests?eventId=:id&deviceFingerprint=:hash`
Rehydrates returning guest profile without requiring password or cookie
login. Rate limited (OPEN_ITEMS.md SEC-06) and never returns a `guestToken` —
this is a pure lookup by a client-generated, non-secret fingerprint value, not
proof of identity.

---

## 7. Subscription & Billing Endpoints

### `POST /api/billing/checkout-session`
Creates a real Stripe Checkout Session for a paid tier. Changes nothing in
the database itself — the tier is only ever written from the webhook below,
once Stripe confirms the payment actually happened.
- **Headers**: `Authorization: Bearer <JWT>`
- **Request Body**: `{ "tier": "celebration_pass" | "deluxe_keepsake" | "pro_planner", "successUrl": "https://...", "cancelUrl": "https://..." }`
  - `successUrl`/`cancelUrl` must resolve to an origin in `CORS_ORIGIN` **or** to `PUBLIC_BASE_URL` (open-redirect guard, since the client supplies them). The check is default-deny: an unrecognised origin is rejected, including when `CORS_ORIGIN` is blank.
  - Pricing comes from `STRIPE_PRICE_*` when all three are set; otherwise from an ad-hoc `price_data` line item matching `src/config/plans.ts` exactly (49 €/89 €/49 € per month), so no Stripe Dashboard product needs to exist first.
- **Response** `200 OK`: `{ "url": "https://checkout.stripe.com/..." }` — redirect the browser here.
- **Response** `400`, `"Invalid redirect URL"` — `successUrl`/`cancelUrl` origin not allowed.
- **Response** `400`, `code: "ALREADY_SUBSCRIBED"` — a `pro_planner` checkout while a subscription that Stripe still reports as live is on file. One-time passes are never blocked, and a stored id Stripe no longer recognises is treated as stale and allowed through, so a missed cancellation webhook cannot lock a customer out permanently.
- **Response** `503`, `code: "STRIPE_NOT_CONFIGURED"` — while `STRIPE_SECRET_KEY` isn't set (`server/lib/stripe.ts`). The pricing modal catches this specific code and falls back to `POST /api/subscriptions/upgrade` below automatically.

### `POST /api/billing/webhook`
Stripe calls this directly — never called by the app's own frontend. Verifies
the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`, then writes the
tier for real — the only place that happens. Mounted with a raw body parser
ahead of the global JSON middleware, since Stripe's signature check needs the
exact original bytes. Implemented in `server/routes/billingWebhook.ts`.

Each event is handled in one transaction that takes a `pg_advisory_xact_lock`
keyed on the Stripe customer, claims the event id in `stripe_webhook_events`,
then applies it. A throw rolls back all three — which un-claims the event, so
genuine failures stay retryable — and returns `500` so Stripe retries. A
re-delivery finds the claim taken and commits nothing.

**Which tier a purchase grants.** With `STRIPE_PRICE_*` configured, the tier
comes from the Stripe Price the customer was charged against, read back via
`checkout.sessions.listLineItems`, and the session's `metadata.tier` must
agree — a mismatch, an unknown Price, or a session mixing two known tiers all
grant nothing and log loudly. Without the Price map, the tier comes from
metadata alone. The Price is authoritative because metadata is a free-form
string editable from the Stripe Dashboard.

Subscribe the Dashboard endpoint to exactly these — anything else is ignored:

| Event | Effect |
|---|---|
| `checkout.session.completed` | Grants the paid tier — **only** when `payment_status` is `paid`/`no_payment_required`. A delayed method (SEPA) completes the session before the money settles, so this alone is not proof of payment. |
| `checkout.session.async_payment_succeeded` | Grants the tier once a delayed payment settles. |
| `checkout.session.async_payment_failed` | Logged; no tier granted. |
| `invoice.paid` | Monthly renewal (`billing_reason: subscription_cycle` only). Re-applies the current tier, which is what refreshes event retention deadlines — without it a paying subscriber's photos keep the expiry stamped at first purchase. |
| `customer.subscription.updated` | Terminal status (`canceled`, `unpaid`, `incomplete_expired`) downgrades. `past_due` keeps the tier and stamps `past_due_grace_expiry` at `SUBSCRIPTION_GRACE_DAYS` out (never extended by later retry failures); past that deadline it downgrades. `active`/`trialing` clears the deadline. `cancel_at_period_end` keeps the tier — the customer paid through the period, and `deleted` arrives when it ends. |
| `customer.subscription.deleted` | Downgrades the account to `free` and clears `stripe_subscription_id`. |

Subscription events resolve the account from `metadata.userId` first, falling
back to a lookup on the stored `stripe_subscription_id`. The fallback matters
for any subscription not created by this app's checkout (Dashboard-created, or
re-created by a Billing Portal plan change), which carries no metadata.

- **Response** `503` — Stripe or `STRIPE_WEBHOOK_SECRET` not configured. Deliberately not a `4xx`: Stripe stops retrying after a `4xx`, which would permanently drop paid checkouts that arrived during the misconfiguration.
- **Response** `400` — missing signature header, or signature verification failed.
- **Response** `500` — handler failure, so Stripe retries.

### `POST /api/subscriptions/upgrade`
Sets the caller's plan tier directly in the `subscriptions` table, with no
payment behind it.
- **Headers**: `Authorization: Bearer <JWT>`
- **Request Body**: `{ "tier": "free" | "celebration_pass" | "deluxe_keepsake" | "pro_planner" }`
- **Response** `403`, `code: "CHECKOUT_REQUIRED"` — a **paid** tier requested while `STRIPE_SECRET_KEY` is set. Setting that key is what makes payment mandatory: without this gate any authenticated user could POST themselves a free upgrade and bypass Stripe entirely. `"free"` is always allowed — giving something up involves no payment.
- **This is the pre-Stripe fallback, not the primary path.** It stays
  reachable for two reasons: the pricing modal falls back to it automatically
  while Stripe isn't configured yet (so local dev/demos work with zero
  setup), and downgrading to `free` never needs a payment step regardless of
  Stripe's configuration. See `server/routes/subscriptions.ts` and
  OPEN_ITEMS.md SEC-05/P1 for the fuller history — it originally existed to
  close a worse bug (the client showed a fake "upgraded" UI that reverted on
  reload).

---

## 8. Photographer Ingest Endpoints

All ingest endpoints authenticate with a revocable, event-scoped ingest key (`wmi_…`)
generated in the Host Studio — see `docs/PRO_PHOTOGRAPHER_INGEST.md`.

### `POST /api/ingest/keys`
Creates/rotates an ingest key for an event (Host JWT required).
- **Request Body**: `{ "eventId": "uuid", "label": "Studio X" }`
- **Response** `201`: `{ id, eventId, label, createdAt, ..., key: "wmi_…" }` (plaintext shown once)

### `GET /api/ingest/keys?eventId=:id`
Lists (masked) ingest keys for the event (Host JWT required).

### `DELETE /api/ingest/keys/:id`
Revokes an ingest key (Host JWT required).

### `POST /api/ingest/:eventId/photos`
Uploads professional photos (multipart, repeatable `file` field). Auth via
`Authorization: Bearer wmi_…`, `X-Ingest-Key: wmi_…`, or `?key=wmi_…`.
- **Form fields**: `file` (JPEG/PNG/WebP/GIF), `photographerName` (optional), `caption` (optional)
- **Response** `201`: `{ success, uploaded, photos }` — each photo is `approved`,
  `source: "photographer"`, `priority: 10`, and broadcast as `PHOTO_ADDED`.

---

## 9. System Health Endpoint

### `GET /api/health`
Returns server operational status, connected WebSocket clients count, and storage provider.
