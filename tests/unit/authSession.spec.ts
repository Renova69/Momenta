import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService } from '../../src/services/authService';
import { SESSION_EXPIRED_EVENT } from '../../src/api/apiClient';
import { HostUser } from '../../src/types';

/**
 * The host session's lifecycle.
 *
 * `authService.spec.ts` covers signing in, registering and the demo accounts.
 * This covers what happens to a session afterwards — revocation, profile
 * updates, restoration across a reload, and the two failure modes that matter
 * on a shared machine.
 */

function mockResponse<T>(data: T, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    clone: () => mockResponse(data, status, ok),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as Response;
}

const SESSION = { user: { id: 'u1', email: 'a@b.c', fullName: 'A' }, token: 'tok-1' };

async function signIn() {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(SESSION));
  await authService.login('a@b.c', 'pw');
  return spy;
}

describe('session revocation on logout', () => {
  beforeEach(() => {
    localStorage.clear();
    authService.logout();
    vi.restoreAllMocks();
  });

  it('tells the server to revoke the token, not just the browser to forget it', async () => {
    // Clearing localStorage alone only stops THIS browser presenting the
    // token. A copy taken off a shared machine would keep working for the
    // rest of its seven-day life.
    const fetchSpy = await signIn();
    fetchSpy.mockClear();

    authService.logout();

    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/auth/logout'));
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('clears the local session even when the revoke call fails', async () => {
    await signIn();

    // Someone pressing "sign out" on a shared laptop must never be left signed
    // in because the venue Wi-Fi dropped.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    authService.logout();

    expect(authService.isAuthenticated()).toBe(false);
    expect(authService.getToken()).toBeNull();
    expect(localStorage.getItem('wedmoments_host_token')).toBeNull();
  });

  it('sends no revoke request when there was no session', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    authService.logout();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('signs the user out when the API client reports the session expired', async () => {
    await signIn();
    expect(authService.isAuthenticated()).toBe(true);

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));

    expect(authService.isAuthenticated()).toBe(false);
  });
});

describe('login failure handling', () => {
  beforeEach(() => {
    localStorage.clear();
    authService.logout();
    vi.restoreAllMocks();
  });

  it('reports a connection problem rather than falling back to a local match', async () => {
    // Signing in requires the server to verify the bcrypt password. There is
    // deliberately no password-less offline path.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await authService.login('host@example.com', 'pw');

    expect(result.success).toBe(false);
    expect(result.error).toContain('connection');
    expect(authService.isAuthenticated()).toBe(false);
  });

  it('trims the email before sending it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(SESSION));

    await authService.login('  spaced@example.com  ', 'pw');

    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).email).toBe(
      'spaced@example.com'
    );
  });
});

describe('updateProfile', () => {
  beforeEach(() => {
    localStorage.clear();
    authService.logout();
    vi.restoreAllMocks();
  });

  it('refuses when not signed in, without calling the server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await authService.updateProfile('New Name');

    expect(result).toEqual({ success: false, error: 'Not signed in' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a bearer token and a trimmed name, and adopts the result', async () => {
    const fetchSpy = await signIn();

    fetchSpy.mockResolvedValue(
      mockResponse({ user: { id: 'u1', email: 'a@b.c', fullName: 'Maria Ivanova' } })
    );
    const result = await authService.updateProfile('  Maria Ivanova  ');

    expect(result.success).toBe(true);
    const call = fetchSpy.mock.calls.at(-1)!;
    expect(String(call[0])).toContain('/api/auth/me');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(String(init.body))).toEqual({ fullName: 'Maria Ivanova' });
    // Stored, not merely returned - a reload must show the new name.
    expect(authService.getUser()?.fullName).toBe('Maria Ivanova');
  });

  it("surfaces the server's own reason for a rejection", async () => {
    const fetchSpy = await signIn();

    fetchSpy.mockResolvedValue(mockResponse({ error: 'Name too long' }, 400, false));
    const result = await authService.updateProfile('x'.repeat(500));

    expect(result).toEqual({ success: false, error: 'Name too long' });
  });

  it('falls back to a generic message when the rejection carries no reason', async () => {
    const fetchSpy = await signIn();

    fetchSpy.mockResolvedValue(mockResponse({}, 500, false));
    const result = await authService.updateProfile('Name');

    expect(result).toEqual({ success: false, error: 'Update failed' });
  });

  it('reports a network failure', async () => {
    const fetchSpy = await signIn();

    fetchSpy.mockRejectedValue(new Error('offline'));
    const result = await authService.updateProfile('Name');

    expect(result).toEqual({ success: false, error: 'offline' });
  });
});

describe('session restoration across a reload', () => {
  beforeEach(() => {
    localStorage.clear();
    authService.logout();
    vi.restoreAllMocks();
  });

  it('restores a saved session', async () => {
    const user = { id: 'u1', email: 'a@b.c', fullName: 'A' } as HostUser;
    localStorage.setItem('wedmoments_host_user', JSON.stringify(user));
    localStorage.setItem('wedmoments_host_token', 'tok-restored');

    vi.resetModules();
    const mod = await import('../../src/services/authService');

    expect(mod.authService.isAuthenticated()).toBe(true);
    expect(mod.authService.getToken()).toBe('tok-restored');
    expect(mod.authService.getUser()?.email).toBe('a@b.c');
  });

  it('starts signed out when only half the session survived', async () => {
    localStorage.setItem('wedmoments_host_token', 'tok-orphan');

    vi.resetModules();
    const mod = await import('../../src/services/authService');

    expect(mod.authService.isAuthenticated()).toBe(false);
  });

  it('starts signed out when the stored user is corrupt, rather than throwing at import', async () => {
    localStorage.setItem('wedmoments_host_user', '{not json');
    localStorage.setItem('wedmoments_host_token', 'tok');

    vi.resetModules();
    const mod = await import('../../src/services/authService');

    expect(mod.authService.isAuthenticated()).toBe(false);
  });
});

describe('subscribers', () => {
  beforeEach(() => {
    localStorage.clear();
    authService.logout();
    vi.restoreAllMocks();
  });

  it('stops notifying once unsubscribed', async () => {
    const listener = vi.fn();
    const unsubscribe = authService.subscribe(listener);

    await signIn();
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsubscribe();
    authService.logout();

    expect(listener).not.toHaveBeenCalled();
  });
});
