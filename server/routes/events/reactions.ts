/**
 * Ephemeral room reactions broadcast over the event WebSocket.
 *
 * Split out of the former single-file `events.ts` (1073 lines, past the
 * project's 800-line ceiling). Mounted by `events.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import { pool } from '../../lib/db';
import { validateBody } from '../../middleware/validate';
import { requireUuidParams } from '../../middleware/uuid';
import { reactionLimiter } from '../../middleware/rateLimit';
import { wsManager } from '../../ws/wsServer';
import { errorLabel } from '../../lib/errors';
import {
  ReactionSchema,
} from './shared';

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const eventsRouter = Router();
export { eventsRouter as reactionsRouter };

// POST /api/events/:id/reactions — broadcast an ephemeral reaction to the room
eventsRouter.post(
  '/:id/reactions',
  requireUuidParams('id'),
  reactionLimiter,
  validateBody(ReactionSchema),
  async (req, res) => {
    const id = String(req.params.id);
    const { reaction, guestName } = req.body;

    try {
      const exists = await pool.query('SELECT 1 FROM events WHERE id = $1', [id]);
      if (exists.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      // Queued and flushed in a short batch rather than broadcast
      // immediately — a reaction flood turns into far fewer WebSocket
      // messages to the room this way (P6).
      wsManager.queueReaction(id, {
        reaction,
        guestName: guestName?.trim() || null,
        at: new Date().toISOString(),
      });

      res.status(202).json({ success: true, reaction });
    } catch (err) {
      console.error('[Events] reaction error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
