import { QRCanvasConfig } from '../types';

export const STORAGE_KEYS = {
  // The full event object is partitioned per event id, like every other key
  // here — a single shared key meant a device that ever viewed more than one
  // wedding on the same browser had one album's cached data (previously
  // including the host's real email/user id, before the server started
  // scoping those to authenticated host requests only) sitting under a key
  // any subsequently-loaded event could not help but share (SEC-A8).
  // ACTIVE_EVENT_ID is just a pointer — safe to stay global, since knowing
  // *which* event id was last viewed carries nothing sensitive by itself.
  ACTIVE_EVENT_ID: 'wedmoments_active_event_id',
  EVENT: (eventId: string) => `wedmoments_event_${eventId}`,
  CURRENT_GUEST: (eventId: string) => `wedmoments_current_guest_${eventId}`,
  DEVICE_ID: 'wedmoments_device_id',
  GUESTS: (eventId: string) => `wedmoments_guests_${eventId}`,
  PHOTOS: (eventId: string) => `wedmoments_photos_${eventId}`,
  QUESTS: (eventId: string) => `wedmoments_quests_${eventId}`,
  AUDIO: (eventId: string) => `wedmoments_audio_${eventId}`,
  QR_CANVAS: (eventId: string) => `wedmoments_qr_canvas_${eventId}`,
};

/**
 * Generic empty QR canvas config for an event with none cached yet.
 * Deliberately not the demo fixture's own headline/subtext/colors (P8) -
 * `QRCanvasStudio` already falls back to i18n defaults for blank text fields.
 */
export function defaultQRCanvasConfig(eventId: string): QRCanvasConfig {
  return {
    id: '',
    eventId,
    canvasSize: 'A2',
    frameStyle: 'minimal_gold',
    headline: '',
    subtext: '',
    accentColor: '#D4AF37',
    centerIcon: 'heart',
  };
}

export function getOrCreateDeviceFingerprint(): string {
  if (typeof window === 'undefined') return 'server';
  let deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
  if (!deviceId) {
    deviceId = `dev-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
  }
  return deviceId;
}
