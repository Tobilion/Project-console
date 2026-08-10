import { state, pendingConfirmations, pendingToolConfirmations } from '../state.js';
import { stopTrackedProcess } from '../executor.js';
import { GATED_TOOLS, toolGrantKey } from '../tools.js';
import { generateSuggestions, applySuggestions } from '../learningEngine.js';
import { addToClaudeMd } from '../projectMemory.js';
import { handleBuiltinIntent } from './builtinIntents.js';
import { pendingMemorySuggestions } from './connectionState.js';
import { handleExecute } from './connectionExecute.js';
import { handleConfirmResponse } from './connectionConfirm.js';
import { handleToolCall } from './connectionToolCall.js';

/** WebSocket message dispatch — one case per message type, delegating to the leaf handlers. */
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
      // Cancel must also kill the turn's pending confirm cards, not just the in-flight fetch:
      // a tool-confirm promise left pending sits until the 5-minute sweep, and approving the
      // still-visible card after cancel would execute the gated tool on a turn the user thinks
      // is dead (audit 2026-08-06, Phase 2). Release them first so the AI loop gets a clean
      // rejection result before the abort below kills the next fetch.
      if (releasePendingTurnState(ws, sessionContext)) didSomething = true;
      if (sessionContext.aiAbortController) {
        try { sessionContext.aiAbortController.abort(); } catch {}
        didSomething = true;
        // Don't send answer/end here — handleAIQuery's own AbortError branch sends the
        // "Cancelled" answer and 'end' once the abort actually propagates through the in-flight
        // fetch, so the busy indicator clears via the normal flow instead of firing twice.
      }
      const cancelProjectId = sessionContext.activeProjectId;
      if (cancelProjectId) {
        // Phase 14 fix (reported directly): this used to be a raw child.kill('SIGTERM') with no
        // cleanup — the Processes dock and Dashboard stayed stale ("still running") until the
        // next poll because no processes_update/dashboard_update was broadcast and the map entry
        // was only cleared by the child's own 'close' (which on Windows can lag or never fire
        // when the killed child is npm's shell wrapper). stopTrackedProcess is the same single
        // kill+cleanup+broadcast path "stop server" and the dock Stop button use.
        const stopped = await stopTrackedProcess(cancelProjectId);
        if (stopped.ok) {
          didSomething = true;
          // executeCommand's own 'close' handler sends the final answer/end once the process
          // actually exits from the signal — same reasoning as the AI-abort branch above.
        }
      }
      if (!didSomething) {
        ws.send(JSON.stringify({ type: 'answer', data: 'Nothing is currently running to cancel.' }));
        ws.send(JSON.stringify({ type: 'end' }));
      }
      return;
    }
    case 'abort_ai': {
      // Chat/project switch (frontend handleAbortTurn): same turn-scoped cleanup as 'cancel'
      // above, but WITHOUT killing a running command or dev server — a user switching chats
      // must never tear down a dev server they started (audit 2026-08-06, Phase 3). Aborts an
      // in-flight AI query so the ghost turn stops streaming (and can't persist its answer into
      // whatever session becomes current) and releases its confirm cards. Deliberately silent:
      // this is a background action, not a user-facing Cancel click.
      releasePendingTurnState(ws, sessionContext);
      if (sessionContext.aiAbortController) {
        try { sessionContext.aiAbortController.abort(); } catch {}
      }
      return;
    }
    case 'stop_process': {
      // Phase 6 (PASS 6.2): Processes-dock stop button. Same single kill path as the "stop
      // server" trigger phrase (stopTrackedProcess) — no new kill logic.
      const stopProjectId = parsed.payload?.projectId || sessionContext.activeProjectId;
      const stopped = stopProjectId ? await stopTrackedProcess(stopProjectId) : { ok: false };
      if (stopped.ok) {
        const headsup = stopped.warning ? `\n\nHeads-up: ${stopped.warning}.` : '';
        ws.send(JSON.stringify({ type: 'answer', data: `Stopped \`${stopped.command}\`.${headsup}\n` }));
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
          data: `✓ Added ${added.length} new phrase(s) to ${[...new Set(added.map(a => a.intent))].join(', ')} intents. They're active now.`
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
        ws.send(JSON.stringify({ type: 'answer', data: `✓ Added "${topic}" section to CLAUDE.md.\n` }));
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

/**
 * Releases everything scoped to the current turn: this connection's pending confirm cards
 * (tool + trigger) and its pending param/follow-up/disambiguation question state. Shared by
 * 'cancel' and 'abort_ai' — both must kill the turn's card promises (a tool-confirm left
 * pending sits until the 5-minute sweep, and approving the still-visible card would execute
 * a gated tool on a turn the user thinks is dead) and its question state (the user's NEXT
 * unrelated message would otherwise be silently consumed as the stale question's answer).
 * Returns true if any confirmation was released, so 'cancel' can report whether it acted.
 */
function releasePendingTurnState(ws, sessionContext) {
  let releasedConfirmations = false;
  for (const [token, pending] of pendingToolConfirmations) {
    if (pending.owner === ws) {
      try { pending.resolve(false); } catch {}
      pendingToolConfirmations.delete(token);
      releasedConfirmations = true;
    }
  }
  for (const [token, pending] of pendingConfirmations) {
    if (pending.owner === ws) {
      pendingConfirmations.delete(token);
      releasedConfirmations = true;
    }
  }
  sessionContext.pendingParam = null;
  sessionContext.pendingFollowUp = null;
  sessionContext.pendingDisambiguation = null;
  return releasedConfirmations;
}

export { routeMessage, sendAiStatus };
