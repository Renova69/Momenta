import { HostUser } from '../types';
import { ENV } from '../config/env';
import { SESSION_EXPIRED_EVENT } from '../api/apiClient';
import { WeddingEvent } from '../types';

/** What a sign-in or registration returns to the caller. */
export interface AuthResult {
  success: boolean;
  user?: HostUser;
  event?: Partial<WeddingEvent>;
  error?: string;
}

const AUTH_USER_KEY = 'wedmoments_host_user';
const AUTH_TOKEN_KEY = 'wedmoments_host_token';

/**
 * Shared password for the seeded demo accounts (see migration 007).
 *
 * These are deliberately public logins against throwaway data — the demo tab
 * authenticates through the normal login route so the resulting JWT is real and
 * every host action actually works.
 */
export const DEMO_ACCOUNT_PASSWORD = 'WedMomentsDemo2026!';

export const DEMO_HOST_USERS: HostUser[] = [
  {
    id: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    email: 'demo.couple@wedmoments.bg',
    fullName: 'Моника и Александър',
    role: 'couple',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80',
    createdAt: new Date().toISOString(),
  },
  {
    id: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    email: 'demo.planner@wedmoments.bg',
    fullName: 'Гергана Димитрова',
    role: 'planner',
    companyName: 'Сватбена Агенция "Димитрова & Ко."',
    avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=200&q=80',
    createdAt: new Date().toISOString(),
  },
];

class AuthService {
  private currentUser: HostUser | null = null;
  private token: string | null = null;
  private listeners: Set<() => void> = new Set();
  private apiHost: string = ENV.API_URL;

  constructor() {
    if (typeof window !== 'undefined') {
      // The API client raises this when the server rejects our token.
      window.addEventListener(SESSION_EXPIRED_EVENT, () => this.logout());

      try {
        const savedUser = localStorage.getItem(AUTH_USER_KEY);
        const savedToken = localStorage.getItem(AUTH_TOKEN_KEY);
        if (savedUser && savedToken) {
          this.currentUser = JSON.parse(savedUser);
          this.token = savedToken;
        } else {
          this.currentUser = null;
          this.token = null;
        }
      } catch {
        this.currentUser = null;
        this.token = null;
      }
    }
  }

  public isAuthenticated(): boolean {
    return !!this.currentUser && !!this.token;
  }

  public getUser(): HostUser | null {
    return this.currentUser;
  }

  public getToken(): string | null {
    return this.token;
  }

  public async login(email: string, password?: string): Promise<AuthResult> {
    try {
      const res = await fetch(`${this.apiHost}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.ok) {
        const data = await res.json();
        this.setSession(data.user, data.token);
        return { success: true, user: data.user, event: data.event };
      } else {
        const errJson = await res.json().catch(() => ({}));
        return { success: false, error: errJson.error || 'Login failed' };
      }
    } catch (e) {
      console.warn('Backend login unreachable:', e);
      // Never fall back to a password-less demo match: signing in requires the
      // server to verify the bcrypt password. The 1-Click Demo tab (loginWithDemo)
      // remains available as an explicitly local-only preview.
      return { success: false, error: 'Login failed. Please check your connection and try again.' };
    }
  }

  public async register(
    email: string,
    fullName: string,
    password?: string,
    role: 'couple' | 'planner' = 'couple',
    companyName?: string
  ): Promise<AuthResult> {
    try {
      const res = await fetch(`${this.apiHost}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          fullName: fullName.trim(),
          password,
          role,
          companyName,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        this.setSession(data.user, data.token);
        return { success: true, user: data.user, event: data.event };
      } else {
        const errJson = await res.json().catch(() => ({}));
        return { success: false, error: errJson.error || 'Registration failed' };
      }
    } catch (e) {
      console.warn('Backend register offline:', e);
      return { success: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  }

  /**
   * Sign in as one of the seeded demo hosts.
   *
   * This goes through the real login route: a fabricated token would render the
   * host studio while every authenticated request behind it returned 401.
   */
  public async loginWithDemo(demoUser: HostUser) {
    return this.login(demoUser.email, DEMO_ACCOUNT_PASSWORD);
  }

  /** Updates the host's own name. Email is not editable — it's how they sign in. */
  public async updateProfile(fullName: string): Promise<AuthResult> {
    if (!this.token) {
      return { success: false, error: 'Not signed in' };
    }
    try {
      const res = await fetch(`${this.apiHost}/api/auth/me`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ fullName: fullName.trim() }),
      });

      if (res.ok) {
        const data = await res.json();
        this.setSession(data.user, this.token);
        return { success: true, user: data.user };
      }
      const errJson = await res.json().catch(() => ({}));
      return { success: false, error: errJson.error || 'Update failed' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  }

  /**
   * Sign out.
   *
   * Tells the server first, so the token is actually revoked
   * (POST /api/auth/logout bumps users.token_version and every token minted
   * before now stops working). Clearing localStorage alone only stops THIS
   * browser presenting the token — a copy taken off a shared machine would
   * have kept working for the rest of its 7-day life.
   *
   * The request is fire-and-forget and the local session is cleared either
   * way: a user pressing "sign out" on a shared laptop must never be left
   * signed in because the network was down. When the call does fail the token
   * stays valid server-side, which is why it is sent before anything is
   * cleared, giving it the best chance of arriving.
   */
  public logout() {
    const token = this.token;
    if (token && typeof fetch !== 'undefined') {
      void fetch(`${this.apiHost}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => undefined);
    }

    this.currentUser = null;
    this.token = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
    this.notify();
  }

  private setSession(user: HostUser, token: string) {
    this.currentUser = user;
    this.token = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    }
    this.notify();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }
}

export const authService = new AuthService();
