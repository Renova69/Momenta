/**
 * `/api/photos` — composed from four sub-routers.
 *
 * This file was 1013 lines, past the 800-line ceiling in the project's coding
 * standards, and one handler inside it (POST /) ran to 372 lines on its own.
 * The handlers were grouped by what they do; only the upload path was
 * restructured, into named steps in `photos/upload.ts`.
 *
 * **The order below is the order the routes were registered in before, and it
 * has to stay that way.** Express matches in registration order, so composing
 * these differently would change which handler answers a request.
 */

import { Router } from 'express';
import { feedRouter } from './photos/feed';
import { uploadRouter } from './photos/upload';
import { engagementRouter } from './photos/engagement';
import { moderationRouter } from './photos/moderation';

export const photosRouter = Router();

// GET /, GET /:id/preview
photosRouter.use(feedRouter);

// POST /
photosRouter.use(uploadRouter);

// POST /:id/like, POST /:id/react, POST /:id/comments
photosRouter.use(engagementRouter);

// POST /:id/status, DELETE /:id
photosRouter.use(moderationRouter);
