import { QRCanvasConfig } from '../types';
import { eventsApi } from '../api/eventsApi';
import { STORAGE_KEYS, defaultQRCanvasConfig } from './storageKeys';
import { ServiceContext } from './storageServiceContext';

export function getQRCanvasConfig(ctx: ServiceContext, eventId?: string): QRCanvasConfig {
  const targetId = eventId || ctx.getEvent().id;
  try {
    const data = localStorage.getItem(STORAGE_KEYS.QR_CANVAS(targetId));
    return data ? JSON.parse(data) : defaultQRCanvasConfig(targetId);
  } catch {
    return defaultQRCanvasConfig(targetId);
  }
}

export function updateQRCanvasConfig(ctx: ServiceContext, updates: Partial<QRCanvasConfig>): QRCanvasConfig {
  const event = ctx.getEvent();
  const current = getQRCanvasConfig(ctx, event.id);
  const updated = { ...current, ...updates };
  localStorage.setItem(STORAGE_KEYS.QR_CANVAS(event.id), JSON.stringify(updated));
  ctx.notify();

  if (event.id) {
    eventsApi.updateQRConfig(event.id, updates).catch(() => {});
  }

  return updated;
}
