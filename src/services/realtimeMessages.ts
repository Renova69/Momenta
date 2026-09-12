import { STORAGE_KEYS } from './storageKeys';
import { persistPhotos } from './photoStore';
import { normalizePartialEvent, RemoteEventPayload } from './eventNormalization';
import { ServiceContext } from './storageServiceContext';

/**
 * A message off the event WebSocket. The payload shape depends on `type`, so
 * each case narrows what it needs rather than trusting one union up front.
 */
export interface RealtimeMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  eventId?: string;
}

// Handle incoming real-time events with strict event-room filtering
export function applyRealtimeMessage(ctx: ServiceContext, msg: RealtimeMessage): void {
  const currentEvent = ctx.getEvent();
  const activeEventId = currentEvent.id;

  // Reject message if it belongs to a different wedding event
  if (msg.eventId && msg.eventId !== activeEventId) {
    return;
  }

  switch (msg.type) {
    case 'PHOTO_ADDED': {
      const payload = msg.payload;
      const currentPhotos = ctx.getPhotos(activeEventId);

      // If it matches a local optimistic photo, replace it to prevent duplicate
      if (payload.localId) {
        const localIndex = currentPhotos.findIndex(p => p.id === payload.localId);
        if (localIndex !== -1) {
          const updated = [...currentPhotos];
          updated[localIndex] = { ...updated[localIndex], ...payload };
          persistPhotos(activeEventId, updated);
          ctx.notify();
          break;
        }
      }

      if (!currentPhotos.some((p) => p.id === payload.id)) {
        const updated = [payload, ...currentPhotos];
        persistPhotos(activeEventId, updated);
        ctx.notify();
      }
      break;
    }
    case 'PHOTO_LIKED': {
      const { photoId, guestId } = msg.payload;
      const photos = ctx.getPhotos(activeEventId).map((p) => {
        if (p.id === photoId) {
          const likedIds = p.likedByGuestIds || [];
          if (!likedIds.includes(guestId)) {
            return { ...p, likedByGuestIds: [...likedIds, guestId], likesCount: likedIds.length + 1 };
          }
        }
        return p;
      });
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'PHOTO_UNLIKED': {
      const { photoId, guestId } = msg.payload;
      const photos = ctx.getPhotos(activeEventId).map((p) => {
        if (p.id === photoId) {
          const likedIds = p.likedByGuestIds || [];
          if (likedIds.includes(guestId)) {
            const updatedLikes = likedIds.filter((id) => id !== guestId);
            return { ...p, likedByGuestIds: updatedLikes, likesCount: updatedLikes.length };
          }
        }
        return p;
      });
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'PHOTO_REACTION_ADDED': {
      const { photoId, guestId, reaction } = msg.payload;
      const photos = ctx.getPhotos(activeEventId).map((p) => {
        if (p.id !== photoId) return p;
        const reactions = p.reactions || [];
        if (reactions.some((r) => r.guestId === guestId && r.reaction === reaction)) return p;
        return { ...p, reactions: [...reactions, { reaction, guestId }] };
      });
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'PHOTO_REACTION_REMOVED': {
      const { photoId, guestId, reaction } = msg.payload;
      const photos = ctx.getPhotos(activeEventId).map((p) => {
        if (p.id !== photoId) return p;
        const reactions = (p.reactions || []).filter((r) => !(r.guestId === guestId && r.reaction === reaction));
        return { ...p, reactions };
      });
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'COMMENT_ADDED': {
      const comment = msg.payload;
      const photos = ctx.getPhotos(activeEventId).map((p) => {
        if (p.id === comment.photoId) {
          let comments = p.comments || [];
          if (comment.localId && comments.some(c => c.id === comment.localId)) {
            comments = comments.map(c => c.id === comment.localId ? comment : c);
          } else if (!comments.some(c => c.id === comment.id)) {
            comments = [...comments, comment];
          }
          return {
            ...p,
            comments,
            commentsCount: comments.length,
          };
        }
        return p;
      });
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'PHOTO_STATUS_UPDATED': {
      const { photoId, status } = msg.payload;
      const photos = ctx.getPhotos(activeEventId).map((p) => {
        if (p.id === photoId) return { ...p, status };
        return p;
      });
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'PHOTO_REMOVED': {
      const { photoId } = msg.payload;
      const photos = ctx.getPhotos(activeEventId).filter((p) => p.id !== photoId);
      persistPhotos(activeEventId, photos);
      ctx.notify();
      break;
    }
    case 'QUEST_ADDED': {
      const quest = msg.payload;
      let currentQuests = ctx.getQuests(activeEventId);
      if (quest.localId && currentQuests.some(q => q.id === quest.localId)) {
        currentQuests = currentQuests.map(q => q.id === quest.localId ? quest : q);
        localStorage.setItem(STORAGE_KEYS.QUESTS(activeEventId), JSON.stringify(currentQuests));
        ctx.notify();
      } else if (!currentQuests.some(q => q.id === quest.id)) {
        const updated = [...currentQuests, quest];
        localStorage.setItem(STORAGE_KEYS.QUESTS(activeEventId), JSON.stringify(updated));
        ctx.notify();
      }
      break;
    }
    case 'QUEST_DELETED': {
      const { questId } = msg.payload;
      const quests = ctx.getQuests(activeEventId).filter((q) => q.id !== questId);
      localStorage.setItem(STORAGE_KEYS.QUESTS(activeEventId), JSON.stringify(quests));
      ctx.notify();
      break;
    }
    case 'QUEST_COMPLETED': {
      const { questId, guestId } = msg.payload;
      const quests = ctx.getQuests(activeEventId).map((q) => {
        if (q.id === questId) {
          const completed = q.completedByGuestIds || [];
          if (!completed.includes(guestId)) {
            return { ...q, completedByGuestIds: [...completed, guestId] };
          }
        }
        return q;
      });
      localStorage.setItem(STORAGE_KEYS.QUESTS(activeEventId), JSON.stringify(quests));
      ctx.notify();
      break;
    }
    case 'AUDIO_ADDED': {
      const entry = msg.payload;
      let currentAudio = ctx.getAudioEntries(activeEventId);
      if (entry.localId && currentAudio.some(a => a.id === entry.localId)) {
        currentAudio = currentAudio.map(a => a.id === entry.localId ? entry : a);
        localStorage.setItem(STORAGE_KEYS.AUDIO(activeEventId), JSON.stringify(currentAudio));
        ctx.notify();
      } else if (!currentAudio.some(a => a.id === entry.id)) {
        const updated = [entry, ...currentAudio];
        localStorage.setItem(STORAGE_KEYS.AUDIO(activeEventId), JSON.stringify(updated));
        ctx.notify();
      }
      break;
    }
    case 'EVENT_UPDATED': {
      // M1 — the server broadcasts toPublicEvent(), i.e. raw Postgres column
      // names (`theme_palette`, `is_moderation_enabled`). Merged verbatim they
      // never take effect: eventService.getEvent() resolves
      // `parsed.themePalette ?? parsed.theme_palette`, and the camelCase key is
      // already populated from the initial load, so the broadcast value loses
      // every time. Normalizing is what makes a host's live settings change
      // actually reach the guests watching.
      //
      // Partial, not full: toPublicEvent deliberately omits host-private
      // columns (host_email, host_user_id), and defaulting those would blank
      // them for a host watching their own event.
      ctx.updateEvent(normalizePartialEvent(msg.payload as RemoteEventPayload), false);
      break;
    }
    case 'REACTION_SENT': {
      // Purely ephemeral — animated on screen, never written to storage.
      const { reaction, guestName } = msg.payload || {};
      if (reaction) ctx.emitReaction(reaction, guestName ?? null);
      break;
    }
    case 'REACTIONS_BATCH': {
      // Several reactions the server coalesced into one message during a
      // burst (P6) — fan them out exactly like individual REACTION_SENT
      // messages so the projector wall's animation logic doesn't need to
      // know the difference.
      const reactions = (msg.payload?.reactions as { reaction?: string; guestName?: string | null }[]) || [];
      for (const item of reactions) {
        if (item?.reaction) ctx.emitReaction(item.reaction, item.guestName ?? null);
      }
      break;
    }
  }
}
