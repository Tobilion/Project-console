import { state } from '../state.js';
import { wss } from '../wsServer.js';
import { BASE_PORT as PORT, HOST, MAX_PORT_ATTEMPTS } from '../portConfig.js';
import { authArmed, checkWsAuth } from '../auth/authGate.js';
import { log } from '../logger.js';

/**
 * Port fallback: try PORT through PORT+MAX_PORT_ATTEMPTS-1. Reuses the single httpServer
 * created up front (rather than a fresh server per attempt) so Vite's HMR upgrade listener
 * and the WebSocket server stay valid once we actually bind.
 *
 * Returns the bound httpServer on success, never returns on failure (process.exit(1)).
 */
export async function bindPort(httpServer, emitBootState) {
  let server = null;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const tryPort = PORT + attempt;
    try {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          httpServer.removeListener('error', onError);
          state.serverPort = tryPort;
          globalThis.__consoleServerPort = tryPort;
          emitBootState('ready');
          log.info(`Console Server running on http://${HOST}:${tryPort}`);
          log.info(`Default scan path: ${state.currentScanDirectory}`);
          if (HOST === '0.0.0.0') {
            // Phase I: with accounts armed, LAN exposure is login-gated — the scary
            // sentence below only applies to the open (no users) configuration.
            if (authArmed()) {
              log.info('Bound to 0.0.0.0 — reachable from your LAN, login required (auth is armed).');
            } else {
              log.info('WARNING: bound to 0.0.0.0 — reachable from your LAN. This server can run shell commands with no authentication.');
            }
          }
          resolve();
        };
        const onError = (err) => {
          httpServer.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE') {
            log.info(`Port ${tryPort} in use, trying ${tryPort + 1}...`);
          }
          reject(err);
        };
        httpServer.once('listening', onListening);
        httpServer.once('error', onError);
        httpServer.listen(tryPort, HOST);
      });
      server = httpServer;
      break; // succeeded
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= MAX_PORT_ATTEMPTS - 1) {
        const message =
          err.code === 'EADDRINUSE' && attempt >= MAX_PORT_ATTEMPTS - 1
            ? `No free port between ${PORT} and ${PORT + MAX_PORT_ATTEMPTS - 1} — every port in the range is in use. Close other apps using these ports and restart the console.`
            : err.message;
        log.error(`Failed to start server: ${message}`);
        process.exit(1);
      }
      // continue to next port — httpServer isn't listening yet, so it's safe to retry .listen()
    }
  }

  if (server) {
    // Non-fatal socket error handler: a client that connected then vanished mid-upgrade
    // surfaces as 'error' on the httpServer itself — without a permanent listener this
    // crashes the whole server (observed live twice).
    server.on('error', (err) => {
      log.error('HTTP server error (non-fatal, connection dropped):', err.message);
    });

    // Upgrade handler: WebSocket connections on /stream, leave Vite's HMR socket alone.
    server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {});
      const origin = request.headers.origin;
      if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
        socket.destroy();
        return;
      }
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (pathname === '/stream' || pathname === '/stream/') {
        // Phase I: armed servers reject unauthenticated sockets with a 401 status line
        // (instead of a bare destroy) so CLI clients can report "login required".
        if (!checkWsAuth(request)) {
          try {
            socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"ok":false,"error":"Login required."}');
          } catch { /* best-effort */ }
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    });
  }

  return server;
}
