/**
 * Derives the app's WebSocket URL from the page location — the frontend follows whatever port
 * the server actually bound (start.bat's port-fallback loop may land on 3001+, and the server
 * always reports the same scheme the page was served over).
 */
export function getWebSocketUrl(): string {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.host || 'localhost:3000';
  return `${wsProtocol}//${wsHost}/stream`;
}
