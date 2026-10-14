import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { requireUuidParams } from '../middleware/uuid';
import { requireEventTier, getEffectiveTierForEvent, meetsTier } from '../middleware/tierGate';
import { wsManager } from '../ws/wsServer';
import { errorLabel } from '../lib/errors';
import { getQuestLeaderboard } from '../lib/questLeaderboard';

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

// There is no route for a guest to claim a quest. A quest is completed by
// uploading a photo for it (routes/photos/upload.ts), because only a photo
// can score on the leaderboard. A bare claim endpoint used to exist: it
// earned nothing once scoring required a photo, and it let anyone tick any
// quest for any guest in the completion counts.

// 1. GET /api/events/:id/quests (List Quests with Completions)
questsRouter.get('/events/:id/quests', requireUuidParams('id'), async (req, res) => {
  const { id } = req.params;

  try {
    // N-123 — quests are a Celebration Pass feature. Registration seeds them
    // into every album, and on a free one guests could see and complete them
    // while the host could not manage them and the leaderboard was refused.
    // They are not offered below the tier, and stay put for an upgrade.
    if (!meetsTier(await getEffectiveTierForEvent(String(id)), 'celebration_pass')) {
      return res.json([]);
    }

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

// GET /api/events/:id/leaderboard — ranked guests, photo-backed completions
// only (see lib/questLeaderboard.ts). Public like the quest list, and sold
// with it, so gated at the same tier as creating a quest.
questsRouter.get(
  '/events/:id/leaderboard',
  requireUuidParams('id'),
  requireEventTier('celebration_pass'),
  async (req, res) => {
    try {
      res.json(await getQuestLeaderboard(String(req.params.id)));
    } catch (err) {
      console.error('[Error in GET /api/events/:id/leaderboard]:', errorLabel(err));
      res.status(500).json({ error: 'Failed to fetch the leaderboard' });
    }
  }
);

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
      // N-56 — ?? not ||: 0 is a valid score the schema allows, not a missing one.
      `INSERT INTO scavenger_quests (event_id, title, description, icon_name, points)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, event_id as "eventId", title, description, icon_name as "iconName", points, is_active as "isActive"`,
      [id, title.trim(), description?.trim() || null, iconName || 'camera', points ?? 10]
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
