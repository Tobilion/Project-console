import { useRef, useCallback } from 'react';

export function useWebSocket(onMessage: (payload: any) => void) {
  const wsRef = useRef<WebSocket | null>(null);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
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

    ws.onclose = () => {
      setTimeout(connectWebSocket, 3000);
    };

    wsRef.current = ws;
  }, [onMessage]);

  const sendMessage = (data: object) => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify(data));
    }
  };

  return { wsRef, connectWebSocket, sendMessage };
}
