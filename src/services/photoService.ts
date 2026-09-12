import { Photo, PhotoStatus, PhotoFilter, PhotoReactionKind } from '../types';
import { photosApi } from '../api/photosApi';
import { offlineQueue, QueuedUpload } from './offlineQueueService';
import { getOrCreateDeviceFingerprint } from './storageKeys';
import { readPhotos, persistPhotos, rememberPendingPreview, forgetPendingPreview } from './photoStore';
import { runThrottledPhotoUpload } from './photoUploadThrottle';
import { ServiceContext } from './storageServiceContext';


/**
 * True when the server rejected our stored guest identity outright — the
 * token no longer verifies (a host reset it, M10) or none was supplied.
 * Holding on to it after that only produces more silent failures.
 */
function isGuestIdentityRejected(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'GUEST_TOKEN_REQUIRED' || code === 'GUEST_IDENTITY_REQUIRED';
}

export function getPhotos(ctx: ServiceContext, eventId?: string): Photo[] {
  return readPhotos(eventId || ctx.getEvent().id);
}

export async function addPhoto(
  ctx: ServiceContext,
  photoData: {
    guestId: string;
    guestName: string;
    guestAvatar?: string;
    guestTable?: string;
    fullUrl: string;
    thumbnailUrl?: string;
    originalUrl?: string;
    caption?: string;
    filterApplied?: PhotoFilter;
    questId?: string;
    questTitle?: string;
  }
): Promise<Photo> {
  const event = ctx.getEvent();
  const localPhoto: Photo = {
    // [FIX M-10] Add random suffix to prevent ID collisions in bulk upload (same ms)
    id: 'photo-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
    eventId: event.id,
    guestId: photoData.guestId,
    guestName: photoData.guestName,
    guestAvatar: photoData.guestAvatar,
    guestTable: photoData.guestTable,
    questId: photoData.questId,
    questTitle: photoData.questTitle,
    storagePath: `events/${event.id}/${Date.now()}.jpg`,
    thumbnailUrl: photoData.thumbnailUrl || photoData.fullUrl,
    fullUrl: photoData.fullUrl,
    caption: photoData.caption,
    status: event.isModerationEnabled ? 'pending' : 'approved',
    isLocked: event.isDisposableMode,
    filterApplied: photoData.filterApplied || 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    comments: [],
    createdAt: new Date().toISOString(),
  };

  // H1 — hold this capture's preview in memory before it is ever written.
  // persistPhotos is then free to drop the inline `data:` URL from storage to
  // fit the quota without the feed card going blank: readPhotos puts it back
  // for the rest of the session. The record itself always survives.
  rememberPendingPreview(localPhoto.id, {
    fullUrl: localPhoto.fullUrl,
    thumbnailUrl: localPhoto.thumbnailUrl,
  });

  // Save locally immediately for optimistic UI
  persistPhotos(event.id, [localPhoto, ...getPhotos(ctx, event.id)]);

  if (photoData.questId) {
    ctx.completeQuest(photoData.questId, photoData.guestId);
  }
  ctx.notify();

  // Async push to backend PostgreSQL and Cloudflare R2. The device fingerprint
  // travels with the upload so the server can anchor the per-guest photo cap to
  // the device rather than to a client-supplied guest id.
  const uploadPayload = {
    ...photoData,
    eventId: event.id,
    localId: localPhoto.id,
    deviceFingerprint: getOrCreateDeviceFingerprint(),
    guestToken: ctx.getCurrentGuest(event.id)?.guestToken,
  };

  runThrottledPhotoUpload(() =>
    photosApi.create(uploadPayload)
      .then((serverPhoto) => {
        if (serverPhoto && serverPhoto.id) {
          // The token proves identity — it has no place in a Photo record
          // that gets rendered, exported and shared.
          const { guestToken, ...photoFields } = serverPhoto as typeof serverPhoto & { guestToken?: string };
          ctx.syncGuestFromServer(event.id, photoFields.guestId, guestToken);
          const currentPhotos = getPhotos(ctx, event.id);
          // MED-03/SEC-M5: while a photo is quarantined (pending moderation,
          // or disposable-locked), the server's fullUrl/thumbnailUrl point
          // at a path that isn't publicly reachable at all — only a signed
          // host preview link works, and this caller is the uploading guest,
          // not necessarily the host. The guest already has a perfectly good
          // local preview of their own capture; keep it instead of
          // clobbering it with a URL that would just 404 for them.
          const isQuarantinedForGuest =
            typeof photoFields.fullUrl === 'string' && photoFields.fullUrl.includes('quarantine');
          const updated = currentPhotos.map((p) => {
            if (p.id !== localPhoto.id) return p;
            const merged = { ...p, ...photoFields };
            if (isQuarantinedForGuest) {
              merged.fullUrl = p.fullUrl;
              merged.thumbnailUrl = p.thumbnailUrl;
            }
            return merged;
          });
          // The server's own URL has taken over, so the in-memory preview is
          // now stale weight. A quarantined photo is the exception: its real
          // URL is unreachable for this guest, so the local preview stays the
          // only thing that renders.
          if (!isQuarantinedForGuest) forgetPendingPreview(localPhoto.id);
          persistPhotos(event.id, updated);
          ctx.notify();
        }
      })
      .catch((e) => {
        console.warn('Could not post photo to backend, enqueuing for offline sync:', e);
        offlineQueue.enqueue('photo', uploadPayload);
      })
  );

  return localPhoto;
}

export function toggleLikePhoto(ctx: ServiceContext, photoId: string, guestId: string): void {
  const event = ctx.getEvent();
  const photos = getPhotos(ctx, event.id).map((p) => {
    if (p.id === photoId) {
      const likedIds = p.likedByGuestIds || [];
      const isLiked = likedIds.includes(guestId);
      const updatedLikes = isLiked
        ? likedIds.filter((id) => id !== guestId)
        : [...likedIds, guestId];
      return {
        ...p,
        likedByGuestIds: updatedLikes,
        likesCount: updatedLikes.length,
      };
    }
    return p;
  });

  persistPhotos(event.id, photos);
  ctx.notify();

  // Sync to PostgreSQL backend
  photosApi.toggleLike(photoId, guestId, ctx.getCurrentGuest(event.id)?.guestToken).catch((err) => {
    console.warn('[Storage] Like not synced to backend:', err);
    if (isGuestIdentityRejected(err)) ctx.forgetGuestIdentity(event.id);
  });
}

/** Toggles one emoji reaction on a photo — independent of the others, unlike toggleLikePhoto's single boolean. */
export function togglePhotoReaction(ctx: ServiceContext, photoId: string, reaction: PhotoReactionKind, guestId: string): void {
  const event = ctx.getEvent();
  const photos = getPhotos(ctx, event.id).map((p) => {
    if (p.id !== photoId) return p;
    const reactions = p.reactions || [];
    const hasReacted = reactions.some((r) => r.guestId === guestId && r.reaction === reaction);
    const updated = hasReacted
      ? reactions.filter((r) => !(r.guestId === guestId && r.reaction === reaction))
      : [...reactions, { reaction, guestId }];
    return { ...p, reactions: updated };
  });

  persistPhotos(event.id, photos);
  ctx.notify();

  photosApi.toggleReaction(photoId, reaction, guestId, ctx.getCurrentGuest(event.id)?.guestToken).catch((err) => {
    console.warn('[Storage] Reaction not synced to backend:', err);
    if (isGuestIdentityRejected(err)) ctx.forgetGuestIdentity(event.id);
  });
}

export function addComment(ctx: ServiceContext, photoId: string, guestId: string, guestName: string, commentText: string): void {
  if (!commentText.trim()) return;
  const event = ctx.getEvent();
  const localId = 'comm-' + Date.now();
  const newComment = {
    id: localId,
    photoId,
    guestId,
    guestName,
    commentText: commentText.trim(),
    createdAt: new Date().toISOString(),
  };

  const photos = getPhotos(ctx, event.id).map((p) => {
    if (p.id === photoId) {
      const comments = [...(p.comments || []), newComment];
      return {
        ...p,
        comments,
        commentsCount: comments.length,
      };
    }
    return p;
  });

  persistPhotos(event.id, photos);
  ctx.notify();

  // Sync to PostgreSQL backend
  photosApi
    .addComment(
      photoId,
      guestId,
      guestName,
      commentText,
      localId,
      ctx.getCurrentGuest(event.id)?.guestToken,
      // H8 — lets the server recognise this device when the token is
      // missing, instead of it minting a fresh guest row per comment.
      getOrCreateDeviceFingerprint()
    )
    .then((serverComment) => {
      ctx.syncGuestFromServer(event.id, serverComment.guestId, serverComment.guestToken);
    })
    .catch((err) => {
      if (isGuestIdentityRejected(err)) ctx.forgetGuestIdentity(event.id);
    });
}

export function setPhotoStatus(ctx: ServiceContext, photoId: string, status: PhotoStatus): void {
  const event = ctx.getEvent();
  const photos = getPhotos(ctx, event.id).map((p) => {
    if (p.id === photoId) return { ...p, status };
    return p;
  });
  persistPhotos(event.id, photos);
  ctx.notify();

  // Sync to PostgreSQL backend
  photosApi.setStatus(photoId, status).catch(() => {});
}

export async function deletePhoto(ctx: ServiceContext, photoId: string): Promise<void> {
  const event = ctx.getEvent();
  const currentPhotos = getPhotos(ctx, event.id);
  const photoToDelete = currentPhotos.find((p) => p.id === photoId);

  // Optimistic delete
  const photos = currentPhotos.filter((p) => p.id !== photoId);
  forgetPendingPreview(photoId);
  persistPhotos(event.id, photos);
  ctx.notify();

  // addPhoto() gives every optimistic local photo an id like `photo-<ts>-<rand>`
  // before the server round-trip reconciles it with a real UUID. If that
  // round-trip never lands (upload still in flight, failed silently, or the
  // tab crashed mid-upload), the photo shown in the gallery still carries
  // this placeholder id — there is no server row for it at all. Sending it
  // to DELETE /api/photos/:id used to 400 on UUID validation, and the
  // resulting error re-added the photo via the rollback below, making it
  // look like this specific photo could never be deleted.
  if (photoId.startsWith('photo-')) {
    return;
  }

  // Sync deletion to PostgreSQL backend & R2
  try {
    await photosApi.delete(photoId);
  } catch (err) {
    console.warn('[Storage] Delete failed, restoring photo UI:', err);
    if (photoToDelete) {
      // Rollback on failure
      const restored = [...getPhotos(ctx, event.id), photoToDelete];
      persistPhotos(event.id, restored);
      ctx.notify();
    }
  }
}

/**
 * FE-03 — flushQueue() uploads a queued photo and deletes it from IndexedDB
 * without telling storageService the server-assigned id, so the next
 * syncFromBackend() pull added the server row as a brand-new photo while the
 * temp-id row was never cleaned up. Reconciling here replaces the local
 * temp-id row in place instead.
 */
export function reconcileFlushedPhoto(ctx: ServiceContext, item: QueuedUpload, serverResponse: Record<string, unknown>): void {
  const localId = (item.payload as Record<string, unknown>).localId as string | undefined;
  const eventId = ((item.payload as Record<string, unknown>).eventId as string | undefined) || ctx.getEvent().id;
  if (!localId || !serverResponse.id) return;

  const { guestToken, ...photoFields } = serverResponse as Record<string, unknown> & {
    guestToken?: string;
    guestId?: string;
  };
  ctx.syncGuestFromServer(eventId, photoFields.guestId as string | undefined, guestToken);

  const currentPhotos = getPhotos(ctx, eventId);
  const updated = currentPhotos.map((p) => (p.id === localId ? { ...p, ...photoFields } : p));
  // Same reasoning as addPhoto's success path: a reachable server URL makes
  // the in-memory preview redundant, a quarantined one does not.
  if (typeof photoFields.fullUrl !== 'string' || !photoFields.fullUrl.includes('quarantine')) {
    forgetPendingPreview(localId);
  }
  persistPhotos(eventId, updated);
  ctx.notify();
}
