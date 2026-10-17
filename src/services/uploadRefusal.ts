import { i18n } from '../i18n';

/**
 * When an upload the server answered can never succeed, however often it is
 * sent again — and what to tell the person who sent it.
 *
 * N-150 — every failed upload used to be handed to the offline queue, as if
 * the network had failed. A full album answers 403, and the queue retried it
 * five times while the guest's photo sat in the feed looking sent. These are
 * answers that only the couple can change, or that no retry can.
 */

/** Malformed, too large, the album gone, or the wrong type: a retry gets the same answer. */
const STATUSES_REFUSED_FOR_GOOD = new Set([400, 404, 413, 415, 422]);

/**
 * Refusals known by their code, not their status. Every 403 the app sends
 * carries one; a 403 without came from something between the phone and the
 * server, a venue's captive portal or proxy, and must not cost the guest the
 * photo. The guest's own limit comes as a 429, the rate limiter's status, and
 * only its code says that waiting will not help.
 */
const CODES_REFUSED_FOR_GOOD = new Set([
  'TIER_LIMIT_REACHED',
  'STORAGE_LIMIT_REACHED',
  'GUEST_PHOTO_LIMIT_REACHED',
  'TIER_REQUIRED',
  'DELETION_IN_PROGRESS',
  // N-159 — reopened only by the couple buying a longer plan.
  'ALBUM_CLOSED',
]);

/** Codes meaning the album as a whole has reached its plan's limit. */
const ALBUM_FULL_CODES = new Set(['TIER_LIMIT_REACHED', 'STORAGE_LIMIT_REACHED']);

export function isRefusedForGood(status: number, code?: string): boolean {
  return (code !== undefined && CODES_REFUSED_FOR_GOOD.has(code)) || STATUSES_REFUSED_FOR_GOOD.has(status);
}

/**
 * The words for a refused upload, for whoever sent it.
 *
 * A full album is said in words that fit a guest and a host alike: the
 * server's own text ("upgrade your plan") is the host's, and a guest cannot
 * act on it. Anything else keeps the server's reason, which the API client has
 * already put into the app's language when the server sent a code.
 */
export function refusedUploadMessage(kind: 'photo' | 'audio', code: string | undefined, reason: string): string {
  if (code !== undefined && ALBUM_FULL_CODES.has(code)) {
    return i18n.t(kind === 'audio' ? 'upload.album_full_audio' : 'upload.album_full');
  }
  return i18n.t(kind === 'audio' ? 'upload.audio_not_sent' : 'upload.photo_not_sent', { reason });
}
