import { wss } from '../wsServer.js';
import { sweepExpiredConfirmations, pendingConfirmations, pendingToolConfirmations, connectionRegistry } from '../state.js';
import { appendMessage } from '../conversationStore.js';
import { metrics } from '../metrics.js';
import { routeMessage, sendAiStatus } from './connectionRoutes.js';
import { takeUpdateNotice } from '../updateChecker.js';

function heartbeat() {
  this.isAlive = true;
}

/** Wires up the WebSocket server's connection/message lifecycle. Called once at startup. */
export function initWebSocketServer() {
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      try {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        if (ws.readyState === 1) ws.ping();
      } catch {
        // A socket can flip to CLOSED between the isAlive check and the ping — the throw used
        // to abort the whole sweep, leaving the remaining clients unchecked that tick and
        // skipping sweepExpiredConfirmations (audit 2026-08-06, Phase 2).
      }
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
  // Cap the buffer so a chatty dev server can't produce one giant NDJSON line (and one giant
  // line in chat-log.md) that gets read fully into memory on every session reload (audit
  // 2026-08-06, Phase 2).
  const COMMAND_BUFFER_CAP = 200_000;
  const flushCommandBuffer = () => {
    if (!sessionContext.currentSessionId || !commandOutputBuffer.trim()) return;
    const content = commandOutputBuffer.trim();
    commandOutputBuffer = '';
    appendMessage(sessionContext.currentSessionId, {
      role: 'output',
      content,
      isMarkdown: false,
    }).catch(() => {});
  };
  const origSend = ws.send.bind(ws);
  ws.send = (data) => {
    let parsed = null;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
      if (sessionContext.currentSessionId && (parsed.type === 'answer' || parsed.type === 'error_output' || parsed.type === 'warning') && parsed.data) {
        // Flush any pending command output BEFORE the answer: executor.js streams output,
        // then sends the summary answer, then 'end' — persisting the answer first put the
        // summary before the output it summarizes on reload (audit 2026-08-06, Phase 2).
        flushCommandBuffer();
        appendMessage(sessionContext.currentSessionId, {
          role: parsed.type === 'error_output' ? 'error' : parsed.type === 'warning' ? 'warning' : 'bot',
          content: typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data),
          // Answers are always markdown-rendered live (useConsole.ts sets isMarkdown: true);
          // persisting the flag is what lets a reloaded chat keep the styling.
          isMarkdown: parsed.type === 'answer',
        }).catch(() => {});
      } else if (sessionContext.currentSessionId && (parsed.type === 'start' || parsed.type === 'output') && parsed.data) {
        // A 'start' is a command boundary — flush the previous command's buffer first so two
        // overlapping commands (AI tool loop timeout moves on while the previous process still
        // streams) can't interleave into one garbled persisted output record.
        if (parsed.type === 'start') flushCommandBuffer();
        commandOutputBuffer += parsed.data;
        if (commandOutputBuffer.length > COMMAND_BUFFER_CAP) {
          commandOutputBuffer = commandOutputBuffer.slice(-COMMAND_BUFFER_CAP);
        }
      } else if (sessionContext.currentSessionId && parsed.type === 'end') {
        if (parsed.data) commandOutputBuffer += parsed.data;
        // Raw command output — explicitly NOT markdown, so the renderer keeps the mono/plain
        // treatment it had live in the output block. Phase 14: persisted as its own
        // role-'output' record instead of a role-'bot' message, so a reloaded chat maps back
        // to the collapsible terminal block directly (storedToTerminalMessages keeps the old
        // 'Executing: '-prefix heuristic for legacy role-'bot' records).
        flushCommandBuffer();
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
    } catch (err) {
      // A parse/persist failure here means the server sent something the interceptor couldn't
      // read — previously swallowed silently. Log it; the original send still happens either way.
      console.error('WS send interceptor error:', err.message);
    }
    origSend(data);
  };

  const sessionContext = {
    lastTriggeredEntry: null,
    activeProjectId: null,
    // Phase 19 (2026-08-12): per-connection attribution label — "local" for the single-user
    // default (bound to 127.0.0.1 only: never prompted, always "local", zero behavior change).
    // When the server is LAN-bound the client/CLI may set a display name via set_display_name;
    // it's an attribution label, not an account (no auth, no permissions — LAN trust only).
    displayName: 'local',
    workspaceProjectIds: [],
    // Phase T (2026-08-14): the tab workspace this connection is scoped to (from the execute
    // payload's tabId). Project resolution goes through this tab's own scan cache when set,
    // so two tabs scanning different folders never cross-resolve. Null for legacy clients.
    tabId: null,
    currentSessionId: null,
    aiEnabled: false,
    aiModel: null,
    aiMode: 'default',
    conversationHistory: [],
    // Set by aiQuery.js while an AI query is in flight; read by the 'cancel' handler above.
    aiAbortController: null,
    // Set synchronously by handleExecute (connectionExecute.js) for the full duration of one
    // 'execute' message's processing — closes the TOCTOU window where a second 'execute' could
    // slip past the aiAbortController guard before handleAIQuery has actually assigned it (see
    // connectionExecute.js's handleExecute for the full trigger trace).
    executeInFlight: false,
    // Phase 5 (PASS 5.1): session-scoped tool grants — grantKey set for (project, tool) pairs
    // the user has already approved for this conversation. Filled by the 'approve_task' WS
    // message ("Approve this task") and by allow-after-first-ask policy approvals. Consulted by
    // resolveToolGate (tools.js) on every tool call. Per-connection, so it resets on reconnect —
    // the same lifetime as every other aiEnabled/activeProjectId setting here.
    toolGrants: new Set(),
  };

  // Phase 1: register for out-of-band targeting (scheduled-fire answers). Unregistered in
  // the close handler below; a stale entry for a dead socket could otherwise receive
  // schedule answers forever (the send would silently fail on the closed socket).
  connectionRegistry.set(ws, sessionContext);

  ws.on('error', (err) => {
    console.error('WebSocket client error:', err.message);
  });

  ws.on('close', () => {
    connectionRegistry.delete(ws);
    // A dropped connection can't press Cancel either — abort any in-flight AI query so the
    // ghost turn stops generating (and stops persisting an answer nobody will see) instead
    // of burning CPU until the model finishes (audit 2026-08-06, Phase 2).
    if (sessionContext.aiAbortController) {
      try { sessionContext.aiAbortController.abort(); } catch {}
    }
    // A mid-command disconnect used to drop the whole accumulated output buffer — the common
    // case for long builds/dev servers when the tab closes. Flush what we have before clearing
    // connection state (audit 2026-08-06, Phase 2).
    flushCommandBuffer();
    // A dropped connection can never answer its own confirm cards — release them immediately
    // instead of letting the 5-minute TTL sweep linger. Tool confirmations resolve false so an
    // in-flight AI tool loop awaiting approval fails cleanly instead of hanging until the sweep.
    for (const [token, pending] of pendingConfirmations) {
      if (pending.owner === ws) pendingConfirmations.delete(token);
    }
    for (const [token, pending] of pendingToolConfirmations) {
      if (pending.owner === ws) {
        try { pending.resolve(false); } catch {}
        pendingToolConfirmations.delete(token);
      }
    }
  });

   ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);
      await routeMessage(ws, parsed, sessionContext);
    } catch (err) {
      metrics.inc('ws.parse_error');
      console.error('WS error:', err);
      // The two sends below can themselves throw when the socket died mid-message — a throw
      // here inside the catch would surface as an unhandled rejection and the client would get
      // neither the error nor the end (audit 2026-08-06, Phase 2).
      try {
        ws.send(JSON.stringify({ type: 'error_output', data: `Error processing request: ${err.message}` }));
        ws.send(JSON.stringify({ type: 'end' }));
      } catch {}
    }
   });

   // Phase 3: the server's per-connection AI settings (aiEnabled/aiModel/aiMode — all reset to
   // their defaults at the top of this handler) were never pushed to the client on connect.
   // After a real drop/server-restart the client's toggle therefore showed AI ON while the
   // session was actually OFF, and the next message silently fell through to trigger mode —
   // the same "AI says it's on but responds like trigger mode" ghost-toggle class of bug the
   // intentionalClose guard was added for, just for genuine reconnects (audit 2026-08-06,
   // Phase 3). Push the fresh state so the toggle syncs honestly; the reconnect-reset of the
   // busy indicators lives client-side in useWebSocket's onOpen instead.
   if (ws.readyState === 1) sendAiStatus(ws, sessionContext);

   // Phase 5: the once-per-boot update banner — takeUpdateNotice returns the notice only on
   // its first call after a successful boot-time check that found a newer version, so at
   // most one connection ever receives it. Deliberately not persisted by the send interceptor
   // above (no session record for a UI banner).
   const updateNotice = takeUpdateNotice();
   if (updateNotice && ws.readyState === 1) {
     ws.send(JSON.stringify({ type: 'update_available', data: updateNotice }));
   }
}
