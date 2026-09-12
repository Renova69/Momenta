/**
 * QR poster configuration read and write.
 *
 * Split out of the former single-file `events.ts` (1073 lines, past the
 * project's 800-line ceiling). Mounted by `events.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import { pool } from '../../lib/db';
import { validateBody } from '../../middleware/validate';
import { requireUuidParams } from '../../middleware/uuid';
import { requireAuth } from '../../middleware/auth';
import { requireEventTier } from '../../middleware/tierGate';
import { errorLabel } from '../../lib/errors';
import {
  QRConfigSchema,
} from './shared';

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const eventsRouter = Router();
export { eventsRouter as qrRouter };

// GET /api/events/:id/qr-config
eventsRouter.get('/:id/qr-config', requireUuidParams('id'), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM qr_canvas_configs WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id]
    );
    if (rows.length === 0) {
      return res.json({
        eventId: id,
        canvasSize: 'A2',
        frameStyle: 'minimal_gold',
        headline: 'Capture the Love',
        subtext: 'Scan the QR code with your phone camera to share your photos and messages to our live wedding gallery.',
        accentColor: '#D4AF37',
        centerIcon: 'heart',
      });
    }
    const r = rows[0];
    res.json({
      id: r.id,
      eventId: r.event_id,
      canvasSize: r.canvas_size,
      frameStyle: r.frame_style,
      headline: r.headline,
      subtext: r.subtext,
      accentColor: r.accent_color,
      centerIcon: r.center_icon,
    });
  } catch (err) {
    console.error('[Events] qr-config GET error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id/qr-config
eventsRouter.put(
  '/:id/qr-config',
  requireAuth,
  requireUuidParams('id'),
  requireEventTier('celebration_pass'),
  validateBody(QRConfigSchema),
  async (req, res) => {
  const { id } = req.params;
  const { canvasSize, frameStyle, headline, subtext, accentColor, centerIcon } = req.body;

  try {
    const eventCheck = await pool.query('SELECT host_user_id FROM events WHERE id = $1', [id]);
    if (eventCheck.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    if (eventCheck.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    // DB-08: the check-then-branch UPDATE-or-INSERT this replaced had a race
    // window between the SELECT and whichever branch ran — two concurrent
    // PUTs on a config that doesn't exist yet could both see "no existing
    // row" and both attempt the INSERT branch, and the loser hit an
    // unhandled 500 against qr_canvas_configs' UNIQUE(event_id) constraint
    // (migration 005). A real INSERT ... ON CONFLICT is the only version of
    // this that's actually atomic. The DO UPDATE branch references the raw
    // $2..$6 parameters directly (not EXCLUDED, which the VALUES clause has
    // already defaulted) so a null/omitted field still falls back to the
    // row's current value instead of clobbering it with the INSERT default.
    const result = await pool.query(
      `INSERT INTO qr_canvas_configs (event_id, canvas_size, frame_style, headline, subtext, accent_color, center_icon)
       VALUES ($1, COALESCE($2::canvas_size_type, 'A2'), COALESCE($3::frame_style_type, 'minimal_gold'), COALESCE($4, 'Capture the Love'),
               COALESCE($5, 'Scan the QR code with your phone camera to share your photos.'), COALESCE($6, '#D4AF37'), COALESCE($7, 'heart'))
       ON CONFLICT (event_id) DO UPDATE SET
         canvas_size = COALESCE($2::canvas_size_type, qr_canvas_configs.canvas_size),
         frame_style = COALESCE($3::frame_style_type, qr_canvas_configs.frame_style),
         headline = COALESCE($4, qr_canvas_configs.headline),
         subtext = COALESCE($5, qr_canvas_configs.subtext),
         accent_color = COALESCE($6, qr_canvas_configs.accent_color),
         center_icon = COALESCE($7, qr_canvas_configs.center_icon),
         updated_at = NOW()
       RETURNING *`,
      [id, canvasSize || null, frameStyle || null, headline || null, subtext || null, accentColor || null, centerIcon || null]
    );

    const r = result.rows[0];
    res.json({
      id: r.id,
      eventId: r.event_id,
      canvasSize: r.canvas_size,
      frameStyle: r.frame_style,
      headline: r.headline,
      subtext: r.subtext,
      accentColor: r.accent_color,
      centerIcon: r.center_icon,
    });
  } catch (err) {
    console.error('[Events] qr-config PUT error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
