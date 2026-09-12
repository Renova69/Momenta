import { ScavengerQuest } from '../types';
import { questsApi } from '../api/questsApi';
import { STORAGE_KEYS, getOrCreateDeviceFingerprint } from './storageKeys';
import { ServiceContext } from './storageServiceContext';

export function getQuests(ctx: ServiceContext, eventId?: string): ScavengerQuest[] {
  const targetId = eventId || ctx.getEvent().id;
  try {
    const data = localStorage.getItem(STORAGE_KEYS.QUESTS(targetId));
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function completeQuest(ctx: ServiceContext, questId: string, guestId: string): void {
  const event = ctx.getEvent();
  const quests = getQuests(ctx, event.id).map((q) => {
    if (q.id === questId) {
      const completed = q.completedByGuestIds || [];
      if (!completed.includes(guestId)) {
        return {
          ...q,
          completedByGuestIds: [...completed, guestId],
        };
      }
    }
    return q;
  });

  localStorage.setItem(STORAGE_KEYS.QUESTS(event.id), JSON.stringify(quests));
  ctx.notify();

  // Sync quest completion
  questsApi
    .complete(
      questId,
      guestId,
      undefined,
      ctx.getCurrentGuest(event.id)?.guestToken,
      // H8 — same reason as the comment path: identifies a returning
      // device so the server need not mint a guest row per request.
      getOrCreateDeviceFingerprint()
    )
    .then((result) => {
      ctx.syncGuestFromServer(event.id, result.guestId, result.guestToken);
    })
    .catch(() => {});
}

export function addQuest(
  ctx: ServiceContext,
  title: string,
  description: string,
  iconName: string = 'camera',
  points: number = 10
): ScavengerQuest {
  const event = ctx.getEvent();
  const localId = 'quest-' + Date.now();
  const newQuest: ScavengerQuest = {
    id: localId,
    eventId: event.id,
    title: title.trim(),
    description: description.trim(),
    iconName,
    points,
    isActive: true,
    completedByGuestIds: [],
  };

  const quests = [...getQuests(ctx, event.id), newQuest];
  localStorage.setItem(STORAGE_KEYS.QUESTS(event.id), JSON.stringify(quests));
  ctx.notify();

  // Sync to backend
  questsApi.create(event.id, { title, description, iconName, points, localId })
    .then((serverQuest) => {
      if (serverQuest && serverQuest.id) {
        const current = getQuests(ctx, event.id).map((q) => (q.id === newQuest.id ? serverQuest : q));
        localStorage.setItem(STORAGE_KEYS.QUESTS(event.id), JSON.stringify(current));
        ctx.notify();
      }
    })
    .catch((e) => console.warn('Could not post quest to backend:', e));

  return newQuest;
}
