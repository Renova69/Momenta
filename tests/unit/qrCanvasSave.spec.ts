import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { updateQRCanvasConfig, getQRCanvasConfig } from '../../src/services/qrCanvasService';
import { eventsApi } from '../../src/api/eventsApi';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { QRCanvasConfig, WeddingEvent } from '../../src/types';

/**
 * N-91 — a QR studio change is shown at once and saved in the background, and
 * a save the server refused was dropped without a word (`.catch(() => {})`).
 * The host saw the design they had made, printed from it, and found the
 * album's real QR settings were still the old ones on any other screen.
 */

const EVENT_ID = 'qr-event-1';

function harness() {
  const notifyError = vi.fn();
  const notify = vi.fn();
  const ctx = {
    getEvent: () => ({ id: EVENT_ID }) as WeddingEvent,
    notify,
    notifyError,
  } as unknown as ServiceContext;
  return { ctx, notify, notifyError };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saving a QR studio change (N-91)', () => {
  it('says so when the server refuses it', async () => {
    const h = harness();
    vi.spyOn(eventsApi, 'updateQRConfig').mockRejectedValue(new Error('Your session has expired'));
    vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue(null as never);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    updateQRCanvasConfig(h.ctx, { headline: 'Scan me' } as Partial<QRCanvasConfig>);
    await flush();

    expect(h.notifyError).toHaveBeenCalledWith('Your session has expired');
  });

  it('puts back what the server holds, so the studio stops showing an unsaved design', async () => {
    const h = harness();
    const saved = { eventId: EVENT_ID, headline: 'Saved before' } as unknown as QRCanvasConfig;
    vi.spyOn(eventsApi, 'updateQRConfig').mockRejectedValue(new Error('refused'));
    vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue(saved);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    updateQRCanvasConfig(h.ctx, { headline: 'Never saved' } as Partial<QRCanvasConfig>);
    await flush();

    expect((getQRCanvasConfig(h.ctx, EVENT_ID) as unknown as { headline: string }).headline).toBe('Saved before');
  });

  it('stays quiet when the save goes through', async () => {
    const h = harness();
    vi.spyOn(eventsApi, 'updateQRConfig').mockResolvedValue({} as QRCanvasConfig);

    updateQRCanvasConfig(h.ctx, { headline: 'Scan me' } as Partial<QRCanvasConfig>);
    await flush();

    expect(h.notifyError).not.toHaveBeenCalled();
  });
});
