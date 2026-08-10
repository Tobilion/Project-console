import { useRef, useCallback, useState } from 'react';
import { getWebSocketUrl } from '../utils/getWebSocketUrl';

export function useWebSocket(onMessage: (payload: any) => void, onOpen?: () => void) {
  const wsRef = useRef<WebSocket | null>(null);
  // M26: expose connection state so UI can show a Reconnecting banner and avoid sending into
  // a dead socket. Set true on any open, false on any close that isn't this hook tearing down.
  const [connected, setConnected] = useState(false);
  // Confirmed live 2026-07-29 (from an exported chat transcript): `onclose` used to schedule a
  // reconnect unconditionally, even when the close was self-inflicted — connectWebSocket's own
  // preemptive `.close()` of a stale socket, or (very commonly, since Vite/React 18 dev mode
  // double-invokes effects) the component-unmount cleanup closing a throwaway first-mount socket.
  // That stray reconnect fires ~3s later and silently swaps the live connection for a brand-new
  // one — and since the server creates a fresh sessionContext per WS connection (aiEnabled,
  // activeProjectId, aiModel all reset to their defaults), the user's "AI Assistant activated"
  // banner kept showing (added optimistically, client-side, at toggle time) while the *actual*
  // session had silently reverted to AI-off a few seconds later, with no error and no visual
  // change — exactly the "AI says it's on but responds like trigger mode" symptom reported. Any
  // deliberate close (via `disconnect()` below, or connectWebSocket's own replacement of an old
  // socket) now marks `intentionalClose` first, so `onclose` only auto-reconnects after a close
  // this hook didn't initiate itself (the server restarting, a real network drop, etc).
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M17: exponential backoff for unexpected disconnects (server restart / real network drop).
  // Reset to the base on a successful onopen so a flaky reconnect spurt doesn't permanently
  // slow recovery, and cleared in disconnect() so a real unmount can't fire a stray reconnect.
  const reconnectDelayRef = useRef(1000);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
    }
    const wsUrl = getWebSocketUrl();
    const ws = new WebSocket(wsUrl);

     ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        onMessage(payload);
      } catch (err) {
        // M25: a malformed frame used to vanish here with no log — surface it so future
        // case-handler throws are diagnosable. The connection stays up.
        console.error('WS message parse/handle error:', err);
      }
    };

    ws.onopen = () => {
      // This connection is now the live one — a close from here on (until something explicitly
      // calls disconnect()) is unexpected and SHOULD trigger a reconnect.
      intentionalCloseRef.current = false;
      // M17: a successful (re)connect cancels any pending reconnect timer and resets backoff.
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectDelayRef.current = 1000;
      setConnected(true);
      // Reconnect hook: the server's per-connection state (in-flight turns, busy flags) was
      // wiped when the old socket died, so the client must reset its own busy indicators too
      // (audit 2026-08-06, Phase 3).
      onOpen?.();
    };

    ws.onclose = () => {
      setConnected(false);
      // M16: per-socket guard — by the time this fires, wsRef.current has usually moved on to a
      // newer socket. The old onclose must NOT schedule a reconnect (it used to fire AFTER the
      // new onopen, swap out the live connection, and silently reset server-side AI state — the
      // "AI says it's on but responds like trigger mode" ghost).
      if (intentionalCloseRef.current || wsRef.current !== ws) return;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connectWebSocket, reconnectDelayRef.current);
      reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 15000);
    };

    wsRef.current = ws;
  }, [onMessage, onOpen]);

  /** Closes the socket without triggering the auto-reconnect — use this on real unmount. */
  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close();
  }, []);

  const sendMessage = (data: object) => {
    // Guard + throw rather than silent no-op: callers (useAI's handleAIToggle) catch this and
    // surface an error message, and a silent send would leave the toggle optimistically ON while
    // the server never received ai_toggle (audit 2026-08-06, Phase 3). Mirrors the readyState
    // guard pattern already used by handleCancel/handleStopProcess.
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    wsRef.current.send(JSON.stringify(data));
  };

  return { wsRef, connectWebSocket, disconnect, sendMessage, connected };
}
