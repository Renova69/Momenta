import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthService, authService, DEMO_HOST_USERS, DEMO_ACCOUNT_PASSWORD } from '../../src/services/authService';
import { HostUser, WeddingEvent } from '../../src/types';
import { SESSION_EXPIRED_EVENT } from '../../src/api/apiClient';
import { i18n, TRANSLATIONS } from '../../src/i18n';

function createMockResponse<T>(data: T, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob([JSON.stringify(data)]),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
    clone: () => createMockResponse(data, status, ok),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as Response;
}

describe('Auth Service Client Spec', () => {
  beforeEach(() => {
    localStorage.clear();
    authService.logout();
    vi.restoreAllMocks();
  });

  it('starts unauthenticated with no token', () => {
    expect(authService.isAuthenticated()).toBe(false);
    expect(authService.getToken()).toBeNull();
    expect(authService.getUser()).toBeNull();
  });

  it('stores token and user profile on successful login', async () => {
    const mockUser: HostUser = {
      id: 'user-123',
      email: 'host@example.com',
      fullName: 'Emma & Liam',
      role: 'couple',
      createdAt: new Date().toISOString(),
    };

    const mockEvent: Partial<WeddingEvent> = {
      id: 'event-123',
      title: 'Emma & Liam Wedding',
      slug: 'emma-liam-2026',
    };

    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({
        token: 'mock-jwt-token-xyz',
        user: mockUser,
        event: mockEvent,
      })
    );

    const result = await authService.login('host@example.com', 'Password123!');

    expect(result.success).toBe(true);
    expect(authService.isAuthenticated()).toBe(true);
    expect(authService.getToken()).toBe('mock-jwt-token-xyz');
    expect(authService.getUser()?.email).toBe('host@example.com');
  });

  it('registers new user and handles registration failures', async () => {
    const mockUser: HostUser = {
      id: 'user-new',
      email: 'new@example.com',
      fullName: 'New Host',
      role: 'couple',
      createdAt: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({
        token: 'token-reg',
        user: mockUser,
        event: { id: 'e-new' },
      })
    );

    const reg = await authService.register('new@example.com', 'New Host', 'Password123!', 'couple');
    expect(reg.success).toBe(true);

    // Registration failed response
    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({ error: 'Email already registered. Please log in.', code: 'EMAIL_TAKEN' }, 409, false)
    );

    const failedReg = await authService.register('new@example.com', 'New Host', 'Password123!');
    expect(failedReg.success).toBe(false);
    expect(failedReg.error).toBe(i18n.t('auth.email_taken'));
  });

  it('signs in demo hosts through the real login route', async () => {
    const demo = DEMO_HOST_USERS[0];
    const fetchMock = vi.fn().mockResolvedValue(
      createMockResponse({ token: 'real-demo-jwt', user: demo, event: { id: 'e-demo' } })
    );
    global.fetch = fetchMock;

    const result = await authService.loginWithDemo(demo);

    // A fabricated token would render the host studio while every request 401s,
    // so the demo path must go through /api/auth/login like any other sign-in.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/login'),
      expect.objectContaining({ method: 'POST' })
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.email).toBe(demo.email);
    expect(sentBody.password).toBe(DEMO_ACCOUNT_PASSWORD);

    expect(result.success).toBe(true);
    expect(authService.isAuthenticated()).toBe(true);
    expect(authService.getToken()).toBe('real-demo-jwt');
  });

  it('does not sign in when the demo account is unavailable', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({ error: 'Invalid email or password.' }, 401, false)
    );

    const result = await authService.loginWithDemo(DEMO_HOST_USERS[0]);

    expect(result.success).toBe(false);
    expect(authService.isAuthenticated()).toBe(false);
  });

  it('reports a refused sign-in as wrong credentials when the server gave no code', async () => {
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({}, 401, false));

    const result = await authService.login('host@example.com', 'wrong');

    expect(result.success).toBe(false);
    expect(result.error).toBe(i18n.t('auth.invalid_credentials'));
  });

  /**
   * N-76 — the server's English message always won over the translated one,
   * so a Bulgarian host signing in got every error in English.
   */
  describe('in the language the host is reading (N-76)', () => {
    const original = i18n.getLanguage();
    afterEach(() => i18n.setLanguage(original));

    it('translates the reason by the code the server sends, not its English wording', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        createMockResponse({ error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' }, 401, false)
      );

      i18n.setLanguage('bg');
      const bg = await authService.login('host@example.com', 'secret');
      i18n.setLanguage('en');
      const en = await authService.login('host@example.com', 'secret');

      expect(bg.error).toBe(TRANSLATIONS.bg['auth.invalid_credentials']);
      expect(en.error).toBe(TRANSLATIONS.en['auth.invalid_credentials']);
      expect(bg.error).not.toBe(en.error);
    });

    it('says an account needs its password set up, in the reader language', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        createMockResponse({ error: 'Account requires password setup.', code: 'PASSWORD_SETUP_REQUIRED' }, 401, false)
      );

      const result = await authService.login('host@example.com', 'secret');

      expect(result.error).toBe(i18n.t('auth.password_setup_required'));
    });

    it('says to wait after too many attempts', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        createMockResponse({ error: 'Too many login attempts.', code: 'TOO_MANY_ATTEMPTS' }, 429, false)
      );

      const result = await authService.login('host@example.com', 'secret');

      expect(result.error).toBe(i18n.t('auth.too_many_attempts'));
    });

    // N-132 — a password under six characters was refused with only "check
    // your details", and the field's hint had gone with the first keystroke.
    it('says the password is too short when that is why it was refused', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        createMockResponse(
          { error: 'Validation failed', details: [{ field: 'password', message: 'Password must be at least 6 characters' }] },
          400,
          false
        )
      );

      const result = await authService.register('host@example.com', 'Host', 'abc12');

      expect(result.error).toBe(i18n.t('auth.password_too_short'));
    });

    it('asks to check the details when a registration is refused as invalid', async () => {
      global.fetch = vi.fn().mockResolvedValue(createMockResponse({ error: 'Validation failed' }, 400, false));

      const result = await authService.register('host@example.com', 'Host', 'x');

      expect(result.error).toBe(i18n.t('auth.check_details'));
    });

    it('does not call a failed address allocation a taken email', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        createMockResponse({ error: 'Could not allocate a unique event URL.', code: 'SLUG_ALLOCATION_FAILED' }, 409, false)
      );

      const result = await authService.register('host@example.com', 'Host', 'Password123!');

      expect(result.error).toBe(i18n.t('auth.register_failed'));
    });

    it('falls back to a translated message for anything it has no words for', async () => {
      global.fetch = vi.fn().mockResolvedValue(createMockResponse({ error: 'Service Unavailable' }, 503, false));

      const login = await authService.login('host@example.com', 'secret');
      const reg = await authService.register('host@example.com', 'Host', 'Password123!');

      expect(login.error).toBe(i18n.t('auth.login_failed'));
      expect(reg.error).toBe(i18n.t('auth.register_failed'));
    });

    it('says the connection failed when the server cannot be reached', async () => {
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const login = await authService.login('host@example.com', 'secret');
      const reg = await authService.register('host@example.com', 'Host', 'Password123!');

      expect(login.error).toBe(i18n.t('auth.network_error'));
      expect(reg.error).toBe(i18n.t('auth.network_error'));
    });
  });

  it('fails rather than signs in when the server cannot be reached', async () => {
    // A host must never be let in because the network was down.
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await authService.login('host@example.com', 'secret');

    expect(result.success).toBe(false);
    expect(authService.isAuthenticated()).toBe(false);
  });

  it('tells the server about a logout in a way that survives the page closing', async () => {
    // Without keepalive the browser cancels the request as the tab unloads,
    // and the session stays valid server-side until it expires on its own.
    const mockUser: HostUser = {
      id: 'user-keepalive',
      email: 'host@example.com',
      fullName: 'Monika',
      role: 'couple',
      createdAt: new Date().toISOString(),
    };
    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({ user: mockUser, token: 'tok-keepalive' })
    );
    await authService.login('host@example.com', 'secret');

    const fetchMock = vi.fn().mockResolvedValue(createMockResponse({}));
    global.fetch = fetchMock;
    authService.logout();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/logout'),
      expect.objectContaining({ keepalive: true })
    );
  });

  it('does not sign a host in on half a stored session', () => {
    // One key without the other is what a cleared cookie jar, a quota
    // eviction or another tab signing out leaves behind. Treating that as a
    // session means every request goes out with no token and comes back 401.
    localStorage.setItem('wedmoments_host_user', JSON.stringify({ email: 'host@example.com' }));
    localStorage.removeItem('wedmoments_host_token');

    const restored = new AuthService();

    expect(restored.isAuthenticated()).toBe(false);
    expect(restored.getUser()).toBeNull();
  });

  it('restores a session written in full', () => {
    localStorage.setItem('wedmoments_host_user', JSON.stringify({ email: 'host@example.com' }));
    localStorage.setItem('wedmoments_host_token', 'tok-restored');

    const restored = new AuthService();

    expect(restored.isAuthenticated()).toBe(true);
    expect(restored.getToken()).toBe('tok-restored');
  });

  it('writes the session to storage so a reload stays signed in', async () => {
    const mockUser: HostUser = {
      id: 'user-persist',
      email: 'host@example.com',
      fullName: 'Monika',
      role: 'couple',
      createdAt: new Date().toISOString(),
    };
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ user: mockUser, token: 'tok-persist' }));

    await authService.login('host@example.com', 'secret');

    expect(localStorage.getItem('wedmoments_host_token')).toBe('tok-persist');
  });

  it('fails a registration the server never received', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await authService.register('host@example.com', 'secret', 'Monika');

    expect(result.success).toBe(false);
    expect(authService.isAuthenticated()).toBe(false);
  });

  it('forgets the stored session when the server says it has expired', () => {
    // The 401 path: the token is already dead server-side, so there is
    // nothing to revoke — but leaving it in storage means the next reload
    // starts signed in and 401s its way through the dashboard.
    const restored = new AuthService();
    localStorage.setItem('wedmoments_host_user', JSON.stringify({ email: 'host@example.com' }));
    localStorage.setItem('wedmoments_host_token', 'tok-expired');

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));

    expect(localStorage.getItem('wedmoments_host_token')).toBeNull();
    expect(localStorage.getItem('wedmoments_host_user')).toBeNull();
    expect(restored.isAuthenticated()).toBe(false);
  });

  it('clears state on logout and notifies subscribers', () => {
    localStorage.setItem('wedmoments_host_token', 'sample-token');
    localStorage.setItem('wedmoments_host_user', JSON.stringify({ email: 'test@example.com' }));

    const listener = vi.fn();
    const unsub = authService.subscribe(listener);

    authService.logout();

    expect(authService.isAuthenticated()).toBe(false);
    expect(authService.getToken()).toBeNull();
    expect(localStorage.getItem('wedmoments_host_token')).toBeNull();
    expect(listener).toHaveBeenCalled();

    unsub();
  });
});
