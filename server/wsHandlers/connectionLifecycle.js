import { wss } from '../wsServer.js';
import { sweepExpiredConfirmations } from '../state.js';
import { appendMessage } from '../conversationStore.js';
import { metrics } from '../metrics.js';
import { routeMessage } from './connectionRoutes.js';

function heartbeat() {
  this.isAlive = true;
}

/** Wires up the WebSocket server's connection/message lifecycle. Called once at startup. */
export function initWebSocketServer() {
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
    sweepExpiredConfirmations();
  }, 20000);

  wss.on('close', () => clearInterval(heartbeatInterval));
  wss.on('connection', onConnection);
}

function onConnection(ws) {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // Intercept ws.send to auto-save bot responses to conversation store. (Streamed AI
  // responses are persisted explicitly by handleAIQuery instead — see wsHandlers/aiQuery.js.)
  // Buffer 'start'/'output'/'end' chunks (executeCommand's stdout stream) into a single
  // message per command instead of dropping them — previously only 'answer'/'error_output'
  // were persisted, so exported/reloaded sessions never showed executed-command output at
  // all (e.g. the git push/commit result from a "deploy" confirmation).
  let commandOutputBuffer = '';
  const origSend = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
      if (sessionContext.currentSessionId && (parsed.type === 'answer' || parsed.type === 'error_output' || parsed.type === 'warning') && parsed.data) {
        appendMessage(sessionContext.currentSessionId, {
          role: parsed.type === 'error_output' ? 'error' : parsed.type === 'warning' ? 'warning' : 'bot',
          content: typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data),
          // Answers are always markdown-rendered live (useConsole.ts sets isMarkdown: true);
          // persisting the flag is what lets a reloaded chat keep the styling.
          isMarkdown: parsed.type === 'answer',
        }).catch(() => {});
      } else if (sessionContext.currentSessionId && (parsed.type === 'start' || parsed.type === 'output') && parsed.data) {
        commandOutputBuffer += parsed.data;
      } else if (sessionContext.currentSessionId && parsed.type === 'end') {
        if (parsed.data) commandOutputBuffer += parsed.data;
        if (commandOutputBuffer.trim()) {
          // Raw command output — explicitly NOT markdown, so the renderer keeps the mono/plain
          // treatment it had live in the output block. Phase 14: persisted as its own
          // role-'output' record instead of a role-'bot' message, so a reloaded chat maps back
          // to the collapsible terminal block directly (storedToTerminalMessages keeps the old
          // 'Executing: '-prefix heuristic for legacy role-'bot' records).
          appendMessage(sessionContext.currentSessionId, {
            role: 'output',
            content: commandOutputBuffer.trim(),
            isMarkdown: false,
          }).catch(() => {});
        }
        commandOutputBuffer = '';
      } else if (sessionContext.currentSessionId && parsed.type === 'tool_start' && parsed.data) {
        // AI-mode tool trace ("Running: ..." / "Requesting approval ...") — previously never
        // persisted, so a reloaded AI session lost every tool line. Mirrors the live system
        // message formatting from useConsole.ts's tool_start case.
        appendMessage(sessionContext.currentSessionId, { role: 'system', content: `⚙ ${parsed.data}` }).catch(() => {});
      } else if (sessionContext.currentSessionId && parsed.type === 'tool_result' && parsed.data && parsed.data.tool && !parsed.data.error) {
        const r = parsed.data.result;
        const resultStr = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
        appendMessage(sessionContext.currentSessionId, {
          role: 'system',
          content: `⚙ Tool: ${parsed.data.tool}\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? '…' : ''}`,
        }).catch(() => {});
      }
    } catch {}
    origSend(data);
  };

  const sessionContext = {
    lastTriggeredEntry: null,
    activeProjectId: null,
    workspaceProjectIds: [],
    currentSessionId: null,
    aiEnabled: false,
    aiModel: null,
    aiMode: 'default',
    conversationHistory: [],
    // Set by aiQuery.js while an AI query is in flight; read by the 'cancel' handler above.
    aiAbortController: null,
    // Phase 5 (PASS 5.1): session-scoped tool grants — grantKey set for (project, tool) pairs
    // the user has already approved for this conversation. Filled by the 'approve_task' WS
    // message ("Approve this task") and by allow-after-first-ask policy approvals. Consulted by
    // resolveToolGate (tools.js) on every tool call. Per-connection, so it resets on reconnect —
    // the same lifetime as every other aiEnabled/activeProjectId setting here.
    toolGrants: new Set(),
  };

  ws.on('error', (err) => {
    console.error('WebSocket client error:', err.message);
  });

  ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);
      await routeMessage(ws, parsed, sessionContext);
    } catch (err) {
      metrics.inc('ws.parse_error');
      console.error('WS error:', err);
      ws.send(JSON.stringify({ type: 'error_output', data: `Error processing request: ${err.message}` }));
      ws.send(JSON.stringify({ type: 'end' }));
    }
  });
}
