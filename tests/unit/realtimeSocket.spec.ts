import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeSocket } from '../../src/services/realtimeSocket';

/**
 * The event WebSocket's connection lifecycle.
 *
 * This class is what keeps a guest's screen live for the length of a wedding,
 * on venue Wi-Fi. Two of its rules are load-bearing and neither was covered:
 *
 *   SEC-A5 — the session token is sent as the first message on the open
 *   socket, never as `?token=` on the URL, because a connection string ends up
 *   in access logs, proxy logs and browser history.
 *
 *   H-8 — reconnects back off exponentially and the delay resets on a
 *   successful connect. Without the reset, one bad patch early in the evening
 *   leaves every later reconnect waiting a minute.
 */

type Listener = ((ev: unknown) => void) | null;

/** A WebSocket stand-in whose open/close/message are driven by the test. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Complete the handshake the way a real server would. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }

  deliver(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  get messages(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const HOST = 'ws://localhost:6501';

function install() {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
}

beforeEach(() => {
  localStorage.clear();
  install();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RealtimeSocket handshake', () => {
  it('never puts the token in the connection URL (SEC-A5)', () => {
    localStorage.setItem('wedmoments_host_token', 'a-real-session-token');
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });

    socket.connect();
    const ws = FakeWebSocket.instances[0];

    expect(ws.url).toBe(HOST);
    expect(ws.url).not.toContain('token');
    expect(ws.url).not.toContain('a-real-session-token');
  });

  it('sends AUTH then JOIN_EVENT_ROOM once open', () => {
    localStorage.setItem('wedmoments_host_token', 'tok');
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });

    socket.connect();
    FakeWebSocket.instances[0].open();

    expect(FakeWebSocket.instances[0].messages).toEqual([
      { type: 'AUTH', token: 'tok' },
      { type: 'JOIN_EVENT_ROOM', eventId: 'e1' },
    ]);
  });

  it('joins the room without AUTH when there is no host token, which is the guest case', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });

    socket.connect();
    FakeWebSocket.instances[0].open();

    expect(FakeWebSocket.instances[0].messages).toEqual([{ type: 'JOIN_EVENT_ROOM', eventId: 'e1' }]);
  });

  it('sends nothing when there is neither a token nor an active event', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => '', onMessage: vi.fn() });

    socket.connect();
    FakeWebSocket.instances[0].open();

    expect(FakeWebSocket.instances[0].sent).toEqual([]);
  });

  it('does not send on a socket that is not actually open', () => {
    localStorage.setItem('wedmoments_host_token', 'tok');
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });

    socket.connect();
    // onopen fired, but the socket closed again before the handshake ran.
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.CLOSING;
    ws.onopen?.({});

    expect(ws.sent).toEqual([]);
  });
});

describe('RealtimeSocket messages', () => {
  it('parses a payload and hands it to the caller', () => {
    const onMessage = vi.fn();
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage });

    socket.connect();
    FakeWebSocket.instances[0].deliver(JSON.stringify({ type: 'PHOTO_ADDED', payload: { id: 'p1' } }));

    expect(onMessage).toHaveBeenCalledWith({ type: 'PHOTO_ADDED', payload: { id: 'p1' } });
  });

  it('survives a malformed frame instead of tearing down the connection', () => {
    const onMessage = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage });

    socket.connect();
    expect(() => FakeWebSocket.instances[0].deliver('not json at all')).not.toThrow();

    expect(onMessage).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });
});

describe('RealtimeSocket reconnection (H-8)', () => {
  it('backs off exponentially: 1s, 2s, 4s', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });
    socket.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].close();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].close();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2].close();
    vi.advanceTimersByTime(4000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('resets the delay after a successful connect, so one bad patch is not permanent', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });
    socket.connect();

    // Three failures in a row push the backoff out to 8s.
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.instances[i].close();
      vi.advanceTimersByTime(60000);
    }
    expect(FakeWebSocket.instances).toHaveLength(4);

    // Wi-Fi comes back.
    FakeWebSocket.instances[3].open();

    // The next drop must wait 1s again, not 8.
    FakeWebSocket.instances[3].close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  it('caps the delay at 60 seconds', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });
    socket.connect();

    // Drive the backoff well past the cap.
    for (let i = 0; i < 10; i++) {
      FakeWebSocket.instances[i].close();
      vi.advanceTimersByTime(60000);
    }

    const before = FakeWebSocket.instances.length;
    FakeWebSocket.instances[before - 1].close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
  });

  it('re-runs the handshake on every reconnect', () => {
    localStorage.setItem('wedmoments_host_token', 'tok');
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });

    socket.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].open();

    expect(FakeWebSocket.instances[1].messages).toEqual([
      { type: 'AUTH', token: 'tok' },
      { type: 'JOIN_EVENT_ROOM', eventId: 'e1' },
    ]);
  });

  it('does not reconnect when the constructor itself throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('blocked');
        }
      } as unknown as typeof WebSocket
    );

    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => 'e1', onMessage: vi.fn() });
    expect(() => socket.connect()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('RealtimeSocket.joinEventRoom', () => {
  it('sends a join on an open socket', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => '', onMessage: vi.fn() });
    socket.connect();
    FakeWebSocket.instances[0].open();

    socket.joinEventRoom('e2');

    expect(FakeWebSocket.instances[0].messages).toEqual([{ type: 'JOIN_EVENT_ROOM', eventId: 'e2' }]);
  });

  it('is a no-op while the socket is still connecting', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => '', onMessage: vi.fn() });
    socket.connect();

    socket.joinEventRoom('e2');

    expect(FakeWebSocket.instances[0].sent).toEqual([]);
  });

  it('is a no-op for an empty event id', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => '', onMessage: vi.fn() });
    socket.connect();
    FakeWebSocket.instances[0].open();

    socket.joinEventRoom('');

    expect(FakeWebSocket.instances[0].sent).toEqual([]);
  });

  it('is a no-op before connect has ever been called', () => {
    const socket = new RealtimeSocket(HOST, { getActiveEventId: () => '', onMessage: vi.fn() });
    expect(() => socket.joinEventRoom('e2')).not.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
