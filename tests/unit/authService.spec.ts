import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService, DEMO_HOST_USERS, DEMO_ACCOUNT_PASSWORD } from '../../src/services/authService';
import { HostUser, WeddingEvent } from '../../src/types';

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
      createMockResponse({ error: 'Email already exists' }, 400, false)
    );

    const failedReg = await authService.register('new@example.com', 'New Host', 'Password123!');
    expect(failedReg.success).toBe(false);
    expect(failedReg.error).toBe('Email already exists');
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
