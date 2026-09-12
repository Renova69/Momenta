import { ENV } from '../config/env';
import { i18n } from '../i18n';

/** Arbitrary JSON the server may attach to an error, such as Zod field issues. */
export type ApiErrorDetails = unknown;

export interface ApiErrorResponse {
  error: string;
  details?: ApiErrorDetails;
}

export class ApiError extends Error {
  public status: number;
  public details?: ApiErrorDetails;
  public code?: string;

  constructor(message: string, status: number, details?: ApiErrorDetails, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

/**
 * Server error messages are written once, in Bulgarian. When the server sends a
 * machine-readable `code`, prefer the translated text for the active language and
 * fall back to whatever the server said.
 */
const ERROR_CODE_KEYS: Record<string, string> = {
  TIER_REQUIRED: 'error.tier_required',
  TIER_LIMIT_REACHED: 'error.tier_limit_reached',
  STORAGE_LIMIT_REACHED: 'error.storage_limit_reached',
  EVENT_LIMIT_REACHED: 'error.event_limit_reached',
  INVALID_UUID: 'error.invalid_uuid',
};

/** Broadcast so the auth layer can clear the session without a circular import. */
export const SESSION_EXPIRED_EVENT = 'wedmoments:session-expired';

function notifySessionExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('wedmoments_host_token') : null;
  const baseUrl = ENV.API_URL;
  const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  // If sending FormData (file upload), remove Content-Type so browser sets boundary
  if (options.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errorMsg = `HTTP Error ${res.status}`;
    let details;
    let code: string | undefined;
    try {
      const errorJson = await res.json();
      errorMsg = errorJson.error || errorMsg;
      details = errorJson.details;
      code = errorJson.code;

      const translationKey = code ? ERROR_CODE_KEYS[code] : undefined;
      if (translationKey) {
        const translated = i18n.t(translationKey);
        if (translated !== translationKey) errorMsg = translated;
      }
    } catch {
      // ignore JSON parse error
    }

    // A rejected token means the session is over — a JWT expires after 7 days,
    // and without this the host studio stays rendered while every action fails.
    if (res.status === 401 && token) {
      notifySessionExpired();
    }

    throw new ApiError(errorMsg, res.status, details, code);
  }

  return res.json() as Promise<T>;
}
