export interface RealtimeSocketHandlers {
  /** The event room to auto-join once the socket opens, if any. */
  getActiveEventId: () => string;
  onMessage: (data: unknown) => void;
  /**
   * Called when a dropped connection is back and has rejoined its room.
   * Whatever was broadcast while it was down is gone, so reload (N-68).
   */
  onReconnect?: () => void;
}

const MAX_RECONNECT_DELAY_MS = 60_000;
/**
 * Up to this share of each backoff step is taken off at random (N-68). When
 * the server restarts, every guest's socket drops at once; without jitter they
 * all came back at the same instant, on every step of the backoff.
 */
const RECONNECT_JITTER = 0.5;

/**
 * Owns the raw event WebSocket connection: connect, the AUTH/JOIN_EVENT_ROOM
 * handshake on open, and exponential reconnect backoff. Message parsing and
 * every application-level effect of a message stays with the caller
 * (`onMessage`) — this class only knows how to keep a socket alive.
 */
export class RealtimeSocket {
  private ws: WebSocket | null = null;
  private reconnectDelay: number = 1000; // [FIX H-8] Start at 1s
  private destroyed: boolean = false;
  private hasOpened: boolean = false;

  constructor(private readonly host: string, private readonly handlers: RealtimeSocketHandlers) {}

  connect(): void {
    if (this.destroyed) return;
    try {
      // No ?token= on the URL (SEC-A5) — a session token in the connection
      // string ends up in access logs, proxy logs and browser history. Sent
      // as the first message on the open socket instead.
      this.ws = new WebSocket(this.host);

      this.ws.onopen = () => {
        // [FIX H-8] Reset backoff on successful connect
        this.reconnectDelay = 1000;
        const token = typeof window !== 'undefined' ? localStorage.getItem('wedmoments_host_token') : null;
        const activeEventId = this.handlers.getActiveEventId();
        if (this.ws?.readyState === WebSocket.OPEN) {
          if (token) {
            this.ws.send(JSON.stringify({ type: 'AUTH', token }));
          }
          if (activeEventId) {
            this.ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId: activeEventId }));
          }
        }
        // After the join, so nothing broadcast between the reload and the
        // join can be missed.
        if (this.hasOpened) this.handlers.onReconnect?.();
        this.hasOpened = true;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handlers.onMessage(data);
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      this.ws.onclose = () => {
        if (this.destroyed) return;
        // [FIX H-8] Exponential backoff: 1s → 2s → 4s → 8s → max 60s
        const backoff = Math.min(this.reconnectDelay, MAX_RECONNECT_DELAY_MS);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        const delay = backoff * (1 - Math.random() * RECONNECT_JITTER);
        setTimeout(() => this.connect(), delay);
      };
    } catch {
      console.warn('WebSocket connection not ready, using local storage.');
    }
  }

  joinEventRoom(eventId: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && eventId) {
      this.ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
    }
  }
}
