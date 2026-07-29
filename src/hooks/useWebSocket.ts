import { useRef, useCallback } from 'react';

export function useWebSocket(onMessage: (payload: any) => void) {
  const wsRef = useRef<WebSocket | null>(null);
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

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
    }
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host || 'localhost:3000';
    const wsUrl = `${wsProtocol}//${wsHost}/stream`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        onMessage(payload);
      } catch {}
    };

    ws.onopen = () => {
      // This connection is now the live one — a close from here on (until something explicitly
      // calls disconnect()) is unexpected and SHOULD trigger a reconnect.
      intentionalCloseRef.current = false;
    };

    ws.onclose = () => {
      if (intentionalCloseRef.current) return;
      setTimeout(connectWebSocket, 3000);
    };

    wsRef.current = ws;
  }, [onMessage]);

  /** Closes the socket without triggering the auto-reconnect — use this on real unmount. */
  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    wsRef.current?.close();
  }, []);

  const sendMessage = (data: object) => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify(data));
    }
  };

  return { wsRef, connectWebSocket, disconnect, sendMessage };
}
