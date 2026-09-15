# Database Schema Documentation

This schema is designed for PostgreSQL 14+ and is 100% compatible with local Docker PostgreSQL, Supabase, Neon, and AWS RDS.

---

## 1. Entity Relationship Overview

| Table Name | Description | Key Relationships |
| :--- | :--- | :--- |
| `users` | Host and planner accounts with bcrypt password hashes and roles. | Linked to `subscriptions` and `events` |
| `subscriptions` | SaaS event passes and planner subscriptions. | Belongs to `users` |
| `events` | Core wedding details, host settings, theme, moderation modes. | Belongs to `users`, Parent to photos/quests |
| `guests` | Event attendees who scan and join (zero-friction registration). | Belongs to `events` |
| `photos` | Uploaded images, status (approved/pending/featured), filters. | Belongs to `events`, `guests`, optional `scavenger_quests` |
| `photo_likes` | Likes given by guests to specific photos. | Many-to-Many between `guests` and `photos` |
| `photo_reactions` | Per-photo emoji reactions (heart/clap/cheers/laugh/party) — a guest can hold several kinds at once on the same photo, unlike the single-boolean `photo_likes`. | Many-to-Many between `guests` and `photos` |
| `photo_comments` | Guest comments and congratulations on photos. | Belongs to `photos` and `guests` |
| `scavenger_quests`| Photo challenges (e.g., "Dance floor moment", "First kiss"). | Belongs to `events` |
| `guest_quest_completions` | Tracks guest completion per challenge. | Belongs to `scavenger_quests`, `guests`, `photos` |
| `audio_guestbook`| Audio recordings / voice toasts left by guests. | Belongs to `events` and `guests` |
| `qr_canvas_configs` | Customizable print poster/canvas settings (A2, A3, Table cards). | Belongs to `events` |
| `photographer_ingest_keys` | Revocable, event-scoped keys for the professional photographer upload pipeline. | Belongs to `events` |
| `stripe_webhook_events` | Idempotency ledger of Stripe event ids already applied. | Standalone — keyed by Stripe's own event id |

---

## 2. Table Specifications

### `users`
- `id` (UUID, PK): `gen_random_uuid()`
- `email` (VARCHAR(255), UNIQUE): Host email address
- `password_hash` (VARCHAR(255), Nullable): bcrypt salted password hash
- `full_name` (VARCHAR(150)): Display name of host / planner
- `role` (VARCHAR(50)): `'couple'`, `'planner'`, `'venue'`, `'photographer'`
- `companyName` (VARCHAR(150), Nullable)
- `avatar_url` (TEXT, Nullable)
- `token_version` (INTEGER, NOT NULL, default 0 — migration 019): the session
  generation for this account. Every host JWT carries the version it was minted
  at, and `requireAuth`/`optionalAuth` reject a token whose version is behind
  this column. `POST /api/auth/logout` increments it, which is what makes
  signing out actually end the session — clearing localStorage alone left the
  token valid for the rest of its `JWT_EXPIRES_IN` window (7 days), so logging
  out on a shared machine hid the session without ending it. Incrementing is
  deliberately "sign out everywhere": someone presses logout precisely because
  another person may have access. Tokens issued before this migration carry no
  version and read as 0, matching the default, so existing sessions survive
  until their owner logs out.
- `created_at`, `updated_at` (TIMESTAMPTZ)
- `company_name` (VARCHAR(150), Nullable): Agency or studio name, for the
  Pro Planner tier where the account is a business rather than a couple.
- `email` is stored lowercased, and `idx_users_email_lower` enforces
  uniqueness on `lower(email)` (migration 026). The handlers normalise on the
  way in; the index is what makes that a guarantee rather than a convention.
  Before both existed, one person could hold two accounts that differed only
  by capitalisation, and a host who registered on a phone could be unable to
  sign in from a laptop.

### `subscriptions`
- `id` (UUID, PK): `gen_random_uuid()`
- `user_id` (UUID, FK -> `users.id` ON DELETE CASCADE)
- `tier` (VARCHAR(50)): `'free'`, `'celebration_pass'`, `'deluxe_keepsake'`, `'pro_planner'`
- `status` (VARCHAR(50)): `'active'`, `'canceled'`, `'past_due'`
- `billing_type` (VARCHAR(50)): `'one_time'`, `'monthly'`, `'annual'`
- `amount_paid_cents` (INT): e.g. `4900` (49.00 €)
- `currency` (VARCHAR(10)): `'EUR'`
- `event_limit` (INT): Number of simultaneous active events
- `storage_limit_gb` (INT): Storage quota
- `expires_at` (TIMESTAMPTZ, Nullable)
- `stripe_customer_id`, `stripe_subscription_id` (TEXT, Nullable — migration 016): set once a tier is applied via a real Stripe Checkout, so a later webhook event (Stripe only ever sends its own IDs) can be traced back to the account, and a recurring Pro Planner subscription can be looked up again for cancellation/dunning. `idx_subscriptions_stripe_subscription_id` is what makes that reverse lookup cheap; it is the fallback path for any subscription event arriving without `metadata.userId`.
  - Both columns `COALESCE` on upsert rather than overwrite — a write that doesn't carry an id must not erase one already on file. A one-time pass bought on top of a live subscription comes from a `mode: 'payment'` session with no subscription id, and blanking it there would strand the real subscription with nothing to match its eventual cancellation against. Only an actual cancellation clears `stripe_subscription_id`, via `applyTierDowngradeToFree()`.
- `past_due_grace_expiry` (TIMESTAMPTZ, Nullable — migration 018): deadline after which a `past_due` subscription loses its tier. Set when Stripe reports the first failed charge and never pushed forward by later retry failures, so a subscription retrying for weeks still expires. Cleared on recovery, purchase, or downgrade. `npm run grace:sweep` is the safety net for a dunning cycle that ends without another webhook.
- `created_at`, `updated_at` (TIMESTAMPTZ)
- **Partial unique index** on `(user_id) WHERE status = 'active'` (migration 009,
  OPEN_ITEMS.md SEC-D5) — a user can only ever have one active subscription
  row, and both `POST /api/subscriptions/upgrade` and the Stripe webhook
  (`server/lib/subscriptionUpgrade.ts`'s shared `applyTierUpgrade()`) upsert
  against exactly this index instead of a check-then-insert race.

### `stripe_webhook_events`
Idempotency ledger for `POST /api/billing/webhook` (migration 017).
- `event_id` (TEXT, PK): Stripe's own event id (`evt_…`)
- `event_type` (TEXT): e.g. `checkout.session.completed`
- `received_at` (TIMESTAMPTZ, default `NOW()`)
- The handler claims a row here **before** doing any work and deletes it again
  if the work throws, so a duplicate delivery is a no-op while a genuine
  failure stays retryable. Stripe re-delivers on any non-2xx, and the handler
  deliberately answers `500` on transient DB errors, so re-delivery is routine.
- Rows are only useful for as long as Stripe might still retry (days). Prune
  with `DELETE FROM stripe_webhook_events WHERE received_at < NOW() - INTERVAL '90 days';`
  — `idx_stripe_webhook_events_received_at` makes that cheap.

### `events`
Stores wedding/event settings and feature toggles.
- `id` (UUID, PK): Auto-generated unique identifier (`gen_random_uuid()`).
- `slug` (VARCHAR(100), UNIQUE): URL-friendly identifier for QR codes (e.g. `monika-and-alexander-2026`).
- `title` (VARCHAR(255)): Event title (e.g. "Сватбата на Моника и Александър").
- `host_name` (VARCHAR(150)): Name of the couple / host.
- `host_email` (VARCHAR(255)): Host email for notifications and dashboard access.
- `host_user_id` (UUID, FK -> `users.id` ON DELETE CASCADE, Nullable) — changed
  from `ON DELETE SET NULL` in migration 011 (OPEN_ITEMS.md SEC-D7): the old
  policy would have orphaned a host's events, live and public, with nobody
  able to manage them, the moment an account-deletion feature existed. No
  route deletes a user today, so this was unreachable in practice, but the
  policy itself was wrong regardless.
- `plan_tier` (VARCHAR(50)): `'celebration_pass'`
- `event_date` (TIMESTAMPTZ): Date and time of the event.
- `venue_name` (VARCHAR(255)): Physical venue or location.
- `cover_image_url` (TEXT): Hero cover image for landing view.
- `theme_palette` (VARCHAR(50)): Preset style (`champagne_gold`, `rose_blush`, `sage_green`, `classic_noir`).
- `welcome_message` (TEXT): Custom note displayed to guests when scanning QR.
- `is_moderation_enabled` (BOOLEAN): If true, photos require host approval before appearing on live projector.
- `is_disposable_mode` (BOOLEAN): If true, guest photos are locked until `reveal_at`.
- `reveal_at` (TIMESTAMPTZ, Nullable): Time when locked disposable photos are unlocked for all guests.
- `max_photos_per_guest` (INT): Limit per guest to prevent spam (default: 50).
- `storage_bytes` (BIGINT, default 0): Running total kept in sync by triggers
  on `photos`/`audio_guestbook` insert and delete (migration 008). `CHECK
  (storage_bytes >= 0)` since migration 010 (OPEN_ITEMS.md SEC-D2) — a
  guarantee against negative drift that survives a bug anywhere in the
  application call chain, not just at the call site that happened to be
  checked.
- `expires_at` (TIMESTAMPTZ, Nullable): Retention deadline, stamped at
  creation from the plan's window (migration 008). `npm run retention:report`
  reads this; `npm run retention:sweep` (opt-in via `RETENTION_ENFORCED=true`)
  deletes past it plus a 30-day grace period — see OPEN_ITEMS.md D1.
- `created_at`, `updated_at` (TIMESTAMPTZ).
- `is_public` (BOOLEAN, NOT NULL, default `false`): Whether the album appears
  on the public showcase feed. A privacy control, deliberately **not** tier-gated —
  publishing and withdrawing your own wedding is never a paid feature.
- `retention_notified_at` (TIMESTAMPTZ, Nullable): When the host was warned
  that the album is due for deletion, stamped only after a confirmed send that
  did not bounce. **The retention sweep will not delete an album whose value
  here is null or younger than 14 days** (`RETENTION_NOTICE_DAYS`), which is
  what makes notice a precondition in code rather than a line in a policy.

### `guests`
Lightweight guest profile (no password required).
- `id` (UUID, PK)
- `event_id` (UUID, FK -> `events.id` ON DELETE CASCADE)
- `name` (VARCHAR(150)): Display name (e.g., "Uncle Bob", "Sarah & Dave").
- `avatar_url` (TEXT, Nullable): Optional selfie avatar.
- `table_number` (VARCHAR(50), Nullable): e.g. "Table 4".
- `device_fingerprint` (VARCHAR(255), Nullable): Anonymous device hash to persist session without cookies. Never accepted as the reserved values `photographer` or `system` (OPEN_ITEMS.md SEC-A2).
- `is_vip` (BOOLEAN): VIP badge (e.g. wedding party / parents).
- `created_at` (TIMESTAMPTZ).
- Every read/write of a guest row scoped by client-supplied id (likes,
  comments, uploads, quest completions) additionally verifies `event_id`
  matches and, where identity matters, a signed `guestToken`
  (`server/lib/guestAuth.ts`) — see OPEN_ITEMS.md SEC-A2/SEC-03/SEC-D3.

### `photos`
Main photo entity.
- `id` (UUID, PK)
- `event_id` (UUID, FK -> `events.id` ON DELETE CASCADE)
- `guest_id` (UUID, FK -> `guests.id` ON DELETE CASCADE) — indexed since
  migration 012 (OPEN_ITEMS.md DB-10), so a guest/event cascade delete does an
  index lookup instead of a sequential scan.
- `quest_id` (UUID, FK -> `scavenger_quests.id` ON DELETE SET NULL, Nullable)
- `storage_path` (TEXT): Internal path in Cloudflare R2 / S3 / Supabase storage bucket. Display copy.
- `original_storage_path` (TEXT, Nullable): Untouched upload, since migration 007 — the
  paid "original quality" download. `originalUrl` in API responses is nulled
  for non-host requests (OPEN_ITEMS.md MED-02, embedded EXIF/GPS data).
- `thumbnail_url` (TEXT): Compressed preview URL for fast feed loading.
- `full_url` (TEXT): Full-resolution image URL.
- `caption` (TEXT, Nullable): Optional message attached to the photo.
- `status` (`photo_status` ENUM): `'pending'`, `'approved'`, `'rejected'`, `'featured'`.
- `is_locked` (BOOLEAN): True if disposable mode is active.
- `filter_applied` (VARCHAR(50)): Filter preset used (`original`, `vintage_warmth`, `golden_glow`, `black_white`).
- `likes_count` (INT): Auto-maintained counter cache via trigger.
- `comments_count` (INT): Auto-maintained counter cache via trigger.
- `storage_bytes` (BIGINT): Total bytes across display + original + thumbnail
  for this row (migration 008); drives the trigger-maintained
  `events.storage_bytes` running total. `CHECK (storage_bytes >= 0)` since
  migration 010. **Any code path that removes a photo must delete all three
  stored copies** — `toStoragePath()` normalizes the URL-valued columns, and
  `npm run storage:orphans` catches it if one was missed.
- `source` (VARCHAR(20)): `'guest'` (default) or `'photographer'`.
- `priority` (INT): Sort priority for feed/projector placement (pro photos = 10).
  Feed pagination cursors on `(priority, created_at)` as a composite pair, not
  `created_at` alone (OPEN_ITEMS.md DB-03).
- `photographer_name` (VARCHAR(150), Nullable): Credit for official photographer photos.
- `created_at` (TIMESTAMPTZ).
- `original_url` (TEXT, Nullable): Full-resolution URL for the paid original
  download. Nulled for non-host requests (OPEN_ITEMS.md MED-02 — embedded
  EXIF/GPS data).
- `original_bytes` (BIGINT, Nullable): Size of the untouched upload, recorded
  separately from `storage_bytes` so the original's share is known.
- `width` / `height` (INT, Nullable): Pixel dimensions of the display copy,
  derived at upload so the feed can reserve layout space before the image loads.
- `is_quarantined` (BOOLEAN, NOT NULL, default `false`): True while the photo's
  stored copies live under the quarantine prefix rather than a public path
  (MED-03/SEC-M5). Indexed, and set by both upload paths — a photo awaiting
  moderation must not merely be unlinked from the feed, it must be unreachable.
  Hosts see it through a short-lived, host-scoped preview token instead.

### `scavenger_quests` & `guest_quest_completions`
Gamification challenges to get guests taking creative photos.
- Quests table contains `title`, `description`, `icon_name`, `points`.
- Completions table records `(quest_id, guest_id, photo_id, completed_at)`.
- `is_active` (BOOLEAN, default `true`) on `scavenger_quests`: A retired quest
  stops being offered without deleting the completions already earned against it.

### `audio_guestbook`
- Stores voice messages (`audio_url`, `duration_seconds`, `note`) left by guests.
- `guest_id` (UUID, FK -> `guests.id`) indexed since migration 012 (OPEN_ITEMS.md DB-10).
- `storage_bytes` (BIGINT): Same accounting/`CHECK (storage_bytes >= 0)`
  treatment as `photos.storage_bytes` (migrations 008, 010).

### `qr_canvas_configs`
- Stores printable design templates (`A2`, `A3`, `TABLE_CARD`), framing styles, and custom typography.
- Unique index on `event_id`; `PUT /api/events/:id/qr-config` upserts against
  it directly (`ON CONFLICT`) rather than a read-then-write UPDATE/INSERT pair
  (OPEN_ITEMS.md DB-08).
- `frame_style_type` enum: `minimal_gold`, `floral_vintage`, `modern_clean`, `boho_arch`, `double_border`, `art_deco` (the last two added in migration 014).
- `center_icon` (TEXT, default `'heart'`): which locally-bundled SVG icon sits in the QR code's excavated center — `heart`/`rings`/`camera`/`sparkle`/`none` (migration 013). Deliberately not a hotlinked image URL — see that migration's comment for why.
- `canvas_size` (`canvas_size_type` ENUM, default `'A2'`): `A2`, `A3`, `A4`,
  `TABLE_CARD` or `SQUARE_BANNER`.
- `headline` (VARCHAR(255)) and `subtext` (TEXT): The printed wording above and
  below the code.
- `accent_color` (VARCHAR(50), default `'#D4AF37'`): Frame accent.

### `photo_comments`
Guest messages attached to a photo.
- `id` (UUID, PK)
- `photo_id` (UUID, FK -> `photos.id` ON DELETE CASCADE)
- `guest_id` (UUID, FK -> `guests.id` ON DELETE CASCADE)
- `comment_text` (TEXT, NOT NULL): The message. Named `commentText` in API
  responses — not `text`, which is the shape most clients guess at.
- `created_at` (TIMESTAMPTZ)

### `photo_reactions`
- `(photo_id, guest_id, reaction)` with a UNIQUE constraint on all three — one guest can hold several different `reaction` values on the same photo simultaneously, each toggled independently via `POST /api/photos/:id/reactions`.
- `reaction` is `TEXT` with a `CHECK` constraint (`heart`/`clap`/`cheers`/`laugh`/`party`), not a Postgres enum — kept as plain text since the same vocabulary is already duplicated as a Zod enum in two other route files.
- Indexed on both `photo_id` (read path) and `guest_id` (cascade-delete performance, matching migration 012's precedent for `photo_likes`/`photo_comments`/`audio_guestbook`).

---

### `photographer_ingest_keys`
FTP and batch-ingest credentials for a photographer working an event
(migration 006).
- `id` (UUID, PK)
- `event_id` (UUID, FK -> `events.id` ON DELETE CASCADE)
- `label` (VARCHAR(100), default `'Photographer'`): Shown to the host so several
  keys can be told apart.
- `key_hash` (VARCHAR(64), NOT NULL): SHA-256 of the key. **The plaintext is
  returned once at creation and never again** — listing an event's keys shows
  them masked, because a credential a server can re-display is a credential a
  compromised server hands over.
- `last_used_at` (TIMESTAMPTZ, Nullable): Last successful authentication.
- `expires_at` (TIMESTAMPTZ, Nullable)
- `revoked_at` (TIMESTAMPTZ, Nullable): Set rather than deleting the row, so a
  revoked key stays auditable.

### `event_deletions`
One row per deleted album (migration 024). Written by `DELETE /api/events/:id`
and by the retention sweep.
- `id` (UUID, PK)
- `event_id` (UUID, NOT NULL): Not a foreign key — the row it referred to is gone.
- `slug` (VARCHAR(160), NOT NULL)
- `host_user_id` (UUID, FK -> `users.id` ON DELETE SET NULL)
- `photos_deleted` (INT, NOT NULL, default 0)
- `bytes_freed` (BIGINT, NOT NULL, default 0)
- `deleted_at` (TIMESTAMPTZ, NOT NULL, default `NOW()`)

Deliberately holds no personal content: enough to answer *was this album
deleted, when, and at whose request*, and nothing more. An erasure log that
retained the thing erased would defeat itself.

### `email_bounces`
Addresses that have refused mail (migration 025). Consulted before a retention
notice is sent, because a notice that bounced is not a warning — and an album
whose host cannot be reached must stay undeletable rather than be deleted on
the strength of mail nobody received.
- `email` (TEXT, PK)
- `kind` (TEXT, NOT NULL, CHECK `hard` | `soft`): `hard` is permanent — no such
  mailbox, domain does not exist — and blocks. `soft` is transient — mailbox
  full, greylisted — and is recorded without blocking, since the next run
  retrying is what a soft bounce means.
- `bounced_at` (TIMESTAMPTZ, NOT NULL, default `NOW()`)
- `detail` (TEXT, Nullable): Whatever the provider said, kept verbatim.
- `source` (TEXT, NOT NULL, default `'manual'`): Who reported it, so a wrong
  entry can be traced.
- `cleared_at` (TIMESTAMPTZ, Nullable): Set when a human has dealt with it.
  Clearing is deliberate and manual; nothing expires a hard bounce on its own,
  because "it has been a while" is not evidence an address works.

## 3. Migration History

| # | File | What it changed |
| :--- | :--- | :--- |
| 001 | `001_initial_schema.sql` | Base tables: users, events, guests, photos, quests, audio, qr_canvas_configs. |
| 002 | `002_seed_data.sql` | Demo/sample fixtures for local development. |
| 003 | `003_host_accounts_and_subscriptions.sql` | `subscriptions` table, `events.host_user_id` FK. |
| 004 | `004_fix_constraints_and_indexes.sql` | Constraint and index corrections. |
| 005 | `005_performance_and_fk_cleanup.sql` | Performance indexes, FK cleanup. |
| 006 | `006_pro_photographer_ingest.sql` | `photographer_ingest_keys`, `photos.source`/`priority`/`photographer_name`. |
| 007 | `007_originals_and_demo_accounts.sql` | `photos.original_storage_path` (the three-copies-per-photo model), demo accounts. |
| 008 | `008_storage_accounting_and_retention.sql` | `storage_bytes` columns + triggers, `events.expires_at` retention window. |
| 009 | `009_subscription_and_slug_integrity.sql` | Partial unique index: one active subscription per user (SEC-D5). |
| 010 | `010_storage_bytes_check_constraint.sql` | `CHECK (storage_bytes >= 0)` on events/photos/audio_guestbook (SEC-D2). |
| 011 | `011_host_delete_cascade.sql` | `events.host_user_id` FK: `ON DELETE SET NULL` → `ON DELETE CASCADE` (SEC-D7). |
| 012 | `012_guest_cascade_indexes.sql` | Indexes on `photo_likes.guest_id`, `photo_comments.guest_id`, `audio_guestbook.guest_id` (DB-10). |
| 013 | `013_qr_center_icon.sql` | `qr_canvas_configs.center_icon` — replaces a hotlinked (CORS-broken on export) QR center image with a selectable, locally-bundled icon key. |
| 014 | `014_qr_frame_styles.sql` | Adds `double_border`/`art_deco` to the `frame_style_type` enum. |
| 015 | `015_photo_reactions.sql` | `photo_reactions` table — per-photo emoji reactions, independent of `photo_likes`. |
| 016 | `016_stripe_billing.sql` | `subscriptions.stripe_customer_id`/`stripe_subscription_id` — real Stripe Checkout integration. |
| 017 | `017_stripe_webhook_events.sql` | `stripe_webhook_events` table — idempotency ledger so a Stripe re-delivery of an already-applied event is a no-op. |
| 018 | `018_subscription_grace.sql` | `subscriptions.past_due_grace_expiry` — dunning grace window, so a failed charge does not cut off a paying customer mid-event. |
| 019 | `019_session_revocation.sql` | `users.token_version` — server-side session revocation, so signing out invalidates the JWT instead of only clearing localStorage. |
| 020 | `020_storage_trigger_bulk_purge_guard.sql` | Lets a bulk purge skip per-row storage accounting without DDL (H5) — the purge fired one `UPDATE events` per deleted photo, thousands of row-locked writes against the same row. |
| 021 | `021_photos_is_quarantined.sql` | `photos.is_quarantined`, indexed — makes "is this photo still withheld?" a question the reveal sweep can ask cheaply (H4). |
| 022 | `022_event_public_showcase_optin.sql` | `events.is_public` — the public showcase becomes opt-in (H6). It returned the six newest albums to anyone before this. |
| 023 | `023_guest_token_revocation.sql` | `guests.token_version` — a revocation path for guest tokens, which are bearer credentials with a 400-day life and previously had none (M10). |
| 024 | `024_retention_notice_and_event_deletion.sql` | `events.retention_notified_at` and the `event_deletions` log — notice before deletion (D1) and a real erasure path (D2). |
| 025 | `025_email_bounces.sql` | `email_bounces` — a warning that bounced is not a warning, so an album whose host cannot be reached stays undeletable. |
| 026 | `026_case_insensitive_emails.sql` | Lowercases `users.email` and adds a unique index on `lower(email)`. `users_email_key` was case-sensitive, so `Ana@…` and `ana@…` were two accounts — and a host who signed up on a phone (whose keyboard capitalises the first character) could not sign in from a laptop. |

Full detail on the security/architecture-motivated migrations (009-019) is in
`OPEN_ITEMS.md`, which is kept current as the working audit log for this kind
of change; this file documents the resulting schema shape.
