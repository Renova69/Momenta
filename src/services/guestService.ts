import { Guest } from '../types';
import { guestsApi } from '../api/guestsApi';
import { STORAGE_KEYS, getOrCreateDeviceFingerprint } from './storageKeys';
import { ServiceContext } from './storageServiceContext';

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
  setCurrentGuest(ctx, { ...(current || { name: 'Guest', createdAt: new Date().toISOString() }), id: guestId, eventId, guestToken });
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
    avatarUrl: avatarUrl || current?.avatarUrl || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(name)}`,
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
      avatarUrl: localGuest.avatarUrl,
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
        guestToken: serverGuest.guestToken ?? preservedToken,
      };
      setCurrentGuest(ctx, resolved);
      return resolved;
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
