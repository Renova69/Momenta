import type { Server } from 'http';

/** How often idle connections are swept while a drain waits on in-flight requests. */
const IDLE_SWEEP_MS = 100;

/**
 * Stop accepting connections and resolve once every request already being
 * served has finished.
 *
 * `closeRealtime` must close the WebSocket clients, and it runs inside the
 * drain rather than after it (N-66). A WebSocket is an upgraded HTTP
 * connection, and `server.close()` waits for every connection the listener
 * accepted, upgraded ones included. Awaiting the close first meant one guest
 * watching a feed held it open for the whole shutdown budget, so every deploy
 * ended in the hard exit, before the FTP stop and `pool.end()`.
 */
export function drainHttpServer(server: Server, closeRealtime: () => void): Promise<void> {
  return new Promise((resolve) => {
    // Idle keep-alive connections are closed now, but a request still being
    // served answers "keep-alive" even during a close, so its connection
    // turns idle afterwards and would hold the drain until the keep-alive
    // timeout. Sweep until the drain is done.
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
    sweep.unref();
    server.close(() => {
      clearInterval(sweep);
      resolve();
    });
    server.closeIdleConnections();
    closeRealtime();
  });
}
