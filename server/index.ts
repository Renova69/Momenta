import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { CONFIG } from './lib/config';
import { pool } from './lib/db';
import { wsManager } from './ws/wsServer';
import { authRouter } from './routes/auth';
import { eventsRouter } from './routes/events';
import { photosRouter } from './routes/photos';
import { questsRouter } from './routes/quests';
import { audioRouter } from './routes/audio';
import { guestsRouter } from './routes/guests';
import { ingestRouter } from './routes/ingest';
import { subscriptionsRouter } from './routes/subscriptions';
import { billingRouter } from './routes/billing';
import { handleStripeWebhook } from './routes/billingWebhook';
import { startFtpServer, stopFtpServer } from './ftp/ftpServer';
import { apiLimiter } from './middleware/rateLimit';
import { runMigrations } from './lib/migrate';

const app = express();
const server = createServer(app);

// Configurable — see config.ts. Defaults closed (SEC-A3): a client reaching
// this process directly must not be able to spoof its rate-limit identity
// via X-Forwarded-For just because the setting was left at a blanket trust.
app.set('trust proxy', CONFIG.TRUST_PROXY);

// 1. Initialize WebSocket Server
wsManager.init(server);

// 2. Ensure uploads directory exists
if (!fs.existsSync(CONFIG.UPLOADS_DIR)) {
  fs.mkdirSync(CONFIG.UPLOADS_DIR, { recursive: true });
}

// Parse comma-separated CORS origins (supports e.g. "http://192.168.0.35:6500,http://localhost:6500")
const corsOrigin = CONFIG.CORS_ORIGIN
  ? CONFIG.CORS_ORIGIN.toString().split(',').map((s) => s.trim()).filter(Boolean)
  : false;

// Security response headers. Nothing was setting any before this: no CSP, no
// HSTS, no nosniff, no clickjacking protection, on an app where guests upload
// files and hosts authenticate.
//
// The CSP is written out rather than taking helmet's defaults because two of
// those defaults break this app:
//   - `upgrade-insecure-requests` would rewrite the LAN URLs the QR codes hand
//     out (http://192.168.0.35:6500) to https and make them unreachable.
//   - `cross-origin-resource-policy: same-origin` would stop the SPA on :6500
//     loading /uploads media served from :6501 under STORAGE_PROVIDER=local.
//
// Photos and audio live on the R2 public host, so that origin has to be allowed
// for img/media and is added only when configured. 'unsafe-inline' is required
// for styles because the app sets inline `style` attributes (theme accent
// colours in Navbar.tsx, animation transforms); scripts need no such exemption —
// the Vite build emits a single external module and no inline script.
const R2_ORIGIN = CONFIG.R2_PUBLIC_URL ? [CONFIG.R2_PUBLIC_URL] : [];
const MEDIA_SRC = ["'self'", 'data:', 'blob:', ...R2_ORIGIN];

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: MEDIA_SRC,
        mediaSrc: MEDIA_SRC,
        // ws:/wss: for the event-scoped WebSocket in ws/wsServer.ts.
        connectSrc: ["'self'", 'ws:', 'wss:', ...R2_ORIGIN],
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
    hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  })
);

app.use(cors({ origin: corsOrigin, credentials: true }));

// Stripe webhook signature verification needs the exact raw request bytes,
// so this route is registered with express.raw() before the global
// express.json() below ever gets a chance to parse (and thus alter) the
// body. Order matters here — moving this after express.json() would make
// every webhook call fail signature verification.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: `${CONFIG.MAX_UPLOAD_SIZE_MB}mb` }));
app.use(express.urlencoded({ extended: true, limit: `${CONFIG.MAX_UPLOAD_SIZE_MB}mb` }));

// 4. Static Uploads File Serving
app.use('/uploads', express.static(CONFIG.UPLOADS_DIR));

// 5. [FIX M-6] Apply global API rate limiter to all /api routes
app.use('/api', apiLimiter);

// 6. API Routes
app.use('/api/auth', authRouter);
app.use('/api/events', eventsRouter);
app.use('/api/photos', photosRouter);
app.use('/api', questsRouter);
app.use('/api/audio', audioRouter);
app.use('/api/guests', guestsRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/billing', billingRouter);

// 7. Health check — [FIX M-15] No internal paths exposed
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    connectedSockets: wsManager.getConnectedClientsCount(),
    storageProvider: CONFIG.STORAGE_PROVIDER,
    timestamp: new Date().toISOString(),
  });
});

// 7. Serve Built Frontend in Production & Handle SPA Routing Fallback
const DIST_DIR = path.join(process.cwd(), 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      return res.sendFile(path.join(DIST_DIR, 'index.html'));
    }
    next();
  });
}

// 8. Start Server — apply pending schema migrations first so a container that
// boots against an older database repairs itself instead of serving 500s.
async function start() {
  if (CONFIG.AUTO_MIGRATE) {
    try {
      const { applied } = await runMigrations();
      if (applied.length > 0) {
        console.log(`[WedMoments Core Server] Applied ${applied.length} pending migration(s).`);
      }
    } catch (err) {
      console.error('[WedMoments Core Server] Migrations failed — refusing to start:', err);
      process.exit(1);
    }
  }

  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`[WedMoments Core Server] Running on http://0.0.0.0:${CONFIG.PORT}`);
    console.log(`[WedMoments Core Server] Serving static uploads from: ${CONFIG.UPLOADS_DIR}`);
    console.log(`[WedMoments Core Server] Event-Scoped WebSockets ready on ws://0.0.0.0:${CONFIG.PORT}`);
  });

  // Start the in-process FTP server for in-camera background transfer (if enabled).
  startFtpServer();
}

/**
 * Ordered shutdown.
 *
 * Without this the process was killed outright on every deploy, scale-down and
 * `docker stop`, and that is not a cosmetic problem here: an upload writes its
 * display, thumbnail and original to storage *before* the row that points at
 * them can be committed. `photoWrite.savePhotoVariants` cleans that up when a
 * request fails, but a SIGKILL mid-request skips the cleanup and the database
 * transaction alike — leaving objects in the bucket that no row references, no
 * quota counts, and nothing will ever find again. This repository has recorded
 * three separate instances of that failure class already.
 *
 * The budget matters as much as the sequence. An orchestrator sends SIGTERM,
 * waits, then sends SIGKILL — Docker's default grace is 10 seconds. A drain
 * longer than that is not a graceful shutdown, it is the same abrupt kill with
 * extra logging, so this finishes comfortably inside the default and states the
 * assumption rather than leaving it implied. Raise it only alongside the
 * orchestrator's own timeout.
 */
const SHUTDOWN_BUDGET_MS = Number(process.env.SHUTDOWN_BUDGET_MS || 8000);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second SIGTERM (an impatient operator, or a restart racing a stop) must
  // not restart the sequence and double-close the pool.
  if (shuttingDown) {
    console.log(`[WedMoments Core Server] ${signal} received while already shutting down - ignoring.`);
    return;
  }
  shuttingDown = true;
  console.log(`[WedMoments Core Server] ${signal} received - draining (budget ${SHUTDOWN_BUDGET_MS}ms).`);

  // Whatever happens below, the process must not outlive its budget: an
  // orchestrator's SIGKILL is the worse version of this, so beat it.
  const hardExit = setTimeout(() => {
    console.error('[WedMoments Core Server] Drain exceeded its budget - exiting anyway.');
    process.exit(1);
  }, SHUTDOWN_BUDGET_MS);
  hardExit.unref();

  try {
    // 1. Stop accepting new work. Existing requests keep running; the callback
    //    fires once the last one has finished.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Nothing forces idle keep-alive sockets to close, and a browser holding
      // one would stall server.close() for its full timeout.
      server.closeIdleConnections?.();
    });
    console.log('[WedMoments Core Server] HTTP server closed; in-flight requests finished.');

    // 2. Guests watching a feed get a close frame rather than a reset, so the
    //    client reconnect logic sees a clean disconnect.
    wsManager.shutdown();

    // 3. The FTP listener holds its own socket and its own in-flight transfers.
    stopFtpServer();

    // 4. Release database connections last: steps 1-3 can still be using them.
    await pool.end();
    console.log('[WedMoments Core Server] Connections drained. Goodbye.');

    clearTimeout(hardExit);
    process.exit(0);
  } catch (err) {
    console.error('[WedMoments Core Server] Error during shutdown:', err);
    clearTimeout(hardExit);
    process.exit(1);
  }
}

// SIGTERM is what an orchestrator sends; SIGINT is Ctrl+C in a terminal. Both
// mean the same thing here.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();

export { app, server, shutdown, SHUTDOWN_BUDGET_MS };
