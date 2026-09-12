import path from 'path';
import { pool } from './db';
import { toAbsoluteUrl } from './storage';
import { isImageMagicBytes } from './validation';
import { buildDerivatives } from './images';
import { checkPhotoUploadTierLimit } from '../middleware/tierGate';
import {
  savePhotoVariants,
  insertPhotoUnderQuota,
  broadcastPhotoAdded,
} from './photoWrite';

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export interface IngestedPhoto {
  id: string;
  eventId: string;
  guestId: string;
  guestName: string;
  storagePath: string;
  thumbnailUrl: string;
  fullUrl: string;
  originalUrl: string | null;
  caption: string | null;
  status: string;
  source: string;
  priority: number;
  photographerName: string | null;
  filterApplied: string;
  likesCount: number;
  commentsCount: number;
  likedByGuestIds: string[];
  reactions: { reaction: string; guestId: string }[];
  comments: unknown[];
  createdAt: string;
}

export interface IngestBufferOptions {
  /** Retained for call-site compatibility; absolute URLs come from CONFIG.PUBLIC_BASE_URL. */
  baseUrl?: string;
  photographerName?: string;
  caption?: string;
}

export type IngestRejection =
  | { ok: false; reason: 'not_an_image' }
  | { ok: false; reason: 'tier_limit'; message: string };

export type IngestOutcome = { ok: true; photo: IngestedPhoto } | IngestRejection;

/**
 * Shared professional-photo ingestion pipeline, used by both the REST ingest
 * endpoint and the in-process FTP server.
 *
 * Photographer frames are marked `source='photographer'` with `priority=10` so
 * they lead the projector rotation. They still respect the event's own rules:
 * the plan's photo allowance applies, and when the host has moderation switched
 * on the photo waits for approval instead of going straight to the guest feed.
 */
export async function ingestPhoto(
  eventId: string,
  buffer: Buffer,
  originalname: string,
  mimetype: string,
  options: IngestBufferOptions
): Promise<IngestOutcome> {
  if (!buffer || !isImageMagicBytes(buffer)) return { ok: false, reason: 'not_an_image' };
  if (!mimetype || !mimetype.startsWith('image/')) return { ok: false, reason: 'not_an_image' };

  // Charge the incoming frame against the plan before anything is written. A
  // photographer batch is the fastest way to exhaust an allowance.
  const tierCheck = await checkPhotoUploadTierLimit(eventId, buffer.length);
  if (!tierCheck.allowed) {
    return { ok: false, reason: 'tier_limit', message: tierCheck.reason || 'Plan limit reached' };
  }

  const photographerName = options.photographerName?.trim() || 'Official Photographer';
  const caption = options.caption?.trim() || null;

  const eventRes = await pool.query(
    'SELECT is_moderation_enabled FROM events WHERE id = $1',
    [eventId]
  );
  const status = eventRes.rows[0]?.is_moderation_enabled ? 'pending' : 'approved';
  // MED-03/SEC-M5 — same gap as the guest upload path (server/routes/photos.ts):
  // a pending photographer frame must not land on a publicly-reachable path
  // just because it came through FTP or the batch-ingest endpoint instead.
  const needsQuarantine = status === 'pending';

  // A single dedicated "photographer" guest row carries all pro photos for the event.
  const guestRes = await pool.query(
    `INSERT INTO guests (event_id, name, avatar_url, device_fingerprint, is_vip)
     VALUES ($1, $2, NULL, 'photographer', true)
     ON CONFLICT (event_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [eventId, photographerName]
  );
  const photographerGuest = guestRes.rows[0];

  const ext = path.extname(originalname).toLowerCase();
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg';
  const stem = `pro-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // A DSLR frame is many megabytes; serving it as a gallery thumbnail is the
  // single largest bandwidth cost at a venue, so derive both sizes up front.
  // Magic bytes only prove the header: a truncated or corrupt file still fails
  // to decode, and that is a rejected upload, not a server error.
  let derivatives;
  try {
    derivatives = await buildDerivatives(buffer);
  } catch (err) {
    console.warn(
      `[Ingest] ${originalname} could not be decoded:`,
      err instanceof Error ? err.message : err
    );
    return { ok: false, reason: 'not_an_image' };
  }

  // Filenames keep the `pro-<ts>-<rand>` convention this path has always used;
  // only the writing, cleanup and quota protocol are shared.
  const saved = await savePhotoVariants(
    eventId,
    {
      display:   { buffer: derivatives.display,   filename: `${stem}.jpg`,              mimetype: 'image/jpeg' },
      thumbnail: { buffer: derivatives.thumbnail, filename: `${stem}-thumb.jpg`,        mimetype: 'image/jpeg' },
      original:  { buffer,                        filename: `${stem}-original${safeExt}`, mimetype },
    },
    needsQuarantine,
    'Ingest'
  );

  const written = await insertPhotoUnderQuota({
    eventId,
    storageBytes: saved.totalBytes,
    cleanup: saved.cleanup,
    insert: async (client) => {
      const insert = await client.query(
        `INSERT INTO photos (
           event_id, guest_id, storage_path, full_url, thumbnail_url,
           original_url, original_storage_path, original_bytes,
           caption, status, source, priority, photographer_name, width, height, storage_bytes,
           is_quarantined
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'photographer', 10, $11, $12, $13, $14, $15)
         RETURNING id, event_id, guest_id, storage_path, full_url, thumbnail_url, original_url,
                   caption, status, source, priority, photographer_name, filter_applied,
                   likes_count, comments_count, created_at`,
        [
          eventId,
          photographerGuest.id,
          saved.display.storagePath,
          toAbsoluteUrl(saved.display.publicUrl),
          toAbsoluteUrl(saved.thumbnail.publicUrl),
          saved.original ? toAbsoluteUrl(saved.original.publicUrl) : null,
          saved.original ? saved.original.storagePath : null,
          buffer.length,
          caption,
          status,
          photographerName,
          derivatives.width || null,
          derivatives.height || null,
          saved.totalBytes,
          // H4 — same indexed flag the guest upload path sets.
          needsQuarantine,
        ]
      );
      return insert.rows[0];
    },
  });

  if (!written.ok) {
    return {
      ok: false,
      reason: 'tier_limit',
      message: written.reason === 'event_not_found' ? 'Event not found' : written.message,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = written.row;
  const hostUserId = written.hostUserId;

  const photo: IngestedPhoto = {
    id: row.id,
    eventId: row.event_id,
    guestId: row.guest_id,
    guestName: photographerGuest.name,
    storagePath: row.storage_path,
    thumbnailUrl: row.thumbnail_url || row.full_url,
    fullUrl: row.full_url,
    originalUrl: row.original_url,
    caption: row.caption,
    status: row.status,
    source: row.source,
    priority: row.priority,
    photographerName: row.photographer_name,
    filterApplied: row.filter_applied,
    likesCount: row.likes_count,
    commentsCount: row.comments_count,
    likedByGuestIds: [],
    reactions: [],
    comments: [],
    createdAt: row.created_at,
  };

  broadcastPhotoAdded({
    eventId,
    photoId: photo.id,
    photo,
    status,
    needsQuarantine,
    hostUserId,
    hasOriginal: Boolean(photo.originalUrl),
    // Photographer frames are never disposable-locked, so there is no reveal
    // time to withhold them until.
    lockedUntil: null,
  });

  return { ok: true, photo };
}

/**
 * Back-compatible wrapper returning the photo or null.
 * Prefer {@link ingestPhoto}, which explains *why* an upload was rejected.
 */
export async function ingestPhotoBuffer(
  eventId: string,
  buffer: Buffer,
  originalname: string,
  mimetype: string,
  options: IngestBufferOptions
): Promise<IngestedPhoto | null> {
  const outcome = await ingestPhoto(eventId, buffer, originalname, mimetype, options);
  return outcome.ok ? outcome.photo : null;
}
