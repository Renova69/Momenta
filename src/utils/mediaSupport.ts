/**
 * Why the camera or microphone is unavailable.
 *
 * Browsers only expose `getUserMedia` in a *secure context*: an `https://` page,
 * or `http://localhost` / `http://127.0.0.1`. A phone opening the app over a LAN
 * address such as `http://192.168.0.35:6500` is not a secure context, so
 * `navigator.mediaDevices` is `undefined` and every capture path fails before it
 * starts. This is the single most common reason capture "works on my laptop but
 * not on a guest's phone" — the laptop is on localhost, the phone is not.
 *
 * Run `node start-tunnel.cjs` for an https:// URL during development, and serve
 * the real deployment over HTTPS.
 */

export type MediaBlockReason =
  | 'ok'
  /** Page is http:// on a non-localhost host, so the API is not exposed at all. */
  | 'insecure_context'
  /** Secure context, but the browser has no getUserMedia (very old or in-app browser). */
  | 'unsupported_browser';

export interface MediaSupport {
  available: boolean;
  reason: MediaBlockReason;
  /** The origin the page was loaded from, useful when telling the user what to fix. */
  origin: string;
}

function isSecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.isSecureContext === 'boolean') return window.isSecureContext;

  // Fallback for browsers without isSecureContext.
  const { protocol, hostname } = window.location;
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
}

/** Whether camera/microphone capture can work on this page at all. */
export function checkMediaSupport(): MediaSupport {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    // Distinguish "the page is insecure" from "this browser is too old", because
    // the fix is completely different.
    return {
      available: false,
      reason: isSecureContext() ? 'unsupported_browser' : 'insecure_context',
      origin,
    };
  }

  return { available: true, reason: 'ok', origin };
}

/** Translation key describing the block, for the user-facing message. */
export function mediaBlockMessageKey(reason: MediaBlockReason): string {
  switch (reason) {
    case 'insecure_context':
      return 'media.insecure_context';
    case 'unsupported_browser':
      return 'media.unsupported_browser';
    default:
      return 'media.unknown';
  }
}
