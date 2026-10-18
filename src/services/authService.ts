import { HostUser } from '../types';
import { ENV } from '../config/env';
import { SESSION_EXPIRED_EVENT, ERROR_CODE_KEYS } from '../api/apiClient';
import { i18n } from '../i18n';
import { WeddingEvent } from '../types';

/** What a sign-in or registration returns to the caller. */
export interface AuthResult {
  success: boolean;
  user?: HostUser;
  event?: Partial<WeddingEvent>;
  error?: string;
}

/** What each refusal means when the server sent no code for it. */
const AUTH_STATUS_KEYS: Record<number, string> = {
  400: 'auth.check_details',
  401: 'auth.invalid_credentials',
  409: 'auth.email_taken',
  429: 'auth.too_many_attempts',
};

/**
 * A refused sign-in or registration, in the language the host is reading.
 *
 * N-76 — the server's English wording used to win over every translation, so
 * a host reading Bulgarian got each error in English. The server's code is
 * read first, then the status, then the caller's general message.
 */
async function refusalMessage(
  res: Response,
  fallbackKey: string,
  /** What a code means in this action, over its general meaning. */
  codeKeys: Record<string, string> = {}
): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; details?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  // N-132 — a password under six characters said only "check your details",
  // and the field's hint had gone with the first keystroke.
  const PASSWORD_FIELDS = ['password', 'newPassword'];
  if (res.status === 400 && Array.isArray(body.details) && body.details.some((d) => PASSWORD_FIELDS.includes(d?.field))) {
    return i18n.t('auth.password_too_short');
  }
  return i18n.t(codeKeys[code] || ERROR_CODE_KEYS[code] || AUTH_STATUS_KEYS[res.status] || fallbackKey);
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
    avatarUrl: '/demo/guest-1.jpg',
    createdAt: new Date().toISOString(),
  },
  {
    id: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    email: 'demo.planner@wedmoments.bg',
    fullName: 'Гергана Димитрова',
    role: 'planner',
    companyName: 'Сватбена Агенция "Димитрова & Ко."',
    avatarUrl: '/demo/guest-4.jpg',
    createdAt: new Date().toISOString(),
  },
];

/**
 * Exported for tests only — the app uses the `authService` singleton below.
 * Restoring a session happens in the constructor, so pinning "a half-written
 * localStorage is not a signed-in host" needs a second instance to construct.
 */
export class AuthService {
  private currentUser: HostUser | null = null;
  private token: string | null = null;
  private listeners: Set<() => void> = new Set();
  private apiHost: string = ENV.API_URL;

  constructor() {
    if (typeof window !== 'undefined') {
      // The API client raises this when the server rejects our token.
      // Clear locally only. The server has just refused this token, so there
      // is nothing left to revoke, and asking it to revoke would turn a
      // momentary refusal — a database blip makes `isSessionTokenCurrent`
      // fail closed — into a forced re-login on every one of the host's
      // devices.
      window.addEventListener(SESSION_EXPIRED_EVENT, () => this.clearLocalSession());

      // N-182 — another tab signed in or out, or changed the password and was
      // handed a new token. Read once, the session went stale here: a tab
      // signed out elsewhere stayed in the studio with every action failing.
      window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== AUTH_USER_KEY && event.key !== AUTH_TOKEN_KEY) return;
        this.loadSavedSession();
        this.notify();
      });

      this.loadSavedSession();
    }
  }

  private loadSavedSession(): void {
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

  /**
   * N-182 — what an account request's refusal means. A 401 that is not about
   * the password the host typed is the session itself ending: this tab signs
   * out, as apiFetch does, rather than reading it as "wrong email or password"
   * and leaving the host to retry for ever.
   */
  private async accountRefusal(res: Response, fallbackKey: string, codeKeys: Record<string, string> = {}): Promise<string> {
    if (res.status === 401) {
      const body = (await res.clone().json().catch(() => ({}))) as { code?: unknown };
      if (body.code !== 'INVALID_CREDENTIALS' && body.code !== 'PASSWORD_SETUP_REQUIRED') {
        this.clearLocalSession();
        return i18n.t(body.code === 'SESSION_REVOKED' ? 'error.session_revoked' : 'error.unauthorized');
      }
    }
    return refusalMessage(res, fallbackKey, codeKeys);
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
        return { success: false, error: await refusalMessage(res, 'auth.login_failed') };
      }
    } catch (e) {
      console.warn('Backend login unreachable:', e);
      // Never fall back to a password-less demo match: signing in requires the
      // server to verify the bcrypt password. The 1-Click Demo tab (loginWithDemo)
      // remains available as an explicitly local-only preview.
      return { success: false, error: i18n.t('auth.network_error') };
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
        return { success: false, error: await refusalMessage(res, 'auth.register_failed') };
      }
    } catch (e) {
      console.warn('Backend register offline:', e);
      return { success: false, error: i18n.t('auth.network_error') };
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
      return { success: false, error: i18n.t('error.unauthorized') };
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
      return { success: false, error: await this.accountRefusal(res, 'host_profile.save_failed') };
    } catch {
      return { success: false, error: i18n.t('auth.network_error') };
    }
  }

  /**
   * Change the password (N-122). The server ends every other session and hands
   * this one a fresh token, which replaces the old one here.
   */
  public async changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
    const user = this.currentUser;
    if (!this.token || !user) return { success: false, error: i18n.t('account.password_change_failed') };
    try {
      const res = await fetch(`${this.apiHost}/api/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        return {
          success: false,
          error: await this.accountRefusal(res, 'account.password_change_failed', {
            INVALID_CREDENTIALS: 'account.password_wrong',
          }),
        };
      }
      const data = (await res.json()) as { token: string };
      this.setSession(user, data.token);
      return { success: true, user };
    } catch {
      return { success: false, error: i18n.t('auth.network_error') };
    }
  }

  /**
   * Delete the account and everything in it (N-122). Once the server has done
   * so this browser's session is cleared; there is nothing left to revoke.
   */
  public async deleteAccount(password: string): Promise<AuthResult> {
    if (!this.token) return { success: false, error: i18n.t('account.delete_failed') };
    try {
      const res = await fetch(`${this.apiHost}/api/auth/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        return {
          success: false,
          error: await this.accountRefusal(res, 'account.delete_failed', {
            INVALID_CREDENTIALS: 'account.password_wrong',
            BILLING_UNVERIFIABLE: 'account.delete_billing_unreachable',
          }),
        };
      }
      this.clearLocalSession();
      return { success: true };
    } catch {
      return { success: false, error: i18n.t('auth.network_error') };
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
  /** Forget this browser's session without telling the server. */
  private clearLocalSession() {
    this.currentUser = null;
    this.token = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
    this.notify();
  }

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
