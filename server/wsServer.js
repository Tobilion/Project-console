import { WebSocketServer } from 'ws';

export const wss = new WebSocketServer({ noServer: true });

export function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}
