/**
 * Schemas, cursor parsing and the feed's aggregate loader, shared by the
 * photo sub-routers.
 *
 * `photos.ts` was a single 1013-line router, past the 800-line ceiling in the
 * project's coding standards. It is now a composer over `feed`, `upload`,
 * `engagement` and `moderation`; everything more than one of them needs
 * lives here.
 */

import { z } from 'zod';
import { pool } from '../../lib/db';
import { CONFIG } from '../../lib/config';
import { RESERVED_DEVICE_FINGERPRINTS } from '../../lib/guestAuth';

// A captured photo arrives as a base64 data URL, so these fields carry the whole
// image. Sizing them like short URLs (the previous max of 1000) rejected every
// real capture with a validation error. The caps below track the JSON body limit.
export const DATA_URL_MAX = CONFIG.MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export const CreatePhotoSchema = z.object({
  eventId: z.string().optional(),
  guestId: z.string().max(100).optional(),
  guestName: z.string().max(100).optional(),
  guestAvatar: z.string().max(500).optional(),
  guestTable: z.string().max(50).optional(),
  // Must be a data: URL, never an already-stored path — otherwise a client can
  // plant an arbitrary /uploads/... or R2 key as storage_path and exfiltrate
  // another event's media through their own export-zip (SEC-A1).
  fullUrl: z.string().min(1, 'fullUrl is required').max(DATA_URL_MAX, 'Image is too large')
    .startsWith('data:', 'fullUrl must be a data: URL'),
  thumbnailUrl: z.string().max(DATA_URL_MAX).optional(),
  originalUrl: z.string().max(DATA_URL_MAX).optional(),
  caption: z.string().max(500).optional(),
  filterApplied: z.string().max(50).optional(),
  questId: z.string().max(100).optional(),
  questTitle: z.string().max(200).optional(),
  localId: z.string().max(100).optional(),
  deviceFingerprint: z.string().max(200).optional(),
  // Proof of guest identity for a client-supplied guestId (SEC-A2). Absent for
  // a first-time device, which is fine — that path mints a fresh guest.
  guestToken: z.string().max(2000).optional(),
}).refine(
  (data) => !data.deviceFingerprint || !RESERVED_DEVICE_FINGERPRINTS.has(data.deviceFingerprint),
  { message: 'deviceFingerprint is reserved', path: ['deviceFingerprint'] }
);

export const LikePhotoSchema = z.object({
  guestId: z.string().min(1, 'guestId is required').max(100),
  guestToken: z.string().max(2000).optional(),
});

export const PHOTO_REACTION_KINDS = ['heart', 'clap', 'cheers', 'laugh', 'party'] as const;

export const ReactPhotoSchema = z.object({
  reaction: z.enum(PHOTO_REACTION_KINDS),
  guestId: z.string().min(1, 'guestId is required').max(100),
  guestToken: z.string().max(2000).optional(),
});

export const CommentPhotoSchema = z.object({
  guestId: z.string().min(1, 'guestId is required').max(100),
  guestName: z.string().max(100).optional(),
  // .trim() before .min() so a whitespace-only comment ("   ") is rejected
  // here instead of passing this check and then being trimmed to an empty
  // string by the route handler right before insert.
  commentText: z.string().trim().min(1, 'commentText cannot be empty').max(1000),
  localId: z.string().max(100).optional(),
  guestToken: z.string().max(2000).optional(),
  // H8 — lets a guest with no token still be recognised as the device they
  // already commented from, instead of minting a fresh row per request. Same
  // reserved-value guard as the upload path (SEC-A2).
  deviceFingerprint: z.string().max(200).optional(),
}).refine(
  (data) => !data.deviceFingerprint || !RESERVED_DEVICE_FINGERPRINTS.has(data.deviceFingerprint),
  { message: 'deviceFingerprint is reserved', path: ['deviceFingerprint'] }
);

export const StatusPhotoSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'featured']),
});

// Pagination is validated and clamped: an unbounded or non-numeric `limit`
// otherwise reaches Postgres as NaN (a 500). `cursor` is a composite
// "priority:isoTimestamp" pair (DB-03) — the feed orders by
// `priority DESC, created_at DESC`, so a cursor keyed on created_at alone
// would skip any guest photo newer than a higher-priority photographer photo
// (source: 'photographer' rows get priority=10) once pagination passed it.
export const CURSOR_PATTERN = /^(-?\d+):(.+)$/;
export const ListPhotosQuerySchema = z.object({
  eventId: z.string().uuid('A valid eventId query parameter is required'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z
    .string()
    .refine((v) => {
      const match = v.match(CURSOR_PATTERN);
      return !!match && !Number.isNaN(Date.parse(match[2]));
    }, 'cursor must be "priority:isoTimestamp"')
    .optional(),
});


// SEC-02: /upload/raw used to live here — a generic binary-upload endpoint
// that saved directly to storage without ever creating a photos/audio row,
// so the bytes it wrote were permanently invisible to storage_bytes/quota
// accounting. It predates P7's audio.ts rewrite, which was its only real
// caller (the old AudioGuestbook flow uploaded here first, then POSTed the
// resulting URL to /api/audio); P7 replaced that two-step dance with a
// direct multipart POST, leaving this endpoint with zero callers in the app
// - removed outright rather than built out into real accounting for a path
// nothing uses.

export interface PhotoAggregateRow {
  id: string;
  comments?: unknown[];
  likedByGuestIds?: string[];
  reactions?: { reaction: string; guestId: string }[];
}

/**
 * Fill in each photo's comments, likes and reactions (M6).
 *
 * Shape is deliberately identical to the correlated subqueries this replaced,
 * including the empty-array defaults and the oldest-first comment ordering —
 * the feed, the lightbox and the offline cache all read these directly.
 */
export async function attachPhotoAggregates(rows: PhotoAggregateRow[]): Promise<void> {
  for (const row of rows) {
    row.comments = [];
    row.likedByGuestIds = [];
    row.reactions = [];
  }
  if (rows.length === 0) return;

  const ids = rows.map((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const [comments, likes, reactions] = await Promise.all([
    pool.query(
      `SELECT c.photo_id, c.id, c.guest_id, g.name AS guest_name, c.comment_text, c.created_at
         FROM photo_comments c
         JOIN guests g ON g.id = c.guest_id
        WHERE c.photo_id = ANY($1::uuid[])
        ORDER BY c.created_at ASC`,
      [ids]
    ),
    pool.query('SELECT photo_id, guest_id::text AS guest_id FROM photo_likes WHERE photo_id = ANY($1::uuid[])', [ids]),
    pool.query(
      'SELECT photo_id, reaction, guest_id::text AS guest_id FROM photo_reactions WHERE photo_id = ANY($1::uuid[])',
      [ids]
    ),
  ]);

  for (const c of comments.rows) {
    byId.get(c.photo_id)?.comments?.push({
      id: c.id,
      photoId: c.photo_id,
      guestId: c.guest_id,
      guestName: c.guest_name,
      commentText: c.comment_text,
      createdAt: c.created_at,
    });
  }
  for (const l of likes.rows) {
    byId.get(l.photo_id)?.likedByGuestIds?.push(l.guest_id);
  }
  for (const r of reactions.rows) {
    byId.get(r.photo_id)?.reactions?.push({ reaction: r.reaction, guestId: r.guest_id });
  }
}
