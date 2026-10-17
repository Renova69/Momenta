import compression from 'compression';
import type { Request, RequestHandler, Response } from 'express';

/**
 * The guest feed, compressed.
 *
 * N-157 — API answers go out uncompressed on purpose (N-134, and see
 * builtClient.ts): an answer that carries a secret next to text a caller
 * chose can leak the secret through its compressed size. The guest feed has
 * no secret in it. It is photo addresses, names and captions anyone at the
 * wedding can see, and a page of 100 photos is about 96 kB raw against 9 kB
 * gzipped, loaded by every guest on the venue's Wi-Fi.
 *
 * The host's own feed is the exception, and is left alone: it carries signed
 * preview links for photos awaiting moderation. A host is told apart by the
 * Authorization header, which is how every signed-in request is sent.
 */
export function compressGuestFeed(): RequestHandler {
  return compression({
    filter: (req: Request, res: Response) => !req.headers.authorization && compression.filter(req, res),
  });
}

/**
 * N-160 — an /api address no route answers. Without this it fell through to
 * Express's own HTML "Cannot GET" page, which the client then failed to read
 * as JSON, instead of a 404 it understands.
 */
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};

/** Sent with every page and file that should never appear in search results (N-153). */
export const NOINDEX = 'noindex, nofollow';
