import { WeddingEvent, PlanTier } from '../types';
import { eventsApi } from '../api/eventsApi';
import { subscriptionsApi } from '../api/subscriptionsApi';
import { INITIAL_EVENT } from './defaultEvent';
import { STORAGE_KEYS } from './storageKeys';
import { normalizeEvent, RemoteEventPayload } from './eventNormalization';
import { ServiceContext } from './storageServiceContext';

export function getEvent(): WeddingEvent {
  try {
    const activeId = localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID);
    if (!activeId) return INITIAL_EVENT;
    const data = localStorage.getItem(STORAGE_KEYS.EVENT(activeId));
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed && (parsed.id || parsed.slug)) {
        return {
          ...INITIAL_EVENT,
          ...parsed,
          hostName: parsed.hostName ?? parsed.couple_names ?? parsed.coupleNames ?? parsed.host_name ?? INITIAL_EVENT.hostName,
          eventDate: parsed.eventDate ?? parsed.date ?? parsed.event_date ?? INITIAL_EVENT.eventDate,
          themePalette: parsed.themePalette ?? parsed.theme_palette ?? INITIAL_EVENT.themePalette,
          venueName: parsed.venueName ?? parsed.venue_name ?? INITIAL_EVENT.venueName,
          welcomeMessage: parsed.welcomeMessage ?? parsed.welcome_message ?? INITIAL_EVENT.welcomeMessage,
          planTier: parsed.planTier ?? parsed.plan_tier ?? INITIAL_EVENT.planTier,
          isModerationEnabled: parsed.isModerationEnabled ?? parsed.is_moderation_enabled ?? INITIAL_EVENT.isModerationEnabled,
          isDisposableMode: parsed.isDisposableMode ?? parsed.is_disposable_mode ?? INITIAL_EVENT.isDisposableMode,
          isPublic: parsed.isPublic ?? parsed.is_public ?? INITIAL_EVENT.isPublic,
        };
      }
    }
    return INITIAL_EVENT;
  } catch {
    return INITIAL_EVENT;
  }
}

export function updateEvent(ctx: ServiceContext, updates: Partial<WeddingEvent>, syncBackend: boolean = true): WeddingEvent {
  const current = getEvent();
  const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEYS.EVENT(updated.id), JSON.stringify(updated));
  localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, updated.id);
  ctx.notify();

  if (syncBackend && updated.id) {
    eventsApi.update(updated.id, updates).catch((err: unknown) => {
      console.warn('[Storage] Event update was not saved to the server:', err);
      const message = err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err);
      ctx.notifyError(message);
      // Re-read authoritative state so the UI stops showing a change the
      // server rejected (an expired session, or a tier-gated setting).
      void refreshEventFromBackend(ctx);
    });
  }

  return updated;
}

/**
 * Set the plan tier for real, then re-read the event from the server rather
 * than optimistically writing the new tier locally — the server's copy
 * (`getEffectiveTierForEvent`) is the only thing tier-gating ever trusts, so
 * showing anything else here would just reproduce the bug this replaces
 * (client claims an upgrade the server doesn't have).
 */
export async function upgradePlanTier(ctx: ServiceContext, tier: PlanTier): Promise<void> {
  await subscriptionsApi.upgrade(tier);
  await refreshEventFromBackend(ctx);
}

/** Pull the event back from the server, discarding a rejected local edit. */
export async function refreshEventFromBackend(ctx: ServiceContext): Promise<void> {
  const slug = getEvent()?.slug;
  if (!slug) return;
  try {
    await loadEventBySlug(ctx, slug);
  } catch {
    // Offline: the local copy is the best we have until connectivity returns.
  }
}

export async function loadEventBySlug(ctx: ServiceContext, slug: string): Promise<WeddingEvent | null> {
  if (!slug) return null;
  try {
    const remote = await eventsApi.getBySlug(slug);
    if (remote && (remote.id || remote.slug)) {
      const normalized = normalizeEvent(remote as RemoteEventPayload);

      ctx.updateEvent(normalized, false);
      ctx.joinEventRoom(normalized.id);
      await ctx.syncFromBackend(normalized.id);
      return normalized;
    }
  } catch (e) {
    console.warn('Could not load event by slug from backend:', e);
  }
  return null;
}
