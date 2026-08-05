import { wss } from '../wsServer.js';
import { state, pendingToolConfirmations, sweepExpiredConfirmations } from '../state.js';
import { appendMessage } from '../conversationStore.js';
import { metrics } from '../metrics.js';
import { runningProcesses, stopTrackedProcess } from '../executor.js';
import { GATED_TOOLS, toolGrantKey } from '../tools.js';
import { generateSuggestions, applySuggestions } from '../learningEngine.js';
import { addToClaudeMd } from '../projectMemory.js';
import { handleBuiltinIntent } from './builtinIntents.js';
import { pendingMemorySuggestions } from './connectionState.js';
import { handleExecute } from './connectionExecute.js';
import { handleConfirmResponse } from './connectionConfirm.js';
import { handleToolCall } from './connectionToolCall.js';

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
          // treatment it had live in the output block.
          appendMessage(sessionContext.currentSessionId, { role: 'bot', content: commandOutputBuffer.trim(), isMarkdown: false }).catch(() => {});
        }
        commandOutputBuffer = '';
      } else if (sessionContext.currentSessionId && parsed.type === 'tool_start' && parsed.data) {
        // AI-mode tool trace ("Running: ..." / "Requesting approval ...") — previously never
        // persisted, so a reloaded AI session lost every tool line. Mirrors the live system
        // message formatting from useConsole.ts's tool_start case.
        appendMessage(sessionContext.currentSessionId, { role: 'system', content: `⚙️ ${parsed.data}` }).catch(() => {});
      } else if (sessionContext.currentSessionId && parsed.type === 'tool_result' && parsed.data && parsed.data.tool && !parsed.data.error) {
        const r = parsed.data.result;
        const resultStr = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
        appendMessage(sessionContext.currentSessionId, {
          role: 'system',
          content: `🔧 Tool: ${parsed.data.tool}\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? '…' : ''}`,
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

async function routeMessage(ws, parsed, sessionContext) {
  switch (parsed.type) {
    case 'execute':
      await handleExecute(ws, parsed, sessionContext);
      return;
    case 'confirm_response':
      await handleConfirmResponse(ws, parsed);
      return;
    case 'cancel': {
      // Requested directly (2026-07-29) after an AI query with no bound ran for 5+ minutes with
      // no way to interrupt it — CPU-only Ollama inference genuinely can take that long with no
      // GPU. Covers both an in-flight AI query (aborts the fetch via the AbortController stashed
      // on sessionContext by aiQuery.js) and a still-running trigger-mode shell command (killed
      // via the same runningProcesses map "stop server" already uses).
      let didSomething = false;
      if (sessionContext.aiAbortController) {
        try { sessionContext.aiAbortController.abort(); } catch {}
        didSomething = true;
        // Don't send answer/end here — handleAIQuery's own AbortError branch sends the
        // "Cancelled" answer and 'end' once the abort actually propagates through the in-flight
        // fetch, so the busy indicator clears via the normal flow instead of firing twice.
      }
      const cancelProjectId = sessionContext.activeProjectId;
      if (cancelProjectId) {
        const proc = runningProcesses.get(cancelProjectId);
        if (proc) {
          try { proc.child.kill('SIGTERM'); } catch {}
          didSomething = true;
          // executeCommand's own 'close' handler sends the final answer/end once the process
          // actually exits from the signal — same reasoning as above.
        }
      }
      if (!didSomething) {
        ws.send(JSON.stringify({ type: 'answer', data: 'Nothing is currently running to cancel.' }));
        ws.send(JSON.stringify({ type: 'end' }));
      }
      return;
    }
    case 'stop_process': {
      // Phase 6 (PASS 6.2): Processes-dock stop button. Same single kill path as the "stop
      // server" trigger phrase (stopTrackedProcess) — no new kill logic.
      const stopProjectId = parsed.payload?.projectId || sessionContext.activeProjectId;
      const stopped = stopProjectId ? stopTrackedProcess(stopProjectId) : { ok: false };
      if (stopped.ok) {
        ws.send(JSON.stringify({ type: 'answer', data: `Stopped \`${stopped.command}\`.\n` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: 'No running process for that project.' }));
      }
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    case 'did_you_mean_pick': {
      // Requested directly (2026-08-04): click on a non-blocking "did you mean" chip. If a
      // blocking disambiguation question happens to be pending (collision question from the
      // same feature family), resolve it with this pick; otherwise dispatch the picked intent
      // directly through the exact same path a typed "1"/"2" reply uses.
      const pick = parsed.payload?.intent;
      if (!pick || typeof pick !== 'string') return;
      const project = sessionContext.activeProjectId
        ? state.activeProjectsCache.find((p) => p.id === sessionContext.activeProjectId)
        : null;
      if (sessionContext.pendingDisambiguation && sessionContext.pendingDisambiguation.projectId === sessionContext.activeProjectId) {
        const pending = sessionContext.pendingDisambiguation;
        sessionContext.pendingDisambiguation = null;
        if (pending.candidates.includes(pick)) {
          await handleBuiltinIntent(ws, pick, pending.originalInput, project, sessionContext);
          ws.send(JSON.stringify({ type: 'end' }));
        }
        return;
      }
      await handleBuiltinIntent(ws, pick, '', project, sessionContext);
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    case 'tool_call':
    case 'execute_tool':
      await handleToolCall(ws, parsed, sessionContext);
      return;
    case 'approve_task': {
      // Phase 5 (PASS 5.1): one-click "Approve this task" from the confirm card. Resolves the
      // currently-pending tool confirmation by token (exactly like an Approve click) AND
      // pre-grants every non-risky gated tool for this session+project so the rest of the
      // current task's file edits run without further prompts. Deliberately does NOT grant
      // executeCommand or the ALWAYS_CONFIRM_TOOLS (runTests/stopProcess) — risky shell
      // commands and command-execution tools still ask every single time, that invariant is
      // enforced in resolveToolGate, not just by what this case grants.
      const { token, projectId } = parsed.payload || {};
      const pid = projectId || sessionContext.activeProjectId;
      const project = pid ? state.activeProjectsCache.find((p) => p.id === pid) : null;
      if (project?.path) {
        for (const name of GATED_TOOLS) {
          sessionContext.toolGrants.add(toolGrantKey(project.path, name));
        }
      }
      if (token && pendingToolConfirmations.has(token)) {
        const pending = pendingToolConfirmations.get(token);
        pendingToolConfirmations.delete(token);
        pending.resolve(true);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: 'Approved — future file edits in this conversation will run without asking (commands and tests still get their own confirm).' }));
      }
      ws.send(JSON.stringify({ type: 'task_granted', data: { projectId: pid } }));
      return;
    }
    case 'ai_toggle': {
      const { enabled } = parsed.payload || {};
      sessionContext.aiEnabled = !!enabled;
      sendAiStatus(ws, sessionContext);
      return;
    }
    case 'ai_set_model': {
      const { model, mode } = parsed.payload || {};
      if (model) sessionContext.aiModel = model;
      if (mode) sessionContext.aiMode = mode;
      sendAiStatus(ws, sessionContext);
      return;
    }
    case 'workspace_set': {
      const { projectIds, activeProjectId } = parsed.payload || {};
      if (Array.isArray(projectIds)) {
        sessionContext.workspaceProjectIds = projectIds;
      }
      if (activeProjectId) {
        sessionContext.activeProjectId = activeProjectId;
      }
      ws.send(JSON.stringify({ type: 'workspace_updated', data: { projectIds: sessionContext.workspaceProjectIds, activeProjectId: sessionContext.activeProjectId } }));
      return;
    }
    case 'learning_review': {
      const projectId = sessionContext.activeProjectId;
      if (!projectId) {
        ws.send(JSON.stringify({ type: 'error_output', data: 'No active project for learning review.\n' }));
        return;
      }
      const suggestions = generateSuggestions(projectId);
      ws.send(JSON.stringify({ type: 'learning_suggestion', data: { projectId, suggestions } }));
      return;
    }
    case 'learning_approve': {
      const { suggestionIds } = parsed.payload || {};
      const projectId = sessionContext.activeProjectId;
      if (!projectId || !suggestionIds?.length) {
        ws.send(JSON.stringify({ type: 'answer', data: 'No suggestions to approve.' }));
        return;
      }
      const added = applySuggestions(suggestionIds, projectId);
      if (added.length > 0) {
        ws.send(JSON.stringify({
          type: 'answer',
          data: `✅ Added ${added.length} new phrase(s) to ${[...new Set(added.map(a => a.intent))].join(', ')} intents. They're active now.`
        }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: 'No new phrases to add (all were already known).' }));
      }
      return;
    }
    case 'memory_suggestion_respond': {
      const { accept } = parsed.payload || {};
      const projectId = sessionContext.activeProjectId;
      if (!projectId) {
        ws.send(JSON.stringify({ type: 'error_output', data: 'No active project.\n' }));
        return;
      }
      const project = state.activeProjectsCache.find(p => p.id === projectId);
      if (!project) {
        ws.send(JSON.stringify({ type: 'error_output', data: 'Project not found.\n' }));
        return;
      }
      const suggestion = pendingMemorySuggestions.get(projectId);
      if (!suggestion) {
        ws.send(JSON.stringify({ type: 'answer', data: 'No pending memory suggestion.\n' }));
        return;
      }
      pendingMemorySuggestions.delete(projectId);
      if (accept) {
        const { topic, content } = suggestion;
        addToClaudeMd(project.path, topic, content || '');
        ws.send(JSON.stringify({ type: 'answer', data: `✅ Added "${topic}" section to CLAUDE.md.\n` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `Skipped adding "${suggestion.topic}" to CLAUDE.md.\n` }));
      }
      return;
    }
    default:
      return;
  }
}

function sendAiStatus(ws, sessionContext) {
  ws.send(JSON.stringify({
    type: 'ai_status',
    data: {
      enabled: sessionContext.aiEnabled,
      model: sessionContext.aiModel || 'qwen2.5-coder:7b',
      mode: sessionContext.aiMode
    }
  }));
}
