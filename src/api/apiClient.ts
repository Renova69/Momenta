import { ENV } from '../config/env';
import { i18n } from '../i18n';

/** Arbitrary JSON the server may attach to an error, such as Zod field issues. */
export type ApiErrorDetails = unknown;

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
 * Server error messages are written once, in English. When the server sends a
 * machine-readable `code`, prefer the translated text for the active language and
 * fall back to whatever the server said.
 *
 * Every `code:` the server emits belongs here. Five of the fourteen were mapped
 * and the other nine reached a Bulgarian host as untranslated English — a
 * guest told to "Join the wedding before commenting", a host told their
 * subscription was "still active with our payment provider". Anything in the
 * product that a person reads has both languages or it has neither, so
 * `tests/unit/i18n.spec.ts` now greps `server/` for code strings and fails if
 * one is missing from this table or from either translation.
 */
export const ERROR_CODE_KEYS: Record<string, string> = {
  TIER_REQUIRED: 'error.tier_required',
  TIER_LIMIT_REACHED: 'error.tier_limit_reached',
  STORAGE_LIMIT_REACHED: 'error.storage_limit_reached',
  EVENT_LIMIT_REACHED: 'error.event_limit_reached',
  INVALID_UUID: 'error.invalid_uuid',
  SESSION_REVOKED: 'error.session_revoked',
  GUEST_TOKEN_REQUIRED: 'error.guest_token_required',
  GUEST_IDENTITY_REQUIRED: 'error.guest_identity_required',
  CHECKOUT_REQUIRED: 'error.checkout_required',
  ALREADY_SUBSCRIBED: 'error.already_subscribed',
  MANAGE_SUBSCRIPTION_IN_PORTAL: 'error.manage_subscription_in_portal',
  NO_STRIPE_CUSTOMER: 'error.no_stripe_customer',
  CONFIRMATION_MISMATCH: 'error.confirmation_mismatch',
  INVALID_CREDENTIALS: 'auth.invalid_credentials',
  PASSWORD_SETUP_REQUIRED: 'auth.password_setup_required',
  EMAIL_TAKEN: 'auth.email_taken',
  SLUG_ALLOCATION_FAILED: 'auth.register_failed',
  TOO_MANY_ATTEMPTS: 'auth.too_many_attempts',
  NOT_AN_IMAGE: 'ingest.reason_not_image',
  TOO_MANY_PIXELS: 'ingest.reason_too_many_pixels',
  INGEST_KEY_INVALID: 'ingest.reason_bad_key',
  INGEST_ALBUM_NOT_FOUND: 'ingest.reason_album_gone',
  DELETION_IN_PROGRESS: 'error.deletion_in_progress',
  PHOTO_NOT_PUBLIC: 'error.photo_not_public',
  STORAGE_DELETE_FAILED: 'error.storage_delete_failed',
  ALREADY_ENTITLED: 'error.already_entitled',
  BILLING_UNVERIFIABLE: 'error.billing_unverifiable',
  // Translating this does not disturb `isStripeNotConfigured`, which reads
  // `ApiError.code` and never the message: the pre-Stripe upgrade route still
  // takes over silently.
  STRIPE_NOT_CONFIGURED: 'error.stripe_not_configured',
};

/**
 * N-125 — a refusal the server sends without a code is said by its status, in
 * the app's language. Its text is English ("Forbidden: You do not own this
 * event") and reached a Bulgarian host inside a Bulgarian sentence. A 400
 * keeps the server's words, which say what was wrong with the request.
 */
function statusMessage(status: number): string | undefined {
  if (status === 403) return i18n.t('error.forbidden');
  if (status === 404) return i18n.t('error.not_found');
  if (status >= 500) return i18n.t('error.server');
  return undefined;
}

/** Broadcast so the auth layer can clear the session without a circular import. */
export const SESSION_EXPIRED_EVENT = 'wedmoments:session-expired';

/**
 * 401s that are about the guest identity in this browser, not the host's
 * session.
 *
 * A host browsing their own album is both at once: the host token rides on
 * every request, while likes, comments and uploads are the guest. Treating
 * any 401 as the host's session ending signed them out of the host studio —
 * and out of every other device, since the logout revokes the token
 * server-side — because they tapped a heart with a stale guest token. "Reset
 * guest sessions" invalidates that guest token deliberately, so the host's
 * own next tap did it.
 */
const GUEST_SCOPE_ERROR_CODES = new Set(['GUEST_TOKEN_REQUIRED', 'GUEST_IDENTITY_REQUIRED']);

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
      } else if (!code) {
        errorMsg = statusMessage(res.status) ?? errorMsg;
      }
    } catch {
      errorMsg = statusMessage(res.status) ?? errorMsg;
    }

    // A rejected HOST token means the session is over — a JWT expires after 7
    // days, and without this the host studio stays rendered while every action
    // fails. A refused guest identity says nothing about it.
    if (res.status === 401 && token && !(code && GUEST_SCOPE_ERROR_CODES.has(code))) {
      notifySessionExpired();
    }

    throw new ApiError(errorMsg, res.status, details, code);
  }

  return res.json() as Promise<T>;
}
