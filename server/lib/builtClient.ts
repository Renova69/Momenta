import express, { type Response, type Router } from 'express';
import compression from 'compression';
import path from 'path';

/**
 * The built client, as production serves it: the SPA's files, and its page
 * for every address the client routes itself (`/e/:slug`, `/host`, ...).
 *
 * N-134 — the shipped compose publishes this server's port with nothing in
 * front of it, so whatever this sends is what crosses a venue's Wi-Fi. It sent
 * everything uncompressed (the main chunk as 418 kB rather than about 125),
 * and with `max-age=0` on files whose names change with their content, so a
 * guest reopening the album asked for every one of them again.
 *
 * Only the client is compressed. API answers carry session tokens next to
 * text a caller chose, which is what a compression side channel needs.
 */

/** Vite's output directory for content-hashed files. */
const HASHED_DIR = `${path.sep}assets${path.sep}`;

const CACHE_FOR_GOOD = 'public, max-age=31536000, immutable';
/** Kept, but checked with the server before each use. */
const ALWAYS_CHECK = 'no-cache';

function setCacheHeaders(res: Response, filePath: string): void {
  res.setHeader('Cache-Control', filePath.includes(HASHED_DIR) ? CACHE_FOR_GOOD : ALWAYS_CHECK);
}

export function builtClient(distDir: string): Router {
  const router = express.Router();
  const page = path.join(distDir, 'index.html');

  router.use(compression());
  router.use(express.static(distDir, { setHeaders: setCacheHeaders }));
  router.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      res.setHeader('Cache-Control', ALWAYS_CHECK);
      return res.sendFile(page);
    }
    next();
  });
  return router;
}
