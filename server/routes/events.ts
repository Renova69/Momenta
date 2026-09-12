/**
 * `/api/events` — composed from four sub-routers.
 *
 * This file was 1073 lines, past the 800-line ceiling in the project's coding
 * standards. The handlers did not change; they were grouped by what they act
 * on and each group given its own Router.
 *
 * **The order below is the order the routes were registered in before, and it
 * has to stay that way.** Express matches in registration order, so composing
 * these differently would change which handler answers a request. No route in
 * one group shadows one in another today — `/:id` is a single segment and
 * cannot match `/:id/usage` — but that is a property of the current paths, not
 * a guarantee, and the cheap way to keep it true is to preserve the order.
 */

import { Router } from 'express';
import { crudRouter } from './events/crud';
import { exportRouter } from './events/export';
import { reactionsRouter } from './events/reactions';
import { qrRouter } from './events/qr';

export const eventsRouter = Router();

// GET /slug/:slug, GET /showcase/feed, POST /, GET /, GET /:id, PUT /:id,
// POST /:id/guest-sessions/reset, DELETE /:id
eventsRouter.use(crudRouter);

// GET /:id/usage, POST /:id/export-token, GET /:id/export-zip
eventsRouter.use(exportRouter);

// POST /:id/reactions
eventsRouter.use(reactionsRouter);

// GET /:id/qr-config, PUT /:id/qr-config
eventsRouter.use(qrRouter);
