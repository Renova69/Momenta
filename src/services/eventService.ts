import { WeddingEvent, PlanTier } from '../types';
import { eventsApi } from '../api/eventsApi';
import { subscriptionsApi } from '../api/subscriptionsApi';
import { INITIAL_EVENT } from './defaultEvent';
import { STORAGE_KEYS } from './storageKeys';
import { normalizeEvent, RemoteEventPayload } from './eventNormalization';
import { ServiceContext } from './storageServiceContext';
import { i18n } from '../i18n';

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
  // The address this album had before the edit — the one a rollback must
  // look it up by, since the edit may have been refused (N-62).
  const previousSlug = current.slug;
  const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEYS.EVENT(updated.id), JSON.stringify(updated));
  localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, updated.id);
  ctx.notify();

  if (syncBackend && updated.id) {
    eventsApi
      .update(updated.id, updates)
      .then((saved) => {
        // N-62 — a taken or reserved address is stored as a variant. The
        // answer used to be discarded, so the QR studio, projector and PDFs
        // kept printing the address that was asked for: someone else's
        // album, or nothing.
        // N-109 — the server sets the disposable reveal itself (on, off, or a
        // wedding moved past it), so the studio takes it from the answer.
        const savedRow = saved as { reveal_at?: string | null } | undefined;
        if (('isDisposableMode' in updates || 'eventDate' in updates) && savedRow && 'reveal_at' in savedRow) {
          ctx.updateEvent({ revealAt: savedRow.reveal_at ?? null }, false);
        }

        const storedSlug = (saved as Partial<WeddingEvent> | undefined)?.slug;
        if ('slug' in updates && storedSlug && storedSlug !== updated.slug) {
          ctx.updateEvent({ slug: storedSlug }, false);
          ctx.notifyError(i18n.t('host.slug_adjusted', { slug: storedSlug }));
        }
      })
      .catch((err: unknown) => {
        console.warn('[Storage] Event update was not saved to the server:', err);
        const message = err instanceof Error ? err.message : String(err);
        ctx.notifyError(message);
        // Re-read authoritative state so the UI stops showing a change the
        // server rejected (an expired session, or a tier-gated setting) —
        // by the address the album had before, since a refused rename
        // left the optimistic one, which does not exist.
        void refreshEventFromBackend(ctx, previousSlug);
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

/**
 * Re-read only the album's own record — its plan above all — without the
 * feed sync and room join loadEventBySlug also runs. For polling while a
 * purchase settles (N-54): quiet, cheap, and a failed attempt just waits for
 * the next one.
 */
export async function refreshEventDetails(ctx: ServiceContext): Promise<void> {
  const slug = getEvent()?.slug;
  if (!slug) return;
  try {
    const remote = await eventsApi.getBySlug(slug);
    if (remote && (remote.id || remote.slug)) {
      ctx.updateEvent(normalizeEvent(remote as RemoteEventPayload), false);
    }
  } catch {
    // Offline or a blip: the next poll asks again.
  }
}

/** Pull the event back from the server, discarding a rejected local edit. */
export async function refreshEventFromBackend(ctx: ServiceContext, slugOverride?: string): Promise<void> {
  const slug = slugOverride || getEvent()?.slug;
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
    // 404 is an answer: there is no album at this address. Anything else —
    // a dead network at the venue, a server error — is the question failing
    // to arrive, and reporting that as "not found" sends a guest with a
    // perfectly good QR code to a dead end.
    // Only a 404 is an answer. Anything else — a 500, or a fetch that threw
    // with no status at all because the venue's wifi dropped — is the
    // question never arriving, and must not be reported as "no such album".
    if ((e as { status?: number })?.status !== 404) throw e;
    console.warn('Could not load event by slug from backend:', e);
  }
  return null;
}

/**
 * Open the album a host has just signed in to, or registered (N-110).
 *
 * The sign-in answer carries the album as a raw row, and it used to be passed
 * straight to `updateEvent`: merged over whatever album this browser had
 * cached, so every field the studio reads kept the cached value — on a fresh
 * browser the demo wedding's couple, date and venue — with the settings left
 * at their defaults, and the merge PUT back to the server. The album is read
 * from the server instead, in full now that the owner is signed in; offline,
 * the sign-in answer is read properly and nothing is written back.
 */
export async function openSignedInAlbum(ctx: ServiceContext, signedIn: RemoteEventPayload): Promise<void> {
  if (!signedIn?.slug) return;
  let loaded: WeddingEvent | null = null;
  try {
    loaded = await loadEventBySlug(ctx, signedIn.slug);
  } catch {
    // Offline or a server error: fall through to what sign-in returned.
  }
  if (!loaded) ctx.updateEvent(normalizeEvent(signedIn), false);
}
