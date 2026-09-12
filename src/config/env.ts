// Central environment configuration for frontend

const metaEnv: Partial<ImportMetaEnv> =
  (typeof import.meta !== 'undefined' && import.meta.env) || {};

const loc = typeof window !== 'undefined' ? window.location : undefined;
const hostname = loc?.hostname || 'localhost';

// In dev the Vite server (6500) and the API (6501) are separate origins; in every
// deployed topology the SPA is either served by the API container itself
// (same-origin, empty base) or points at an explicit VITE_API_URL.
const DEV_API_PORT = '6501';
const isViteDevServer = loc?.port === '6500';

function defaultApiUrl(): string {
  if (metaEnv.VITE_API_URL) return metaEnv.VITE_API_URL;
  return isViteDevServer ? `http://${hostname}:${DEV_API_PORT}` : '';
}

/**
 * Derive the WebSocket origin from the page rather than hardcoding a scheme and
 * port: an https:// page must use wss:// or the browser blocks the connection as
 * mixed content, and behind a reverse proxy the API shares the page's port.
 */
function defaultWsUrl(): string {
  if (metaEnv.VITE_WS_URL) return metaEnv.VITE_WS_URL;
  if (!loc) return `ws://${hostname}:${DEV_API_PORT}`;

  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  if (isViteDevServer) return `${scheme}//${hostname}:${DEV_API_PORT}`;

  // Same-origin deployment: the WebSocket server is attached to the HTTP server.
  return `${scheme}//${loc.host}`;
}

export const ENV = {
  API_URL: defaultApiUrl(),
  WS_URL: defaultWsUrl(),
  IS_PROD: !!metaEnv.PROD,
};
