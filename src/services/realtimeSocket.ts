export interface RealtimeSocketHandlers {
  /** The event room to auto-join once the socket opens, if any. */
  getActiveEventId: () => string;
  onMessage: (data: unknown) => void;
}

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
        const delay = Math.min(this.reconnectDelay, 60000);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
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
