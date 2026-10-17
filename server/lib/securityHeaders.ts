import type { IncomingMessage } from 'http';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Security response headers. Nothing was setting any before this: no CSP, no
 * HSTS, no nosniff, no clickjacking protection, on an app where guests upload
 * files and hosts authenticate.
 *
 * The CSP is written out rather than taking helmet's defaults because two of
 * those defaults break this app:
 *   - `upgrade-insecure-requests` would rewrite the LAN URLs the QR codes hand
 *     out (http://192.168.0.35:6500) to https and make them unreachable.
 *   - `cross-origin-resource-policy: same-origin` would stop the SPA on :6500
 *     loading /uploads media served from :6501 under STORAGE_PROVIDER=local.
 *
 * Photos and audio live on the R2 public host, so that origin has to be allowed
 * for img/media and is added only when configured. 'unsafe-inline' is required
 * for styles because the app sets inline `style` attributes (theme accent
 * colours in Navbar.tsx, animation transforms); scripts need no such exemption —
 * the Vite build emits a single external module and no inline script.
 */

/** A Host header fit to name in a policy: a host name or address, and a port. */
const HOST_HEADER = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

function ownWebSocket(scheme: 'ws' | 'wss') {
  return (req: IncomingMessage): string => {
    const host = req.headers.host ?? '';
    return HOST_HEADER.test(host) ? `${scheme}://${host}` : '';
  };
}

/**
 * Features a page from this site may use. The camera and microphone are the
 * guest's photo and voice message; fullscreen is the live screen, which keeps
 * its default. Everything else the app never touches is off, so script that
 * should not be there cannot ask for it either.
 */
const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'bluetooth=()',
  'hid=()',
  'midi=()',
  'magnetometer=()',
  'gyroscope=()',
  'accelerometer=()',
  'display-capture=()',
].join(', ');

export function securityHeaders(options: { r2Origin?: string; production: boolean }): RequestHandler[] {
  const r2 = options.r2Origin ? [options.r2Origin] : [];
  const mediaSrc = ["'self'", 'data:', 'blob:', ...r2];

  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: mediaSrc,
          mediaSrc,
          // The event-scoped WebSocket (ws/wsServer.ts) is on the page's own
          // host. It was allowed as `ws: wss:` — any host at all, which lets
          // injected script stream data anywhere (OWASP ZAP, 2026-10-17).
          // 'self' covers a same-origin WebSocket only in newer browsers, so
          // the request's own host is named as well, for older Safari.
          connectSrc: ["'self'", ownWebSocket('ws'), ownWebSocket('wss'), ...r2],
          // canvas-confetti draws in a worker it starts from a blob: URL.
          // Without this the policy fell back to script-src, refused it on
          // every photo sent, and the library drew on the main thread. Only
          // script already running on the page can create such a worker.
          workerSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // Match frame-ancestors 'none' above. helmet's default is SAMEORIGIN,
      // which would be the weaker of the two for any browser falling back to
      // X-Frame-Options, and disagreeing headers are their own bug.
      frameguard: { action: 'deny' },
      // Only meaningful over TLS, and pinning it while a domain is still served
      // over http would lock browsers out until certificates are in place.
      hsts: options.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
    (_req, res, next) => {
      res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
      next();
    },
  ];
}

/**
 * API answers are for the person who asked, at the moment they asked: no
 * browser or proxy cache keeps them, so a host's data is not left behind on a
 * shared machine and nobody is shown a stale album.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
