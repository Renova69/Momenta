import { Guest } from '../types';
import { guestsApi } from '../api/guestsApi';
import { STORAGE_KEYS, getOrCreateDeviceFingerprint } from './storageKeys';
import { ServiceContext } from './storageServiceContext';
import { isGeneratedElsewhere } from '../utils/avatar';
import { i18n } from '../i18n';
import { ApiError } from '../api/apiClient';

/** A stored avatar worth keeping: a real selfie, not a generated stand-in. */
function keptPicture(avatarUrl: string | null | undefined): string | undefined {
  if (!avatarUrl || isGeneratedElsewhere(avatarUrl)) return undefined;
  return avatarUrl;
}

/** A selfie this phone is still holding itself, not yet stored by the server. */
function isInlinePicture(avatarUrl: string | null | undefined): avatarUrl is string {
  return typeof avatarUrl === 'string' && avatarUrl.startsWith('data:');
}

/**
 * Store the selfie this phone is holding, as the guest the server knows (N-107).
 *
 * It used to travel inside the registration as a data: URL, which the server
 * refused outright: the guest was never created, and every like, comment and
 * photo after it was refused too. Registration now goes without it, and it is
 * stored here once there is a guest and a token to store it as. If that fails
 * the guest stays joined without a picture, and is told — they chose one.
 */
async function storeInlineSelfie(ctx: ServiceContext, guest: Guest): Promise<Guest> {
  if (!isInlinePicture(guest.avatarUrl) || !guest.guestToken) return guest;
  try {
    const { avatarUrl } = await guestsApi.setAvatar(guest.id, {
      eventId: guest.eventId,
      guestToken: guest.guestToken,
      image: guest.avatarUrl,
    });
    return { ...guest, avatarUrl };
  } catch (err) {
    console.warn('Selfie was not stored:', err);
    // N-183 — a closed album takes no new pictures, so "try again from your
    // profile" could never work there.
    const closed = err instanceof ApiError && err.code === 'ALBUM_CLOSED';
    ctx.notifyError(i18n.t(closed ? 'error.album_closed' : 'profile.avatar_failed'));
    return { ...guest, avatarUrl: undefined };
  }
}

export function getGuests(ctx: ServiceContext, eventId?: string): Guest[] {
  const targetId = eventId || ctx.getEvent().id;
  try {
    const data = localStorage.getItem(STORAGE_KEYS.GUESTS(targetId));
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function getCurrentGuest(ctx: ServiceContext, eventId?: string): Guest | null {
  const targetId = eventId || ctx.getEvent()?.id;
  if (!targetId) return null;
  try {
    const data = localStorage.getItem(STORAGE_KEYS.CURRENT_GUEST(targetId));
    if (!data) return null;
    const parsed = JSON.parse(data);
    return parsed && parsed.eventId === targetId ? parsed : null;
  } catch {
    return null;
  }
}

export function setCurrentGuest(ctx: ServiceContext, guest: Guest): void {
  if (!guest.eventId) return;
  localStorage.setItem(STORAGE_KEYS.CURRENT_GUEST(guest.eventId), JSON.stringify(guest));
  ctx.notify();
}

/**
 * Reconcile the locally-stored guest identity with what the server actually
 * used for a mutation. Normally a no-op (the id and token already match) —
 * but if the server minted a different guestId (a stale or missing token
 * fell back to a fresh guest, server-side), the client must adopt both the
 * new id and its token together, or every subsequent action keeps sending
 * a guestId/token pair that no longer matches and keeps getting bounced.
 */
export function syncGuestFromServer(ctx: ServiceContext, eventId: string, guestId?: string, guestToken?: string): void {
  if (!guestId || !guestToken) return;
  const current = getCurrentGuest(ctx, eventId);
  if (current?.id === guestId && current?.guestToken === guestToken) return;
  const adopted: Guest = { ...(current || { name: i18n.t('guest.fallback_name'), createdAt: new Date().toISOString() }), id: guestId, eventId, guestToken };
  setCurrentGuest(ctx, adopted);

  // A guest who joined offline holds their selfie only here; this is the first
  // moment there is a server identity to store it as.
  if (isInlinePicture(adopted.avatarUrl)) {
    void storeInlineSelfie(ctx, adopted).then((stored) => {
      if (getCurrentGuest(ctx, eventId)?.id === stored.id) setCurrentGuest(ctx, stored);
    });
  }
}

export async function registerGuest(
  ctx: ServiceContext,
  name: string,
  tableNumber?: string,
  avatarUrl?: string
): Promise<Guest> {
  const event = ctx.getEvent();
  const current = getCurrentGuest(ctx, event.id);
  const deviceFingerprint = getOrCreateDeviceFingerprint();

  const localGuest: Guest = {
    id: current?.id || ('guest-' + Date.now()),
    eventId: event.id,
    name: name.trim() || 'Anonymous Guest',
    tableNumber: tableNumber?.trim() || undefined,
    // Only a picture the guest actually chose is stored. The generated one is
    // drawn from the name wherever it is shown (`guestAvatarUrl`), so writing
    // it here would persist, broadcast and export a value that is not data —
    // and the old version of it carried the guest's name to a third party.
    avatarUrl: avatarUrl || keptPicture(current?.avatarUrl),
    createdAt: current?.createdAt || new Date().toISOString(),
  };

  const existingGuests = getGuests(ctx, event.id);
  const otherGuests = existingGuests.filter((g) => g.id !== localGuest.id);
  const updatedGuests = [localGuest, ...otherGuests];

  try {
    localStorage.setItem(STORAGE_KEYS.GUESTS(event.id), JSON.stringify(updatedGuests));
    localStorage.setItem(STORAGE_KEYS.CURRENT_GUEST(event.id), JSON.stringify(localGuest));
  } catch (quotaError) {
    console.warn('Storage quota warning:', quotaError);
  }
  ctx.notify();

  // Sync to PostgreSQL backend
  try {
    const serverGuest = await guestsApi.register({
      eventId: event.id,
      name: localGuest.name,
      tableNumber: localGuest.tableNumber,
      // No picture (N-107): the server keeps the one on record and ignores any
      // sent here. A new one is stored below, once it has said who this is.
      deviceFingerprint,
    });
    if (serverGuest && serverGuest.id) {
      // H2 — POST /api/guests only returns a guestToken when the caller
      // actually proved this identity is theirs: a genuinely new row
      // (`xmax = 0`). That is deliberate on the server (SEC-03) — matching a
      // leaked, client-generated device fingerprint must not hand out a
      // durable credential for someone else's guest.
      //
      // So the *second* registration from the same device — a guest reopening
      // the profile modal to change their name — legitimately comes back
      // without a token. Overwriting wholesale dropped the token this browser
      // already held, and every later like/comment/reaction was rejected with
      // GUEST_TOKEN_REQUIRED. Those rejections are caught and logged, never
      // surfaced, so the guest just saw their likes quietly fail to stick.
      //
      // Carry the existing token forward only when the server agrees this is
      // still the same guest: a token is bound to one guestId and proves
      // nothing about a different one.
      const preservedToken = current?.id === serverGuest.id ? current?.guestToken : undefined;
      const resolved: Guest = {
        ...serverGuest,
        avatarUrl: isInlinePicture(localGuest.avatarUrl) ? localGuest.avatarUrl : serverGuest.avatarUrl ?? undefined,
        guestToken: serverGuest.guestToken ?? preservedToken,
      };
      const stored = await storeInlineSelfie(ctx, resolved);
      setCurrentGuest(ctx, stored);
      return stored;
    }
  } catch (err) {
    console.warn('Guest backend registration offline, using local session:', err);
  }

  return localGuest;
}

/**
 * Forget the guest identity stored for this event.
 *
 * Called when the server reports the stored token is no longer accepted —
 * after a host-initiated guest-session reset (M10), for instance. Without
 * this the browser keeps presenting a dead credential and every like, comment
 * and reaction fails silently, which is precisely the invisible-failure shape
 * H2 was about. Clearing it puts the guest back through onboarding, where
 * they get a working identity again.
 */
export function clearCurrentGuest(ctx: ServiceContext, eventId: string): void {
  if (!eventId) return;
  localStorage.removeItem(STORAGE_KEYS.CURRENT_GUEST(eventId));
  ctx.notify();
}
