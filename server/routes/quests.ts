import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { requireUuidParams } from '../middleware/uuid';
import { requireEventTier } from '../middleware/tierGate';
import { guestActionLimiter } from '../middleware/rateLimit';
import { isValidUuid } from '../lib/validation';
import { RESERVED_DEVICE_FINGERPRINTS, issueGuestToken } from '../lib/guestAuth';
import { resolveGuestIdentity } from '../lib/guestIdentity';
import { wsManager } from '../ws/wsServer';
import { errorLabel } from '../lib/errors';

export const questsRouter = Router();

// M12 — none of these were bounded. The columns are VARCHAR, so an over-long
// title did not merely store badly: it overflowed the column, Postgres raised
// 22001, and the host got a 500 for what is a plain validation error. `points`
// accepted negatives and arbitrarily large values straight into the scoreboard.
const CreateQuestSchema = z.object({
  title: z.string().trim().min(2, 'Title is required').max(200),
  description: z.string().trim().max(1000).optional(),
  iconName: z.string().trim().max(50).default('camera'),
  points: z.number().int().min(0).max(1000).default(10),
  localId: z.string().max(100).optional(),
});

const CompleteQuestSchema = z.object({
  guestId: z.string().min(1, 'guestId is required'),
  photoId: z.string().optional(),
  guestToken: z.string().max(2000).optional(),
  // H8 — recognises a returning device instead of minting a guest row on
  // every unproven request. Same reserved-value guard as the upload path.
  deviceFingerprint: z.string().max(200).optional(),
}).refine(
  (data) => !data.deviceFingerprint || !RESERVED_DEVICE_FINGERPRINTS.has(data.deviceFingerprint),
  { message: 'deviceFingerprint is reserved', path: ['deviceFingerprint'] }
);

// 1. GET /api/events/:id/quests (List Quests with Completions)
questsRouter.get('/events/:id/quests', requireUuidParams('id'), async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT 
        sq.id,
        sq.event_id as "eventId",
        sq.title,
        sq.description,
        sq.icon_name as "iconName",
        sq.points,
        sq.is_active as "isActive",
        COALESCE(
          (SELECT array_agg(gqc.guest_id::text) FROM guest_quest_completions gqc WHERE gqc.quest_id = sq.id),
          ARRAY[]::text[]
        ) as "completedByGuestIds"
      FROM scavenger_quests sq
      WHERE sq.event_id = $1
      ORDER BY sq.created_at ASC;
    `;

    const { rows } = await pool.query(query, [id]);
    res.json(rows);
  } catch (err) {
    console.error('[Error in GET /api/events/:id/quests]:', errorLabel(err));
    res.status(500).json({ error: 'Failed to fetch scavenger quests' });
  }
});

// 2. POST /api/events/:id/quests (Create Quest - Host Only)
questsRouter.post(
  '/events/:id/quests',
  requireAuth,
  requireUuidParams('id'),
  requireEventTier('celebration_pass'),
  validateBody(CreateQuestSchema),
  async (req, res) => {
  const id = String(req.params.id);
  const { title, description, iconName, points } = req.body;

  try {
    const eventCheck = await pool.query('SELECT host_user_id FROM events WHERE id = $1', [id]);
    if (eventCheck.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    if (eventCheck.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    const result = await pool.query(
      `INSERT INTO scavenger_quests (event_id, title, description, icon_name, points)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, event_id as "eventId", title, description, icon_name as "iconName", points, is_active as "isActive"`,
      [id, title.trim(), description?.trim() || null, iconName || 'camera', points || 10]
    );

    const quest = {
      ...result.rows[0],
      completedByGuestIds: [],
      localId: req.body.localId,
    };

    wsManager.broadcastToEvent(id, 'QUEST_ADDED', quest);
    res.status(201).json(quest);
  } catch (err) {
    console.error('[Error in POST /api/events/:id/quests]:', errorLabel(err));
    res.status(500).json({ error: 'Failed to create scavenger quest' });
  }
});

// 3. DELETE /api/quests/:id (Delete Quest - Host Only)
questsRouter.delete('/quests/:id', requireAuth, requireUuidParams('id'), async (req, res) => {
  const { id } = req.params;

  try {
    const query = await pool.query(
      'SELECT q.event_id, e.host_user_id FROM scavenger_quests q JOIN events e ON e.id = q.event_id WHERE q.id = $1',
      [id]
    );
    if (query.rows.length === 0) {
      return res.status(404).json({ error: 'Quest not found' });
    }
    if (query.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const eventId = query.rows[0].event_id;
    await pool.query('DELETE FROM scavenger_quests WHERE id = $1', [id]);
    wsManager.broadcastToEvent(eventId, 'QUEST_DELETED', { questId: id });
    res.json({ success: true, questId: id });
  } catch (err) {
    console.error('[Error in DELETE /api/quests/:id]:', errorLabel(err));
    res.status(500).json({ error: 'Failed to delete scavenger quest' });
  }
});

// 4. POST /api/quests/:id/complete (Record Completion)
questsRouter.post(
  '/quests/:id/complete',
  requireUuidParams('id'),
  guestActionLimiter,
  validateBody(CompleteQuestSchema),
  async (req, res) => {
  const { id } = req.params;
  const { guestId, photoId, guestToken, deviceFingerprint } = req.body;

  try {
    const questQuery = await pool.query('SELECT event_id FROM scavenger_quests WHERE id = $1', [id]);
    if (questQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Quest not found' });
    }
    const eventId = questQuery.rows[0].event_id;

    // H8 — a token, else this device's existing row, else one row for this
    // device. A caller with neither is asked to identify itself instead of
    // being handed a brand-new guest (see lib/guestIdentity.ts).
    const identity = await resolveGuestIdentity({ eventId, guestId, guestToken, deviceFingerprint });
    if (!identity) {
      return res.status(401).json({
        error: 'Join the wedding before completing a quest.',
        code: 'GUEST_IDENTITY_REQUIRED',
      });
    }
    const validGuestId = identity.guestId;

    const validPhotoId = photoId && isValidUuid(photoId) ? photoId : null;

    await pool.query(
      `INSERT INTO guest_quest_completions (quest_id, guest_id, photo_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (quest_id, guest_id) DO NOTHING`,
      [id, validGuestId, validPhotoId]
    );

    wsManager.broadcastToEvent(eventId, 'QUEST_COMPLETED', { questId: id, guestId: validGuestId });
    // Only when identity was actually proven this request (SEC-03).
    res.json({
      success: true,
      questId: id,
      guestId: validGuestId,
      ...(identity.identityProven ? { guestToken: issueGuestToken(validGuestId, eventId, identity.tokenVersion) } : {}),
    });
  } catch (err) {
    console.error('[Error in POST /api/quests/:id/complete]:', errorLabel(err));
    res.status(500).json({ error: 'Failed to record quest completion' });
  }
});
