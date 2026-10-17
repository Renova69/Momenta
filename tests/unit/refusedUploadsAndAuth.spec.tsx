import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import React from 'react';

import { storageService } from '../../src/services/storageService';
import { offlineQueue } from '../../src/services/offlineQueueService';
import { addAudioEntry } from '../../src/services/audioService';
import { audioApi } from '../../src/api/audioApi';
import { ApiError } from '../../src/api/apiClient';
import { authService } from '../../src/services/authService';
import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { WeddingEvent, HostUser } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * Paths the coverage run showed nothing exercising: what the app does when a
 * queued upload is dropped (N-150), a voice message the server refuses, and
 * the host sign-in state every studio screen reads.
 */

function json(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}

const storedPhotos = (eventId: string) => JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(eventId)) || '[]');

beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const item of await offlineQueue.getQueue()) await offlineQueue.removeItem(item.id);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a queued upload the queue gives up on (N-150)', () => {
  it('takes a photo the full album refused off the phone, and says why', async () => {
    const eventId = 'event-drop-refused';
    localStorage.setItem(STORAGE_KEYS.PHOTOS(eventId), JSON.stringify([{ id: 'photo-local-1', eventId }]));
    const errors: string[] = [];
    const unsubscribe = storageService.subscribeErrors((m) => errors.push(m));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'Plan limit', code: 'TIER_LIMIT_REACHED' }, 403));

    await offlineQueue.enqueue('photo', { eventId, localId: 'photo-local-1' });

    await vi.waitFor(() => expect(errors).toContain(i18n.t('upload.album_full')));
    expect(storedPhotos(eventId)).toHaveLength(0);
    unsubscribe();
  });

  it('takes off a photo the server kept failing, with the message for a lost connection', async () => {
    const eventId = 'event-drop-retries';
    localStorage.setItem(STORAGE_KEYS.PHOTOS(eventId), JSON.stringify([{ id: 'photo-local-2', eventId }]));
    const errors: string[] = [];
    const unsubscribe = storageService.subscribeErrors((m) => errors.push(m));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'boom' }, 503));

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await offlineQueue.enqueue('photo', { eventId, localId: 'photo-local-2' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    for (let i = 0; i < 7; i++) await offlineQueue.flushQueue();

    await vi.waitFor(() => expect(errors).toContain(i18n.t('offline.photo_dropped')));
    expect(storedPhotos(eventId)).toHaveLength(0);
    unsubscribe();
  });
});

describe('a voice message the server refuses (N-150)', () => {
  function harness() {
    const notifyError = vi.fn();
    const ctx = {
      getEvent: () => ({ id: 'event-audio' }) as WeddingEvent,
      getCurrentGuest: () => ({ id: 'g1', eventId: 'event-audio', name: 'Ana', guestToken: 'tok', createdAt: '' }),
      notify: vi.fn(),
      notifyError,
      syncGuestFromServer: vi.fn(),
    } as unknown as ServiceContext;
    return { ctx, notifyError };
  }

  it('takes it off the phone and says why, without queueing it', async () => {
    const { ctx, notifyError } = harness();
    vi.spyOn(audioApi, 'create').mockRejectedValue(
      new ApiError(i18n.t('error.album_closed'), 403, undefined, 'ALBUM_CLOSED')
    );
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    addAudioEntry(ctx, new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 5);

    await vi.waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(i18n.t('upload.audio_not_sent', { reason: i18n.t('error.album_closed') }))
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.AUDIO('event-audio')) || '[]')).toHaveLength(0);
  });

  it('queues it when the network failed', async () => {
    const { ctx, notifyError } = harness();
    vi.spyOn(audioApi, 'create').mockRejectedValue(new TypeError('Failed to fetch'));
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    addAudioEntry(ctx, new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 5);

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('the host sign-in state (AuthContext)', () => {
  const HOST: HostUser = { id: 'u1', email: 'ana@example.org', fullName: 'Ана', role: 'couple', createdAt: '' } as HostUser;

  function Probe() {
    const auth = useAuth();
    return <span data-testid="state">{auth.isAuthenticated ? `in:${auth.user?.fullName}` : 'out'}</span>;
  }

  it('follows the session as it starts and ends', () => {
    let current: { user: HostUser | null; token: string | null } = { user: null, token: null };
    const listeners = new Set<() => void>();
    vi.spyOn(authService, 'getUser').mockImplementation(() => current.user);
    vi.spyOn(authService, 'getToken').mockImplementation(() => current.token);
    vi.spyOn(authService, 'subscribe').mockImplementation((fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    expect(screen.getByTestId('state')).toHaveTextContent('out');

    act(() => {
      current = { user: HOST, token: 'jwt' };
      listeners.forEach((fn) => fn());
    });
    expect(screen.getByTestId('state')).toHaveTextContent('in:Ана');

    act(() => {
      current = { user: null, token: null };
      listeners.forEach((fn) => fn());
    });
    expect(screen.getByTestId('state')).toHaveTextContent('out');
  });

  it('passes every account action through to the auth service', async () => {
    const ok = { success: true } as Awaited<ReturnType<typeof authService.login>>;
    const calls = {
      login: vi.spyOn(authService, 'login').mockResolvedValue(ok),
      register: vi.spyOn(authService, 'register').mockResolvedValue(ok),
      loginWithDemo: vi.spyOn(authService, 'loginWithDemo').mockResolvedValue(ok),
      updateProfile: vi.spyOn(authService, 'updateProfile').mockResolvedValue(ok),
      changePassword: vi.spyOn(authService, 'changePassword').mockResolvedValue(ok),
      deleteAccount: vi.spyOn(authService, 'deleteAccount').mockResolvedValue(ok),
      logout: vi.spyOn(authService, 'logout').mockImplementation(() => undefined),
    };
    let api: ReturnType<typeof useAuth> | null = null;
    function Capture() {
      api = useAuth();
      return null;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>
    );

    await api!.login('ana@example.org', 'pw');
    await api!.register('ana@example.org', 'Ана', 'pw');
    await api!.loginWithDemo(HOST);
    await api!.updateProfile('Ана Иванова');
    await api!.changePassword('old', 'newpassword');
    await api!.deleteAccount('pw');
    api!.logout();

    expect(calls.login).toHaveBeenCalledWith('ana@example.org', 'pw');
    expect(calls.register).toHaveBeenCalledWith('ana@example.org', 'Ана', 'pw', 'couple', undefined);
    expect(calls.loginWithDemo).toHaveBeenCalledWith(HOST);
    expect(calls.updateProfile).toHaveBeenCalledWith('Ана Иванова');
    expect(calls.changePassword).toHaveBeenCalledWith('old', 'newpassword');
    expect(calls.deleteAccount).toHaveBeenCalledWith('pw');
    expect(calls.logout).toHaveBeenCalled();
  });

  it('refuses to be read outside its provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/within an AuthProvider/);
  });
});
