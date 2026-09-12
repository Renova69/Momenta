import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { CONFIG } from '../lib/config';
import { pool } from '../lib/db';
import { AuthUserPayload, isSessionTokenPayload, isSessionTokenCurrent } from '../middleware/auth';
import { isValidUuid } from '../lib/validation';

/** Anything JSON.stringify can carry down a socket. */
export type BroadcastPayload = unknown;

export interface ClientMeta {
  eventId?: string;
  isHost?: boolean;
  guestId?: string;
  userId?: string;
  isAlive?: boolean;
}

// --------------------------------------------------------------------
// SEC-D6 — a client sending JOIN_EVENT_ROOM frames in a tight loop turned
// each one into a `pool.query`; nothing throttled the message rate, so
// enough of them exhausted the connection pool and every HTTP endpoint
// started timing out along with it.
// --------------------------------------------------------------------
const MAX_MESSAGES_PER_WINDOW = 20;
const MESSAGE_WINDOW_MS = 10_000;

interface RateWindow {
  windowStart: number;
  count: number;
}

/** How long a resolved host-ownership check is trusted before re-querying. */
const HOST_CHECK_TTL_MS = 60_000;

/**
 * DB-04 — client.send() queues onto bufferedAmount when the socket can't
 * drain as fast as messages arrive (a stalled mobile connection on a bad
 * signal, say). Nothing capped that queue, so a slow consumer's backlog
 * could grow without bound for as long as the connection stayed open.
 */
const MAX_CLIENT_BUFFERED_BYTES = 512 * 1024;

// Reaction batching (P6) — see queueReaction().
const REACTION_BATCH_WINDOW_MS = 200;
const REACTION_BATCH_MAX_SIZE = 50;

interface HostCheckEntry {
  isHost: boolean;
  expiresAt: number;
}

export class WsEventManager {
  private wss: WebSocketServer | null = null;
  private clientMeta = new Map<WebSocket, ClientMeta>();
  private eventRooms = new Map<string, Set<WebSocket>>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private messageRates = new Map<WebSocket, RateWindow>();
  private hostCheckCache = new Map<string, HostCheckEntry>();
  private reactionQueues = new Map<string, BroadcastPayload[]>();
  private reactionFlushTimers = new Map<string, NodeJS.Timeout>();

  /** True (and records the attempt) once a connection exceeds the per-window message budget. */
  private isRateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    const window = this.messageRates.get(ws);
    if (!window || now - window.windowStart > MESSAGE_WINDOW_MS) {
      this.messageRates.set(ws, { windowStart: now, count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > MAX_MESSAGES_PER_WINDOW;
  }

  /** Cached host-ownership check — a repeated JOIN for the same user+event does not re-hit the DB every time. */
  private async isEventHost(userId: string, eventId: string): Promise<boolean> {
    const key = `${userId}:${eventId}`;
    const cached = this.hostCheckCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.isHost;

    let isHost = false;
    try {
      const eventRes = await pool.query('SELECT host_user_id FROM events WHERE id = $1', [eventId]);
      isHost = eventRes.rows.length > 0 && eventRes.rows[0].host_user_id === userId;
    } catch (e) {
      console.warn('[WS] Error verifying host ownership:', e);
    }
    this.hostCheckCache.set(key, { isHost, expiresAt: Date.now() + HOST_CHECK_TTL_MS });
    return isHost;
  }

  /**
   * Evicts expired hostCheckCache entries (DB-07). A stale entry is only
   * ever overwritten if that exact userId:eventId pair is looked up again -
   * one that never is (a user who joined one room once) stayed in the Map
   * forever without this.
   */
  private sweepHostCheckCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.hostCheckCache) {
      if (entry.expiresAt <= now) this.hostCheckCache.delete(key);
    }
  }

  /**
   * CORS does not apply to WebSocket upgrades, so the allow-list has to be
   * enforced here explicitly.
   *
   * Same-origin is always allowed, whatever CORS_ORIGIN says. The SPA is served
   * by this same process in the Docker deployment, while CORS_ORIGIN is written
   * for the split dev setup (Vite on 6500 talking to the API on 6501) - so the
   * configured list did not contain the app's own origin, and every WebSocket
   * from the real app was refused with a 403. Browsers always send Origin on an
   * upgrade, which is why this broke sockets while leaving HTTP working.
   *
   * Requests with no Origin at all (native clients, tests, curl) are accepted;
   * the token check on the connection is what actually authenticates a host.
   */
  private isAllowedOrigin(origin: string | undefined, hostHeader?: string): boolean {
    if (!origin) return true;

    // Same-origin: the Origin's authority matches the Host we were reached on.
    if (hostHeader) {
      try {
        if (new URL(origin).host === hostHeader) return true;
      } catch {
        // Malformed Origin - fall through to the allow-list.
      }
    }

    // SEC-A4: no configured allow-list is not "allow everything" - a
    // cross-origin page could otherwise open a WS connection to this server
    // from anywhere and ride the visitor's session. Same-origin is already
    // handled above; anything else with no CORS_ORIGIN configured is refused.
    if (!CONFIG.CORS_ORIGIN) return false;

    const allowed = CONFIG.CORS_ORIGIN.toString()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return allowed.includes(origin);
  }

  public init(server: Server): WebSocketServer {
    this.wss = new WebSocketServer({
      server,
      maxPayload: 65536, // 64KB max control message limit
      verifyClient: ({ origin, req }, done) => {
        if (this.isAllowedOrigin(origin, req.headers.host)) return done(true);
        console.warn(`[WS] Rejected upgrade from disallowed origin: ${origin} (${req.url})`);
        done(false, 403, 'Origin not allowed');
      },
    });

    // 30-second heartbeat to detect dead mobile TCP connections
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach((ws) => {
        const meta = this.clientMeta.get(ws);
        if (meta && meta.isAlive === false) {
          this.removeClient(ws);
          return ws.terminate();
        }
        if (meta) meta.isAlive = false;
        ws.ping();
      });

      // DB-07: piggy-backing on the existing heartbeat avoids a second timer.
      this.sweepHostCheckCache();
    }, 30000);

    this.wss.on('close', () => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      // DB-15: entries self-clear when they fire normally, but a shutdown
      // mid-window otherwise leaves their timers running past the server
      // they were queued to broadcast through.
      for (const timer of this.reactionFlushTimers.values()) clearTimeout(timer);
      this.reactionFlushTimers.clear();
    });

    this.wss.on('connection', (ws) => {
      // Authenticated over an AUTH message after the handshake, not a ?token=
      // query parameter — the connection URL otherwise ends up in access logs,
      // proxy logs and browser history with a live 7-day session token in it
      // (SEC-A5). See the 'AUTH' case below.
      let verifiedUser: AuthUserPayload | null = null;

      this.clientMeta.set(ws, { isAlive: true, userId: undefined });

      ws.on('pong', () => {
        const meta = this.clientMeta.get(ws);
        if (meta) meta.isAlive = true;
      });

      ws.send(JSON.stringify({ type: 'CONNECTED', payload: { time: new Date().toISOString() } }));

      /**
       * Frames from one connection are processed strictly in the order they
       * arrived.
       *
       * Node does not await an async 'message' listener, so two frames sent
       * back-to-back have their handlers interleaved at the first await. The
       * client's opening handshake is exactly that shape — AUTH immediately
       * followed by JOIN_EVENT_ROOM — and AUTH now awaits a token_version
       * lookup (H9). Without this chain, JOIN reads `verifiedUser` while AUTH
       * is still resolving and every genuine host joins as a guest.
       *
       * The per-connection rate limit is applied before queueing, so a flood
       * is still dropped on arrival rather than buffered into this chain.
       */
      let frameQueue: Promise<void> = Promise.resolve();

      const handleFrame = async (data: unknown): Promise<void> => {
        try {
          const msg = JSON.parse(String(data));
          if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return;

          if (msg.type === 'AUTH' && typeof msg.token === 'string') {
            try {
              // SEC-01: reject a decodable-but-wrong-purpose token (a
              // replayed export-zip download token, say) the same way
              // requireAuth does — it must not grant host-equivalent WS
              // privileges just because it carries a real userId.
              const decoded = jwt.verify(msg.token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] });
              if (!isSessionTokenPayload(decoded)) {
                verifiedUser = null;
                return;
              }
              // H9: a signature alone is not enough — requireAuth and
              // optionalAuth both check users.token_version (migration 019),
              // and this must agree with them. Without it a host who signed
              // out kept full isHost privileges on any socket that stayed
              // open, and broadcastToEventHosts is the channel carrying
              // photos still awaiting moderation with signed preview tokens
              // embedded. The shared-machine case migration 019 exists for is
              // exactly the one this left open.
              //
              // One indexed primary-key lookup, and only on an AUTH frame:
              // the per-connection budget above (20 messages / 10s) already
              // bounds how often a client can ask for one. Fails closed, same
              // as the HTTP path.
              if (!(await isSessionTokenCurrent(decoded))) {
                verifiedUser = null;
                return;
              }
              verifiedUser = decoded;
              const meta = this.clientMeta.get(ws);
              this.clientMeta.set(ws, { ...meta, isAlive: true, userId: verifiedUser.userId });
            } catch {
              // Invalid or expired token — the connection stays a guest connection.
              verifiedUser = null;
            }
            return;
          }

          if (msg.type === 'JOIN_EVENT_ROOM' && typeof msg.eventId === 'string' && isValidUuid(msg.eventId)) {
            const eventId = msg.eventId;

            // Remove from old room if any
            const oldMeta = this.clientMeta.get(ws);
            if (oldMeta?.eventId && oldMeta.eventId !== eventId) {
              this.eventRooms.get(oldMeta.eventId)?.delete(ws);
            }

            // Verify if user actually owns this event for isHost privilege.
            // Cached — a client re-joining the same room repeatedly (or a
            // reconnect storm) does not re-hit the DB every time (SEC-D6).
            const isHost = verifiedUser?.userId ? await this.isEventHost(verifiedUser.userId, eventId) : false;

            this.clientMeta.set(ws, {
              eventId,
              isHost,
              userId: verifiedUser?.userId,
              guestId: typeof msg.guestId === 'string' ? msg.guestId : undefined,
              isAlive: true,
            });

            if (!this.eventRooms.has(eventId)) {
              this.eventRooms.set(eventId, new Set());
            }
            this.eventRooms.get(eventId)!.add(ws);

            ws.send(JSON.stringify({ type: 'ROOM_JOINED', eventId, isHost }));
          } else if (msg.type === 'LEAVE_EVENT_ROOM') {
            const currentMeta = this.clientMeta.get(ws);
            if (currentMeta?.eventId) {
              this.eventRooms.get(currentMeta.eventId)?.delete(ws);
            }
            this.clientMeta.set(ws, { isAlive: true, userId: verifiedUser?.userId });
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.on('message', (data) => {
        // A flood of frames (JOIN_EVENT_ROOM in a tight loop, say) is dropped
        // here, before it can be queued or turn into a DB query (SEC-D6).
        if (this.isRateLimited(ws)) return;
        frameQueue = frameQueue.then(() => handleFrame(data)).catch(() => undefined);
      });

      ws.on('close', () => { this.removeClient(ws); });
      ws.on('error', () => { this.removeClient(ws); });
    });

    return this.wss;
  }

  private removeClient(ws: WebSocket) {
    const meta = this.clientMeta.get(ws);
    if (meta?.eventId) {
      this.eventRooms.get(meta.eventId)?.delete(ws);
      if (this.eventRooms.get(meta.eventId)?.size === 0) {
        this.eventRooms.delete(meta.eventId);
      }
    }
    this.clientMeta.delete(ws);
    this.messageRates.delete(ws);
  }

  // Scoped broadcast in O(K) time using room index
  public broadcastToEvent(eventId: string, type: string, payload: BroadcastPayload) {
    this.send(eventId, type, payload, false);
  }

  /**
   * Queue an ephemeral reaction instead of broadcasting it immediately.
   *
   * A room with 100+ guests reacting at once turned into one WebSocket
   * message per tap, straight to every client — the projector wall (a
   * browser rendering many DOM nodes on a TV, often underpowered hardware)
   * is the one that feels this as dropped frames and DOM thrashing (P6).
   * Batching the ones that land within a short window into one
   * `REACTIONS_BATCH` message trades a little latency for far fewer
   * messages during a burst; a single reaction still lands within one
   * flush interval, which reads as instant.
   */
  public queueReaction(eventId: string, payload: BroadcastPayload): void {
    const queue = this.reactionQueues.get(eventId) || [];
    queue.push(payload);
    this.reactionQueues.set(eventId, queue);

    if (queue.length >= REACTION_BATCH_MAX_SIZE) {
      this.flushReactionQueue(eventId);
      return;
    }
    if (!this.reactionFlushTimers.has(eventId)) {
      const timer = setTimeout(() => this.flushReactionQueue(eventId), REACTION_BATCH_WINDOW_MS);
      this.reactionFlushTimers.set(eventId, timer);
    }
  }

  private flushReactionQueue(eventId: string): void {
    const timer = this.reactionFlushTimers.get(eventId);
    if (timer) clearTimeout(timer);
    this.reactionFlushTimers.delete(eventId);

    const queue = this.reactionQueues.get(eventId);
    this.reactionQueues.delete(eventId);
    if (!queue || queue.length === 0) return;

    this.send(eventId, 'REACTIONS_BATCH', { reactions: queue }, false);
  }

  /**
   * Broadcast only to verified hosts of the event.
   *
   * Room membership is deliberately unauthenticated — guests join by scanning a
   * QR code — so anything a guest must not see (photos awaiting moderation, host
   * contact details) has to go down this channel instead.
   */
  public broadcastToEventHosts(eventId: string, type: string, payload: BroadcastPayload) {
    this.send(eventId, type, payload, true);
  }

  private send(eventId: string, type: string, payload: BroadcastPayload, hostsOnly: boolean) {
    if (!this.wss || !eventId) return;
    const clients = this.eventRooms.get(eventId);
    if (!clients || clients.size === 0) return;

    const message = JSON.stringify({ type, payload, eventId });

    clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (hostsOnly && !this.clientMeta.get(client)?.isHost) return;
      // A backlog past the cap means the client isn't draining fast enough
      // to keep up — terminating rather than piling on is what stops
      // unbounded growth; the client's own reconnect logic picks it back up.
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        console.warn(`[WS] Terminating slow consumer for event ${eventId}: ${client.bufferedAmount} bytes buffered`);
        this.removeClient(client);
        client.terminate();
        return;
      }
      client.send(message);
    });
  }

  public getConnectedClientsCount(): number {
    return this.wss?.clients.size || 0;
  }

  /**
   * Graceful teardown (DB-15) — closing the underlying WebSocketServer fires
   * its own 'close' handler above, which clears the heartbeat interval and
   * any pending reaction-flush timers. A plain process exit reaps all of
   * this regardless, so this only matters for a restart that doesn't exit
   * the process (a test harness, a hot-reload dev loop).
   */
  public shutdown(): void {
    // wss.close() only stops accepting new connections - existing clients
    // stay open per the `ws` library's own documented behavior, which would
    // leave the 'close' event (and the timer cleanup it runs) waiting on
    // client disconnects that may never come. Terminate them explicitly.
    this.wss?.clients.forEach((client) => client.terminate());
    this.wss?.close();
  }
}

export const wsManager = new WsEventManager();
