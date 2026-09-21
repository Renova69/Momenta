import { ScavengerQuest } from '../types';
import { questsApi } from '../api/questsApi';
import { STORAGE_KEYS } from './storageKeys';
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

/**
 * Tick a quest on this phone the moment its photo is taken.
 *
 * Local only. The server records the completion when the photo upload lands
 * (with the photo, which is what scores) and broadcasts QUEST_COMPLETED; the
 * next sync replaces this list with the server's anyway. The tick exists for
 * the case the upload never lands: the card then reads "not counted" with a
 * retake, rather than silently reverting to an untried quest.
 */
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

/**
 * Remove a quest the host no longer wants.
 *
 * `DELETE /api/quests/:id` has existed and been documented all along; nothing
 * ever called it, so a mistyped quest stayed in front of every guest for the
 * whole reception. Removed locally first, like every other host action, and
 * put back if the server refuses — the completions it carried are gone with
 * it, which is why the dashboard asks first.
 */
export function deleteQuest(ctx: ServiceContext, questId: string): void {
  const event = ctx.getEvent();
  const before = getQuests(ctx, event.id);
  localStorage.setItem(STORAGE_KEYS.QUESTS(event.id), JSON.stringify(before.filter((q) => q.id !== questId)));
  ctx.notify();

  // A quest the server has never seen (the create call is still in flight, or
  // failed) has nothing to delete there.
  if (questId.startsWith('quest-')) return;

  questsApi.delete(questId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[Storage] Quest was not deleted on the server:', message);
    localStorage.setItem(STORAGE_KEYS.QUESTS(event.id), JSON.stringify(before));
    ctx.notify();
    ctx.notifyError(message);
  });
}
