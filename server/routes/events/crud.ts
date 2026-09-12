/**
 * Album lifecycle: lookup, listing, creation, settings, deletion.
 *
 * Split out of the former single-file `events.ts` (1073 lines, past the
 * project's 800-line ceiling). Mounted by `events.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import path from 'path';
import { pool } from '../../lib/db';
import { validateBody } from '../../middleware/validate';
import { requireUuidParams } from '../../middleware/uuid';
import { wsManager } from '../../ws/wsServer';
import { cleanSlug } from '../../lib/storage';
import { requireAuth } from '../../middleware/auth';
import { getEffectiveTierForEvent, getEffectiveTierForUser, meetsTier, acquireUserEventCreationLock } from '../../middleware/tierGate';
import { computeExpiry, purgeEventMedia } from '../../lib/retention';
import { errorLabel, isUniqueViolation } from '../../lib/errors';
import {
  UpdateEventSchema,
  PUBLIC_EVENT_COLUMNS,
  HOST_EVENT_COLUMNS,
  toPublicEvent,
  TIER_GATED_EVENT_FIELDS,
  DEFAULT_THEME,
  CreateEventSchema,
  DeleteEventSchema,
} from './shared';

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const eventsRouter = Router();
export { eventsRouter as crudRouter };

// GET /api/events/slug/:slug — public endpoint, returns safe columns only
eventsRouter.get('/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    // [FIX H-6] Never fall back to another event — return 404 on miss
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events WHERE slug = $1 LIMIT 1`,
      [slug]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = rows[0];
    // Expose the authoritative plan tier (derived from the host subscription) so
    // the client does not fabricate a default and can gate the UI correctly.
    event.planTier = await getEffectiveTierForEvent(event.id);
    res.json(event);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Events] slug lookup error:', errorMsg);
    // [FIX H-5] Never leak DB error details
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/showcase/feed — returns public events with preview photos for social proof showcase
eventsRouter.get('/showcase/feed', async (_req, res) => {
  try {
    // H6 — `is_public` is the host's own opt-in (migration 022). Without this
    // predicate the feed advertised every wedding in the database.
    //
    // The counts are also computed per selected event rather than by joining
    // photos and guests across the whole table and grouping afterwards: the
    // old shape scanned everything before LIMIT 6 could discard it, so it got
    // slower with every wedding ever created.
    const eventsQuery = await pool.query(`
      WITH featured AS (
        SELECT id, title, slug, host_name, event_date, venue_name, cover_image_url, theme_palette
          FROM events
         WHERE is_public
         ORDER BY created_at DESC
         LIMIT 6
      )
      SELECT f.*,
             (SELECT COUNT(*)::int FROM photos p
               WHERE p.event_id = f.id AND p.status IN ('approved', 'featured')) AS photos_count,
             (SELECT COUNT(*)::int FROM guests g WHERE g.event_id = f.id) AS guests_count
        FROM featured f
    `);

    // Preview photos for all six events in one round trip rather than a query
    // per event. LATERAL keeps the per-event LIMIT 4 while staying a single scan.
    const eventIds = eventsQuery.rows.map((ev) => ev.id);
    const previewsByEvent = new Map<string, unknown[]>();

    if (eventIds.length > 0) {
      const previewQuery = await pool.query(
        `SELECT e.id AS event_id, p.id, p.thumbnail_url, p.full_url, p.caption, p.filter_applied
           FROM unnest($1::uuid[]) AS e(id)
           CROSS JOIN LATERAL (
             SELECT id, thumbnail_url, full_url, caption, filter_applied, created_at
               FROM photos
              WHERE photos.event_id = e.id AND status IN ('approved', 'featured')
              ORDER BY created_at DESC
              LIMIT 4
           ) p`,
        [eventIds]
      );

      for (const row of previewQuery.rows) {
        const { event_id: eventId, ...photo } = row;
        if (!previewsByEvent.has(eventId)) previewsByEvent.set(eventId, []);
        previewsByEvent.get(eventId)!.push(photo);
      }
    }

    res.json(
      eventsQuery.rows.map((ev) => ({
        ...ev,
        previewPhotos: previewsByEvent.get(ev.id) || [],
      }))
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Events] showcase error:', errorMsg);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /api/events — create a new event for the authenticated host (multi-event management)
eventsRouter.post('/', requireAuth, validateBody(CreateEventSchema), async (req, res) => {
  const { title, hostName, slug, eventDate, venueName, themePalette, welcomeMessage, coverImageUrl } = req.body;

  try {
    const userId = req.user!.userId;
    const userRes = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const host = userRes.rows[0];

    // Enforce the subscription's active-event limit (Pro Planner = 10, others = 1).
    // Also the source for the real effective tier — the events row's own
    // plan_tier column is always 'free' at creation (getEffectiveTierForEvent
    // is what actually gets trusted later), but the response should still
    // reflect a host's existing paid plan on their 2nd+ event, and computing
    // the retention deadline needs it too.
    const subRes = await pool.query(
      "SELECT event_limit, tier FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    const eventLimit = subRes.rows[0]?.event_limit ?? 1;
    const effectiveTier = (subRes.rows[0]?.tier || 'free') as Parameters<typeof computeExpiry>[0];
    // Cheap pre-check: reject an obviously-over-limit host before doing any
    // more work. The check that actually has to hold is the locked one right
    // before the insert loop below (DB-06).
    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM events WHERE host_user_id = $1', [userId]);
    if (countRes.rows[0].c >= eventLimit) {
      return res.status(403).json({
        error: 'Достигнат е лимитът от активни сватби за вашия план.',
        code: 'EVENT_LIMIT_REACHED',
        limit: eventLimit,
      });
    }

    const baseSlug = slug ? slug.trim().toLowerCase() : `${cleanSlug(hostName)}-${Date.now().toString(36)}`;
    const eventDateIso = eventDate ? new Date(eventDate).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    // Computed from the request-time clock rather than the row's own
    // created_at (not known until after the INSERT) — retention windows are
    // measured in whole days, so being off by the few milliseconds until the
    // INSERT actually commits is immaterial. Stamping it in the same INSERT
    // (SEC-D4) means a host can never end up with an event that has no
    // retention deadline because the process died between two statements.
    const expiry = computeExpiry(effectiveTier, eventDateIso, new Date().toISOString());

    // The SELECT-then-INSERT this replaced was racy: two requests can both
    // pass the check before either commits (SEC-P5). Retrying the INSERT
    // itself against the real unique constraint is the only version of that
    // check that is actually atomic. The event-limit count above has the
    // same race (DB-06) — re-checked here under an advisory lock, inside the
    // same transaction as the insert, so no second request can slip through
    // between the recheck and the write.
    const MAX_SLUG_ATTEMPTS = 5;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event: any;
    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await acquireUserEventCreationLock(lockClient, userId);

      const freshCount = await lockClient.query('SELECT COUNT(*)::int AS c FROM events WHERE host_user_id = $1', [userId]);
      if (freshCount.rows[0].c >= eventLimit) {
        await lockClient.query('ROLLBACK');
        return res.status(403).json({
          error: 'Достигнат е лимитът от активни сватби за вашия план.',
          code: 'EVENT_LIMIT_REACHED',
          limit: eventLimit,
        });
      }

      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        const finalSlug =
          attempt === 0 ? baseSlug : `${baseSlug}-${Date.now().toString(36).slice(-4)}${attempt}`;
        // A failed statement aborts the rest of a Postgres transaction until
        // rolled back - now that the retry loop runs inside one explicit
        // BEGIN (for the advisory lock above), each attempt needs its own
        // savepoint so a slug collision on attempt N doesn't poison attempt
        // N+1's connection.
        await lockClient.query('SAVEPOINT slug_attempt');
        try {
          const insert = await lockClient.query(
            `INSERT INTO events (title, slug, host_name, host_email, host_user_id, plan_tier, event_date, venue_name, theme_palette, welcome_message, cover_image_url, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'free', $6, $7, $8, $9, $10, $11)
             RETURNING ${HOST_EVENT_COLUMNS}`,
            [
              title || `${hostName.trim()}'s Wedding`,
              finalSlug,
              hostName.trim(),
              host.email,
              userId,
              eventDateIso,
              venueName?.trim() || 'Голяма зала за тържества',
              themePalette || 'champagne_gold',
              welcomeMessage || 'Добре дошли на нашия сватбен ден! Сканирайте QR кода, снимайте весели и неподправени моменти и ни помогнете да запечатаме всеки миг заедно.',
              coverImageUrl || null,
              expiry,
            ]
          );
          event = insert.rows[0];
          break;
        } catch (err) {
          if (isUniqueViolation(err, 'events_slug_key') && attempt < MAX_SLUG_ATTEMPTS - 1) {
            await lockClient.query('ROLLBACK TO SAVEPOINT slug_attempt');
            continue;
          }
          throw err;
        }
      }
      if (!event) {
        await lockClient.query('ROLLBACK');
        return res.status(409).json({ error: 'Could not allocate a unique event URL. Please try again.' });
      }

      await lockClient.query('COMMIT');
    } catch (err) {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      lockClient.release();
    }
    event.planTier = effectiveTier;
    // Not in HOST_EVENT_COLUMNS' RETURNING list — assigned from the value
    // already written in the same INSERT above, not re-queried.
    event.expires_at = expiry;

    res.status(201).json(event);
  } catch (err) {
    console.error('[Events] POST error:', errorLabel(err));
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// GET /api/events — list the authenticated host's events (multi-event dashboard)
eventsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${HOST_EVENT_COLUMNS} FROM events WHERE host_user_id = $1 ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    // M5 — one lookup, not one per row. The tier belongs to the host, and every
    // row here is this host's by definition of the WHERE clause above.
    const tier = await getEffectiveTierForUser(req.user!.userId);
    for (const ev of rows) {
      ev.planTier = tier;
    }
    res.json(rows);
  } catch (err) {
    console.error('[Events] GET list error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id — public read (returns safe columns)
eventsRouter.get('/:id', requireUuidParams('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[Events] GET by ID error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id (Update Event Settings — host only)
eventsRouter.put('/:id', requireAuth, requireUuidParams('id'), validateBody(UpdateEventSchema), async (req, res) => {
  const id = String(req.params.id);
  const updates = req.body;

  try {
    const existing = await pool.query(
      'SELECT host_user_id, slug FROM events WHERE id = $1 LIMIT 1',
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // [Authorization check]
    if (existing.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    // Server-side tier enforcement for paid settings. Only *enabling* a paid
    // feature is gated: a host whose plan lapsed must always be able to switch
    // moderation off or clear a reveal time.
    const gatedRequested = Object.keys(TIER_GATED_EVENT_FIELDS).filter(
      (field) => field in updates && !!updates[field]
    );
    const wantsCustomTheme =
      typeof updates.themePalette === 'string' && updates.themePalette !== DEFAULT_THEME;

    if (gatedRequested.length > 0 || wantsCustomTheme) {
      const tier = await getEffectiveTierForEvent(id);

      for (const field of gatedRequested) {
        const required = TIER_GATED_EVENT_FIELDS[field];
        if (!meetsTier(tier, required)) {
          return res.status(403).json({
            error: `Настройката "${field}" изисква план "${required}" или по-висок.`,
            requiredTier: required,
            currentTier: tier,
            code: 'TIER_REQUIRED',
          });
        }
      }

      if (wantsCustomTheme && !meetsTier(tier, 'celebration_pass')) {
        return res.status(403).json({
          error: 'Персонализираните палитри изискват план "celebration_pass" или по-висок.',
          requiredTier: 'celebration_pass',
          currentTier: tier,
          code: 'TIER_REQUIRED',
        });
      }
    }

    // Build dynamic update clauses to allow clearing nullable fields
    const fieldMap: Record<string, string> = {
      slug: 'slug',
      title: 'title',
      hostName: 'host_name',
      hostEmail: 'host_email',
      eventDate: 'event_date',
      venueName: 'venue_name',
      coverImageUrl: 'cover_image_url',
      themePalette: 'theme_palette',
      welcomeMessage: 'welcome_message',
      isModerationEnabled: 'is_moderation_enabled',
      isDisposableMode: 'is_disposable_mode',
      isPublic: 'is_public',
      revealAt: 'reveal_at',
      maxPhotosPerGuest: 'max_photos_per_guest',
    };

    const setClauses: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    const updateRecord = updates as Record<string, string | number | boolean | null | undefined>;
    let slugValueIndex = -1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updateRecord) {
        values.push(updateRecord[key] ?? null);
        setClauses.push(`${col} = $${values.length}`);
        if (key === 'slug') slugValueIndex = values.length - 1;
      }
    }

    if (setClauses.length === 0) {
      return res.json(existing.rows[0]);
    }

    setClauses.push('updated_at = NOW()');
    values.push(id);

    // DB-12: the check-then-adjust slug uniqueness logic this replaced had
    // the same race P5 already fixed on event creation — a SELECT for a
    // collision, then an UPDATE moments later, with nothing locking the gap
    // between them. Retrying on the real 23505 violation is the only
    // version of this that's actually atomic; POST /api/events already
    // established the pattern.
    const MAX_SLUG_ATTEMPTS = 5;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updated: any;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      if (attempt > 0 && slugValueIndex >= 0) {
        values[slugValueIndex] = `${updateRecord.slug}-${Date.now().toString(36).slice(-4)}${attempt}`;
      }
      try {
        updated = await pool.query(
          `UPDATE events SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING ${HOST_EVENT_COLUMNS}`,
          values
        );
        break;
      } catch (err) {
        if (slugValueIndex >= 0 && isUniqueViolation(err, 'events_slug_key') && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
        throw err;
      }
    }

    // M11 — the ownership SELECT above and this UPDATE are separate
    // statements, so a concurrent delete between them leaves zero rows and
    // `rows[0]` undefined. Reading planTier off that threw a TypeError and
    // surfaced as a 500; the event genuinely is gone, so say so.
    if (!updated || updated.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const eventData = updated.rows[0];
    eventData.planTier = await getEffectiveTierForEvent(eventData.id);
    // Guests share this room, so the broadcast carries the public projection only.
    wsManager.broadcastToEvent(id, 'EVENT_UPDATED', toPublicEvent(eventData));
    res.json(eventData);
  } catch (err) {
    console.error('[Events] PUT error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/events/:id/guest-sessions/reset — end every guest session on this
 * album (M10).
 *
 * A guest token is a bearer credential with a 400-day life, and until now
 * nothing could end one: a token copied off a shared phone, or read out of a
 * screenshot, stayed valid for as long as the album did.
 * `users.token_version` (migration 019) solved this for hosts but had no
 * guests equivalent, because there is no guest logout to bump it. The trigger
 * that does exist is this — a deliberate action by the host who owns the
 * album.
 *
 * Two writes, and they only work together:
 *
 *   - bumping `token_version` invalidates every token already issued;
 *   - clearing `device_fingerprint` releases the
 *     (event_id, device_fingerprint) slot, so a returning guest no longer
 *     matches an existing row, gets a genuinely fresh one, and is issued a
 *     token because that row is inherently theirs.
 *
 * Without the second, revocation would be permanent: the fingerprint would
 * still match the old row, `xmax = 0` would be false, and no token could ever
 * be issued again — while issuing one on a fingerprint *match* is exactly the
 * hole SEC-03 exists to keep shut. Freeing the slot is what lets both rules
 * hold at once.
 *
 * The old rows stay, with their photos, comments and reactions intact —
 * revoking sessions must never become a way to delete what guests
 * contributed. The visible cost is that a guest who re-joins afterwards is a
 * new identity and loses the link to their own earlier uploads, which is why
 * this is a deliberate host action and not something that happens on its own.
 */
eventsRouter.post('/:id/guest-sessions/reset', requireAuth, requireUuidParams('id'), async (req, res) => {
  const id = String(req.params.id);

  try {
    const eventRes = await pool.query('SELECT host_user_id FROM events WHERE id = $1', [id]);
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (eventRes.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    const result = await pool.query(
      `UPDATE guests
          SET token_version = token_version + 1,
              device_fingerprint = NULL
        WHERE event_id = $1`,
      [id]
    );

    console.warn(`[Events] Host reset ${result.rowCount ?? 0} guest session(s) on event ${id}`);
    res.json({ success: true, guestsReset: result.rowCount ?? 0 });
  } catch (err) {
    console.error('[Events] guest-sessions reset error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});


/**
 * DELETE /api/events/:id — remove an album and everything in it (D2).
 *
 * There was no delete handler at all, anywhere. A host could never remove their
 * own album, and a service storing photographs of identifiable people together
 * with their names and table numbers had no erasure path — a GDPR Article 17
 * problem, not merely a missing feature.
 *
 * Deliberately a hard delete rather than a soft one. Soft deletion would mean
 * threading `deleted_at IS NULL` through every read path in the app, where a
 * single missed query leaves a "deleted" album still serving photos — a worse
 * failure than the one it protects against, and a weaker answer to an erasure
 * request, which asks for the data to be gone rather than hidden.
 *
 * The protection against deleting the wrong thing is confirmation instead: the
 * host types the album's own slug back. That is the same pattern as typing a
 * repository name before deleting it, and it is the appropriate weight for an
 * action this irreversible.
 *
 * **Media is purged before the row, and the order is load-bearing.** Deleting
 * the event cascades its photo and audio rows away, and those rows hold the
 * only record of which stored objects belong to this album. Purge afterwards
 * and every file is orphaned permanently, with nothing left that could ever
 * find them again — exactly the failure that put 164 MB of unreachable objects
 * in storage before the orphan sweep was fixed. purgeEventMedia() is the same
 * function the retention sweep uses; it is not reimplemented here.
 */
eventsRouter.delete(
  '/:id',
  requireAuth,
  requireUuidParams('id'),
  validateBody(DeleteEventSchema),
  async (req, res) => {
    const id = String(req.params.id);
    const { confirmSlug } = req.body as { confirmSlug: string };

    try {
      const eventRes = await pool.query('SELECT host_user_id, slug FROM events WHERE id = $1', [id]);
      if (eventRes.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }
      const { host_user_id: hostUserId, slug } = eventRes.rows[0];

      if (hostUserId !== req.user!.userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this event' });
      }

      // Checked before anything is touched, and against the stored slug rather
      // than anything the client also supplied.
      if (confirmSlug !== slug) {
        return res.status(400).json({
          error: 'Type the album address exactly to confirm deletion.',
          code: 'CONFIRMATION_MISMATCH',
        });
      }

      const photoCountRes = await pool.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1',
        [id]
      );
      const photosDeleted = photoCountRes.rows[0]?.n ?? 0;

      // 1. Storage first — see the note above about the cascade.
      const purge = await purgeEventMedia(id);
      const bytesFreed = purge.freedBytes;
      if (purge.failedPaths.length > 0) {
        // The rows naming these are about to be deleted, so after this only
        // `storage:orphans` can find them. Logged loudly rather than returned:
        // the host's erasure request did succeed, and this is an operator
        // problem, not something to report to them as a failure.
        console.error(
          `[Events] purge for ${id} left ${purge.failedPaths.length} object(s) in storage:`,
          purge.failedPaths.join(', ')
        );
      }

      // 2. Then the row, which cascades guests, quests, comments and the rest.
      await pool.query('DELETE FROM events WHERE id = $1', [id]);

      // 3. A record that this happened, holding none of what was deleted.
      await pool
        .query(
          `INSERT INTO event_deletions (event_id, slug, host_user_id, photos_deleted, bytes_freed)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, slug, hostUserId, photosDeleted, bytesFreed]
        )
        .catch((err) => {
          // The deletion itself has already happened and is not reversible;
          // failing the response now would tell the host it did not work.
          console.error('[Events] deletion succeeded but the audit row failed:', errorLabel(err));
        });

      console.warn(
        `[Events] Host ${hostUserId} deleted event ${slug} (${id}) — ${photosDeleted} photo(s), ${bytesFreed} bytes freed`
      );

      wsManager.broadcastToEvent(id, 'EVENT_DELETED', { eventId: id });
      res.json({ success: true, eventId: id, photosDeleted, bytesFreed });
    } catch (err) {
      console.error('[Events] DELETE error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
