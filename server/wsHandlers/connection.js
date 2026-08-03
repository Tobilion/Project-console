import crypto from 'crypto';
import { matchInput, describeIntent, getFallbackSuggestions } from '../matcher.js';
import { resolveContext } from '../contextResolver.js';
import { injectContext } from '../contextInjector.js';
import { appendMessage, getSession } from '../conversationStore.js';
import { executeCommand } from '../executor.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { createCheckpoint } from '../gitSafety.js';
import { createProjectTools, isGatedToolCall, isCommandAllowed, isCustomToolRisky } from '../tools.js';
import { metrics } from '../metrics.js';
import { runningProcesses } from '../executor.js';
import { handleBuiltinIntent } from './builtinIntents.js';
import { handleMatchedEntry, runCommandEntry } from './matchedEntry.js';
import { extractParamValue, isSafeParamValue, substituteParams } from '../paramCommand.js';
import { handleAIQuery } from './aiQuery.js';
import { guessCommand } from '../commandGuesser.js';
import { logNearMiss, updateNearMiss } from '../nearMissLogger.js';
import { generateSuggestions, applySuggestions } from '../learningEngine.js';
import { logMatch, getIntentStats, suggestThresholds, getThresholdOverrides, setThresholdOverride, removeThresholdOverride, clearTelemetry, updateTelemetryEntry, autoApplyThresholds, autoApplyThresholdsForAll } from '../intentTelemetry.js';
import { retrainConfidenceModel, getModelInfo } from '../confidenceModel.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { readDistillations, generateDistillationSuggestions, applyDistillation, clearDistillations } from '../distillation.js';
import { trackCommand, trackFileEdit, trackQuestion, addCandidateAddition, getMemorySummary, addToClaudeMd } from '../projectMemory.js';
import { state, pendingConfirmations, pendingToolConfirmations, sweepExpiredConfirmations, withPortCollisionWarning } from '../state.js';
import { wss, broadcast } from '../wsServer.js';

const pendingMemorySuggestions = new Map();

// "Where is the link / what is the url" pre-check patterns (hoisted + exported so the harness can
// assert the exact same truth the server uses — keep them in sync with any future edit here).
// Confirmed live 2026-08-03: "what is the dev url" used to slip past the old `(link|url|address)`
// immediacy (an in-between word like "dev" broke the match) and fell through to the NLP stage,
// which misrouted it to project.knowledge.stack. Both patterns now allow an optional determiner
// plus up to two in-between words ("what is the dev url", "what is the dev server link"), while
// the git-context guard below keeps git-remote questions ("what is the git remote url", "where is
// the github link") from ever being answered with a dev-server URL.
export const DEV_URL_WHERE_RE = /where\s+(is|can I find|do I go|did it go)\s+(?:(?:the|a|my|our|their|this)\s+)?(?:[\w.]+\s+){0,2}(link|url|site|server|page)/i;
export const DEV_URL_WHAT_RE = /\bwhat('s| is)\s+(?:(?:the|a|my|our|their|this)\s+)?(?:[\w.]+\s+){0,2}(link|url|address)\b/i;
export const DEV_URL_BARE_RE = /^(link|url)\??$/i;
const DEV_URL_GIT_CONTEXT_RE = /\b(git|github|gitlab|remote|repo|repository|branch|origin|merge|commit|push|pull|checkout|clone)\b/i;

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
      if (sessionContext.currentSessionId && (parsed.type === 'answer' || parsed.type === 'error_output') && parsed.data) {
        appendMessage(sessionContext.currentSessionId, {
          role: parsed.type === 'error_output' ? 'error' : 'bot',
          content: typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data)
        }).catch(() => {});
      } else if (sessionContext.currentSessionId && (parsed.type === 'start' || parsed.type === 'output') && parsed.data) {
        commandOutputBuffer += parsed.data;
      } else if (sessionContext.currentSessionId && parsed.type === 'end') {
        if (parsed.data) commandOutputBuffer += parsed.data;
        if (commandOutputBuffer.trim()) {
          appendMessage(sessionContext.currentSessionId, { role: 'bot', content: commandOutputBuffer.trim() }).catch(() => {});
        }
        commandOutputBuffer = '';
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
    case 'tool_call':
    case 'execute_tool':
      await handleToolCall(ws, parsed, sessionContext);
      return;
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

async function handleExecute(ws, parsed, sessionContext) {
  const { projectId, input, sessionId } = parsed.payload;
  sessionContext.activeProjectId = projectId;
  if (sessionId) sessionContext.currentSessionId = sessionId;

  const project = state.activeProjectsCache.find((p) => p.id === projectId);
  if (!project) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Project not found. Scan directory again.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Validate session is linked to this project (prevent cross-project context confusion)
  if (sessionId) {
    try {
      const session = await getSession(sessionId);
      if (session && session.projectId && session.projectId !== projectId) {
        ws.send(JSON.stringify({
          type: 'error_output',
          data: `Session is locked to "${session.projectName || session.projectId}" — switch to that project or create a new chat for this one.\n`,
          // Structured form of the same fact, so the web UI can offer a one-click "Switch to
          // that project" action instead of only showing the plain-text message above (which is
          // all a bare CLI client can render).
          switchProjectAction: { projectId: session.projectId, projectName: session.projectName || session.projectId },
        }));
        ws.send(JSON.stringify({ type: 'end' }));
        return;
      }
    } catch {}
  }

  if (sessionContext.currentSessionId) {
    appendMessage(sessionContext.currentSessionId, { role: 'user', content: input }).catch(() => {});
  }

  // A parameterized command entry (see paramCommand.js / matchedEntry.js) is waiting on a plain
  // follow-up answer for this project — e.g. it asked "what interval?" and this message is the
  // reply. Must be checked before anything else touches `input`, since this message was never
  // meant to be re-matched against the normal intent pipeline. No AI involved: this is what lets
  // parameterized trigger-mode commands work with AI mode off.
  if (sessionContext.pendingParam && sessionContext.pendingParam.projectId === projectId) {
    const pending = sessionContext.pendingParam;
    const lower = input.trim().toLowerCase();
    if (lower === 'cancel' || lower === 'nevermind' || lower === 'never mind') {
      sessionContext.pendingParam = null;
      ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled.\n' }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    const param = pending.params.find((p) => p.name === pending.paramName);
    let extracted = extractParamValue(input, param?.pattern, { anchored: true });
    // Confirmed live 2026-07-29: this fallback used to accept ANY safe-looking text whenever
    // the pattern match failed — including when a pattern WAS defined and the reply just didn't
    // match it (e.g. asked "what interval?", user typed an unrelated new message instead of a
    // number). That silently substituted the wrong text into the command template — a real
    // NetPulse run produced "python main.py watch --interval run the network speed" and crashed
    // with an argparse error. The raw-text fallback should only apply when the entry never
    // defined a pattern at all (nothing to validate against); if a pattern exists and doesn't
    // match, that's a genuinely invalid answer and the user should be asked again.
    if (!extracted && !param?.pattern && isSafeParamValue(input.trim())) extracted = input.trim();
    if (!extracted || !isSafeParamValue(extracted)) {
      ws.send(JSON.stringify({ type: 'answer', data: `That doesn't look like a valid value. ${param?.prompt || 'Please try again.'} (or say "cancel" to drop this)\n` }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    pending.values[pending.paramName] = extracted;
    const nextMissing = pending.params.find((p) => pending.values[p.name] === undefined);
    if (nextMissing) {
      pending.paramName = nextMissing.name;
      ws.send(JSON.stringify({ type: 'answer', data: nextMissing.prompt }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    sessionContext.pendingParam = null;
    const resolvedEntry = { ...pending.entry, action: substituteParams(pending.entry.action, pending.values) };
    await runCommandEntry(ws, resolvedEntry, input, pending.matchedTrigger, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // A command entry that declared `followUp` (see matchedEntry.js) is waiting on a plain reply
  // for this project — e.g. "start netpulse" asked "also watch the network? reply with an
  // interval". A number starts the follow-up entry with that value substituted; "no" runs just
  // the original entry; "cancel" aborts nothing having started. Same interception point and
  // reason as pendingParam: this reply was never meant to be re-matched against the pipeline.
  if (sessionContext.pendingFollowUp && sessionContext.pendingFollowUp.projectId === projectId) {
    const pending = sessionContext.pendingFollowUp;
    const lower = input.trim().toLowerCase();
    if (/^(cancel|nevermind|never mind)\b/.test(lower)) {
      sessionContext.pendingFollowUp = null;
      ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled — nothing was started.\n' }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    if (/^(no|nope|nah|not now|skip (?:it|the watch))\b/.test(lower)) {
      sessionContext.pendingFollowUp = null;
      await runCommandEntry(ws, pending.entry, input, pending.followUp.entry, project, sessionContext);
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    const param = pending.target.params.find((p) => p.name === pending.followUp.param);
    const extracted = extractParamValue(input, param?.pattern, { anchored: true });
    if (!extracted || !isSafeParamValue(extracted)) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `That doesn't look like a valid ${param?.name || 'value'} — try again (e.g. 15), "no" to skip it, or "cancel" to stop.\n`,
      }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    sessionContext.pendingFollowUp = null;
    const resolvedWatch = { ...pending.target, action: substituteParams(pending.target.action, { [pending.followUp.param]: extracted }) };
    await runCommandEntry(ws, pending.entry, input, pending.followUp.entry, project, sessionContext);
    await runCommandEntry(ws, resolvedWatch, input, pending.followUp.entry, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Requested directly (2026-07-30): when matcher.js hits a genuine collision (two different
  // intents scoring nearly identically — see semanticMatcher.js's `collision` field), it asks
  // "did you mean X or Y?" instead of silently guessing. This is the reply to that question —
  // checked before the normal matching pipeline for the same reason pendingParam is above.
  if (sessionContext.pendingDisambiguation && sessionContext.pendingDisambiguation.projectId === projectId) {
    const pending = sessionContext.pendingDisambiguation;
    sessionContext.pendingDisambiguation = null;
    const lower = input.trim().toLowerCase();
    const REJECT_RE = /^(no|nope|neither|none|none of (those|these|the above)|not (that|those|it)|thats wrong|that'?s wrong|wrong|cancel|nevermind|never mind)\b/;
    if (REJECT_RE.test(lower)) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `No problem — here are some other things I can try:\n_Suggestions: ${getFallbackSuggestions(input).join(', ')}_\n`,
      }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    let chosen = null;
    if (/^(1|one|first|the first|a)\b/.test(lower)) chosen = pending.candidates[0];
    else if (/^(2|two|second|the second|b)\b/.test(lower)) chosen = pending.candidates[1];
    if (chosen) {
      await handleBuiltinIntent(ws, chosen, pending.originalInput, project, sessionContext);
      if (chosen !== 'system.chit_chat.git_status') {
        ws.send(JSON.stringify({ type: 'end' }));
      }
      return;
    }
    // Anything else (not a clear pick, not a clear rejection) — the user probably just moved on
    // to a new, unrelated message rather than answering the question at all. Backtracking here
    // means treating it as a brand-new input through the normal pipeline rather than getting
    // stuck insisting on an answer to a question nobody's addressing anymore.
  }

  // Confirmed live 2026-08-03 (NetPulse transcript, reported directly): typing a literal,
  // already-correct command (e.g. "python main.py serve") did NOT run it — it went through the
  // normal intent-matching pipeline like any other chat message, and since it happened to name a
  // real file in the project, it lost to `project.context.file_relations` ("who uses main.py")
  // instead of executing. The ONLY way to actually run a suggested command was to click its
  // auto-generated suggestion chip, which takes a completely different path client-side
  // (`onDirectCommand` in Terminal.tsx, sent as an `execute_tool`/`executeCommand` WS message —
  // see `handleToolCall` below) that bypasses the matcher entirely. Typed input had no equivalent.
  // Fixed by giving typed input the same bypass: if the whole message is already a well-formed,
  // allowlisted command (`isCommandAllowed` — the same `ALLOWED_COMMANDS` check the chip path
  // uses) and isn't blocked by `isCommandBlocked`'s dangerous-pattern check, run it directly
  // instead of feeding it to the matcher at all. No new attack surface: this is the exact same
  // allowlist + blocklist gate `handleToolCall`'s `executeCommand` tool already enforces on every
  // chip click, just reachable from a typed message too. Deliberately does NOT try to be clever
  // about partial/fuzzy command text ("run python main.py serve please") — only an exact,
  // already-correct command line is auto-run; anything else still goes through the normal
  // pipeline so "run the site" etc. keep working as intents.
  const trimmedInput = input.trim();
  if (isCommandAllowed(trimmedInput) && !isCommandBlocked(trimmedInput)) {
    executeCommand(trimmedInput, project.path, ws, project.id);
    return;
  }

  // Telemetry commands
  const lowerInput = input.trim().toLowerCase();
  if (lowerInput === 'telemetry review' || lowerInput === 'check telemetry' || lowerInput === 'telemetry stats') {
    const stats = getIntentStats(project.id);
    if (stats.size === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No telemetry data collected yet. Start using the console to gather matching data.\n' }));
    } else {
      let reply = `**Intent Telemetry for ${project.name}**\n\n`;
      const sorted = [...stats.entries()].sort((a, b) => b[1].matches - a[1].matches);
      for (const [intent, s] of sorted.slice(0, 15)) {
        const stagesStr = Object.entries(s.stages).map(([k, v]) => `${k}:${v}`).join(' ');
        reply += `**${intent}** — ${s.matches} matches, avg ${s.avgConfidence.toFixed(2)}, fp ${(s.falsePositiveRate * 100).toFixed(0)}%\n`;
        reply += `  stages: ${stagesStr}  range: ${s.minConfidence.toFixed(2)}–${s.maxConfidence.toFixed(2)}\n`;
      }
      const modelInfo = getModelInfo();
      reply += modelInfo.trained
        ? `\n**Learned confidence model**: active — trained on ${modelInfo.sampleCount} real accept/reject outcomes, last updated ${new Date(modelInfo.trainedAt).toLocaleString()}. Threshold suggestions below now come from this model instead of the fixed heuristic.\n`
        : `\n**Learned confidence model**: not trained yet — needs ${modelInfo.minRequired}+ real accept/reject outcomes (currently uses the fixed heuristic for suggestions).\n`;
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput === 'telemetry thresholds' || lowerInput === 'list thresholds') {
    const overrides = getThresholdOverrides();
    const active = Object.keys(overrides);
    let reply = active.length
      ? `**Active threshold overrides:**\n${active.map(i => `  ${i}: ${overrides[i].toFixed(2)}`).join('\n')}\n`
      : 'No threshold overrides. All intents use the default 0.6.\n';
    ws.send(JSON.stringify({ type: 'answer', data: reply }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput.startsWith('telemetry suggest') || lowerInput.startsWith('suggest thresholds')) {
    const suggestions = suggestThresholds(project.id);
    if (suggestions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'Not enough telemetry data for threshold suggestions. Need 5+ matches per intent.\n' }));
    } else {
      let reply = `**Threshold adjustment suggestions for ${project.name}**\n`;
      for (const s of suggestions) {
        reply += `\n**${s.intent}**: ${s.currentFloor.toFixed(2)} → ${s.recommendedFloor.toFixed(2)}\n`;
        reply += `  ${s.reason}\n`;
        reply += `  ${s.matchCount} matches, avg ${s.avgConfidence.toFixed(3)}, semantic ${s.semanticRatio} fuzzy ${s.fuzzyRatio} keyword ${s.keywordRatio}\n`;
        reply += `  Apply: \`threshold set ${s.intent} ${s.recommendedFloor}\`\n`;
      }
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput.startsWith('threshold set ')) {
    const rest = lowerInput.replace('threshold set ', '');
    const match = rest.match(/^(.+?)\s+([\d.]+)$/);
    if (match) {
      const intent = match[1].trim();
      const floor = parseFloat(match[2]);
      if (floor >= 0 && floor <= 1) {
        setThresholdOverride(intent, floor);
        ws.send(JSON.stringify({ type: 'answer', data: `Set threshold for **${intent}** to ${floor.toFixed(2)}.\n` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: 'Threshold must be between 0 and 1.\n' }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: 'Usage: threshold set <intent> <floor>\nExample: threshold set git_push 0.5\n' }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput.startsWith('threshold remove ') || lowerInput.startsWith('threshold reset ')) {
    const intent = lowerInput.replace(/threshold (remove|reset) /, '').trim();
    if (intent) {
      removeThresholdOverride(intent);
      ws.send(JSON.stringify({ type: 'answer', data: `Reset **${intent}** to default threshold (0.6).\n` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput === 'telemetry auto-apply' || lowerInput === 'auto apply thresholds') {
    const result = autoApplyThresholds(project.id);
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Auto-applied ${result.applied} threshold adjustment(s) (${result.total} suggestions evaluated).\nUse \`list thresholds\` to see active overrides.\n`
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput === 'telemetry auto-apply all' || lowerInput === 'auto apply all') {
    const results = autoApplyThresholdsForAll();
    if (results.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No threshold adjustments applied — insufficient telemetry data.\n' }));
    } else {
      let reply = '**Auto-applied thresholds across all projects:**\n';
      for (const r of results) {
        reply += `  ${r.projectId}: ${r.applied} adjustment(s)\n`;
      }
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput === 'check collisions' || lowerInput === 'intent collisions') {
    const collisions = semanticMatcher.findIntentCollisions();
    if (collisions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No intent collisions detected (threshold: 0.9).\n' }));
    } else {
      let reply = '**Intent embedding collisions (cosine similarity ≥ 0.9):**\n\n';
      for (const c of collisions) {
        reply += `**${c.intentA}** ↔ **${c.intentB}**  (${(c.similarity * 100).toFixed(1)}%)\n`;
      }
      reply += '\nThese intents have very similar embedding profiles. Consider distinguishing their example phrases or merging them.\n';
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput === 'telemetry clear' || lowerInput === 'clear telemetry') {
    clearTelemetry(project.id);
    ws.send(JSON.stringify({ type: 'answer', data: `Cleared telemetry data for ${project.name}.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Distillation commands — review and apply AI-derived trigger-mode suggestions
  if (lowerInput === 'review distillations' || lowerInput === 'distillation review' || lowerInput === 'check distillations') {
    const suggestions = generateDistillationSuggestions(project.id);
    if (suggestions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No pending AI distillations. Use AI mode to run commands and generate suggestions.\n' }));
    } else {
      let reply = `**AI Distillations for ${project.name}**\n\n`;
      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        reply += `**${i + 1}.** ${s.type === 'command_entry' ? '⚡' : s.type === 'knowledge_entry' ? '📖' : '📁'} `;
        reply += `[${s.confidence}] ${s.description}\n`;
        if (s.trigger) reply += `   Trigger: \`${s.trigger}\`\n`;
        if (s.action) reply += `   Action: \`${s.action}\`\n`;
        if (s.occurrences > 1) reply += `   Occurrences: ${s.occurrences}\n`;
      }
      reply += '\nApply with: `apply distillation <number>` or `apply all distillations`\n';
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput.startsWith('apply distillation ') || lowerInput.startsWith('apply distillations ')) {
    const parts = lowerInput.replace(/^apply distillations? /, '').trim();
    const suggestions = generateDistillationSuggestions(project.id);
    let ids;
    if (parts === 'all') {
      ids = suggestions.map(s => s.id);
    } else {
      const indices = parts.split(/\s+/).map(p => parseInt(p, 10) - 1).filter(n => !isNaN(n) && n >= 0);
      ids = indices.map(i => suggestions[i]?.id).filter(Boolean);
    }
    if (!ids.length) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No valid distillation suggestions to apply.\n' }));
    } else {
      const added = applyDistillation(project.id, ids, state.activeProjectsCache);
      if (added.length > 0) {
        const types = [...new Set(added.map(a => a.type === 'command_entry' ? 'commands' : 'knowledge entries'))];
        ws.send(JSON.stringify({
          type: 'answer',
          data: `✅ Applied ${added.length} distillation(s) to ${project.name}'s console.config.json as ${types.join(', ')}.\nThe file watcher will reload them automatically.\n`
        }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: 'No new distillations to apply (entries already exist or nothing to add).\n' }));
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput === 'clear distillations' || lowerInput === 'distillation clear') {
    clearDistillations(project.id);
    ws.send(JSON.stringify({ type: 'answer', data: `Cleared distillation records for ${project.name}.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Memory / adaptive context commands
  if (lowerInput === 'review memory' || lowerInput === 'memory review' || lowerInput === 'project memory') {
    const summary = getMemorySummary(project.path);
    let reply = `**Project Memory for ${project.name}**\n\n`;
    if (summary.topCommands.length > 0) {
      reply += `**Top commands:**\n${summary.topCommands.map((c, i) => `  ${i + 1}. \`${c.command}\` (${c.count}x)`).join('\n')}\n\n`;
    }
    if (summary.topEditedFiles.length > 0) {
      reply += `**Top edited files:**\n${summary.topEditedFiles.map((f, i) => `  ${i + 1}. \`${f.file}\` (${f.count}x)`).join('\n')}\n\n`;
    }
    if (summary.repeatedQuestions.length > 0) {
      reply += `**Repeated questions:**\n${summary.repeatedQuestions.map((q, i) => `  ${i + 1}. "${q.topic}" (${q.count}x${q.suggested ? ', already suggested' : ''})`).join('\n')}\n\n`;
    }
    reply += `Candidate additions pending: ${summary.candidateAdditions}\n`;
    reply += `Last updated: ${new Date(summary.lastUpdated).toLocaleDateString()}\n`;
    ws.send(JSON.stringify({ type: 'answer', data: reply }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // "stop server" / "kill server" — stop a running dev server. Also catches a bare "stop it" /
  // "kill it" / "cancel it" (confirmed live 2026-07-30: "Stop it" typed right after a dev server
  // was confirmed still running instead matched system.chit_chat.yes_no — 'stop' is a legitimate
  // yes/no-reject example phrase there too — and returned a confusing "No pending confirmation"
  // reply) but ONLY when a process is actually tracked for this project; a pronoun-only "stop it"
  // with nothing running is ambiguous enough that falling through to the normal yes/no fallback
  // is the safer default.
  const hasTrackedProcess = runningProcesses.has(project.id);
  if (
    /^(stop|kill|shutdown|end)\s+(the\s+)?(server|process|dev)/i.test(lowerInput) ||
    (hasTrackedProcess && /^(stop|kill|cancel)\s+it\.?$/i.test(lowerInput.trim()))
  ) {
    const proc = runningProcesses.get(project.id);
    if (proc) {
      proc.child.kill('SIGTERM');
      runningProcesses.delete(project.id);
      state.lastDevUrls.delete(project.id);
      broadcast({ type: 'dashboard_update' });
      ws.send(JSON.stringify({ type: 'answer', data: `Stopped \`${proc.command}\`.\n` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `No running server for **${project.name}**.\n` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // "Where is the link?" — answer from the last detected dev server URL. Wide enough to catch
  // "what is the dev url" / "where is the dev server" (confirmed misroute, fixed 2026-08-03),
  // but never a git-remote question (gated by DEV_URL_GIT_CONTEXT_RE below — "what is the git
  // remote url" should go to git_remote_info instead of being answered as the dev server).
  if ((DEV_URL_WHERE_RE.test(lowerInput) || DEV_URL_WHAT_RE.test(lowerInput) || DEV_URL_BARE_RE.test(lowerInput.trim()))
    && !DEV_URL_GIT_CONTEXT_RE.test(lowerInput)) {
    const devUrl = state.lastDevUrls.get(project.id);
    if (devUrl) {
      const answer = withPortCollisionWarning(`The dev server is running at **${devUrl}** — open it in your browser.`, devUrl);
      ws.send(JSON.stringify({ type: 'answer', data: answer }));
    } else {
      const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
      let scripts = {};
      if (pkgJson) { try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {} }
      const hasDev = scripts.dev || scripts.start || scripts.serve;
      if (hasDev) {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** has a dev script configured but I haven't detected a running server yet. Try saying "run the site" to start it.` }));
      } else {
        const langs = project.codebaseIndex?.languages || [];
        // Same bug as builtinIntents.js's projectTypeSuggestions() — codebaseIndex.languages
        // entries are always "Python (N files)", never the bare name, so `.includes('Python')`
        // could never match. Fixed alongside it (2026-07-29).
        if (langs.some((l) => l.startsWith('Python'))) {
          ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** appears to be a Python project — it doesn't run a local web server in the traditional sense. Try "overview" to learn more.` }));
        } else if (project.codebaseIndex?.entryPoints?.some(e => e.endsWith('index.html'))) {
          ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** is a static HTML project. Open the HTML file directly in your browser, or say "run the site" for instructions.` }));
        } else {
          ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** doesn't have a dev server running. Try turning AI mode ON and asking "how do I run this project?"` }));
        }
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Check if the user is responding to a pending memory suggestion (saying yes/sure/ok)
  const pendingMemSuggestion = pendingMemorySuggestions.get(project.id);
  if (pendingMemSuggestion && /^(yes|sure|ok|yeah|yep|add it|go ahead|please|do it)/i.test(lowerInput)) {
    pendingMemorySuggestions.delete(project.id);
    const { topic, content } = pendingMemSuggestion;
    addToClaudeMd(project.path, topic, content || '');
    ws.send(JSON.stringify({ type: 'answer', data: `✅ Added "${topic}" section to CLAUDE.md. I'll remember this context in future conversations.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (pendingMemSuggestion && /^(no|nope|nah|skip|not now|cancel|dont|don't)/i.test(lowerInput)) {
    pendingMemorySuggestions.delete(project.id);
    ws.send(JSON.stringify({ type: 'answer', data: `OK, won't add "${pendingMemSuggestion.topic}" to CLAUDE.md.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Special learning commands — intercept before the matching pipeline
  if (lowerInput === 'review learning' || lowerInput === 'check learning' || lowerInput === 'learning review') {
    const suggestions = generateSuggestions(project.id);
    ws.send(JSON.stringify({
      type: 'learning_suggestion',
      data: { projectId: project.id, suggestions }
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (lowerInput.startsWith('approve suggestions')) {
    const parts = lowerInput.split(/\s+/).slice(2);
    let suggestionIds;
    if (parts.length === 0) {
      // Approve all — regenerate suggestions and approve all IDs
      const suggestions = generateSuggestions(project.id);
      suggestionIds = suggestions.map(s => s.id);
    } else {
      // Approve specific ones by index
      const suggestions = generateSuggestions(project.id);
      suggestionIds = parts.map(p => {
        const idx = parseInt(p, 10) - 1;
        return suggestions[idx]?.id;
      }).filter(Boolean);
    }
    if (!suggestionIds.length) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No suggestions to approve.' }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    const added = applySuggestions(suggestionIds, project.id);
    if (added.length > 0) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `✅ Added ${added.length} new phrase(s) to ${[...new Set(added.map(a => a.intent))].join(', ')} intents. They're active now.`
      }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: 'No new phrases to add (all were already known).' }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // AI mode: the AI ON/OFF toggle is the only opt-in gesture needed — once on, every
  // message in this session goes straight to Ollama, no per-query re-confirmation.
  if (sessionContext.aiEnabled) {
    // Resolve workspace projects for AI context
    const workspaceProjects = sessionContext.workspaceProjectIds
      .map(id => state.activeProjectsCache.find(p => p.id === id))
      .filter(Boolean);
    await handleAIQuery(ws, project, input, sessionContext, workspaceProjects);
    return;
  }

  // Direct commands: if the input looks like a shell command, skip the matching pipeline
  // and go straight to the guesser. This prevents suggestion-chip commands like "npx serve ."
  // from being re-matched as run_project (because "serve" is semantically close to "server").
  const directCmdPattern = /^(npx\s+\S+(?:\s+\S+)*|python3?\s+\S+(?:\s+\S+)*|pip3?\s+\S+(?:\s+\S+)*|yarn\s+\S+(?:\s+\S+)*|pnpm\s+\S+(?:\s+\S+)*|npm\s+(run|start|install|build|serve|test|dev)(?:\s+\S+)*|node\s+\S+(?:\s+\S+)*|tsx\s+\S+)$/i;
  if (directCmdPattern.test(input)) {
    const guessed = guessCommand(input);
    if (guessed) {
      const nearMissId = logNearMiss(project.id, {
        input, resolvedCommand: guessed.command, description: guessed.description, source: 'guess',
      });
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id, command: guessed.command, trigger: input,
        createdAt: Date.now(), nearMissId,
      });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${guessed.command}  (${guessed.description})`, trigger: 'direct_command' }));
      return;
    }
  }

  const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === projectId);
  // Router tier (matcher.js stage 4) reuses whatever model the user has selected for full AI
  // mode, if any — it works independently of the aiEnabled toggle (that flag only gates the
  // multi-turn tool-call loop in aiQuery.js) and falls back to its own default model if unset.
  const matchResult = await matchInput(input, project, projectIndex, { model: sessionContext.aiModel });

  // A genuine collision (matcher.js/semanticMatcher.js — two different intents scoring nearly
  // identically) — ask which one was meant instead of guessing. See the pendingDisambiguation
  // reply handler above for how the answer is consumed.
  if (matchResult.disambiguate) {
    const [a, b] = matchResult.disambiguate;
    sessionContext.pendingDisambiguation = { projectId, candidates: [a, b], originalInput: input };
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Not sure which you meant:\n1. ${describeIntent(a)}\n2. ${describeIntent(b)}\n\nReply with "1" or "2" — or say "neither" if it's something else.\n`,
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  if (matchResult.routedByModel) {
    // Observability parity with the 'guess'/'fallback' near-miss sources already logged below —
    // lets `review learning` surface phrasings the fast pipeline is missing so they can be
    // promoted into real examples later, same as any other near-miss.
    logNearMiss(project.id, {
      input,
      resolvedCommand: null,
      description: `router -> ${matchResult.builtin} (${matchResult.routerConfidence})`,
      source: 'router',
      intentSuggestion: matchResult.builtin,
      telemetryEntryId: matchResult.telemetryId || undefined,
    });
  }

  const isMatched = !!(matchResult.multi || matchResult.builtin || matchResult.match);
  sessionContext.conversationHistory.push({
    input,
    matched: isMatched,
    intent: matchResult.builtin || null,
    entry: matchResult.match || null,
    projectId,
  });
  if (sessionContext.conversationHistory.length > 5) {
    sessionContext.conversationHistory.shift();
  }

  // 0. Multi-intent queries (e.g. "show structure and run tests")
  if (matchResult.multi) {
    for (const item of matchResult.multi) {
      if (item.builtin) {
        await handleBuiltinIntent(ws, item.builtin, input, project, sessionContext);
      } else if (item.match) {
        await handleMatchedEntry(ws, item.match, input, item.matchedTrigger, project, sessionContext);
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // 1. Builtin conversational intents
  if (matchResult.builtin) {
    await handleBuiltinIntent(ws, matchResult.builtin, input, project, sessionContext);
    if (matchResult.builtin !== 'system.chit_chat.git_status') {
      ws.send(JSON.stringify({ type: 'end' }));
    }
    return;
  }

  // 2. Matched triggers
  if (matchResult.match) {
    await handleMatchedEntry(ws, matchResult.match, input, matchResult.matchedTrigger, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // 3. No match — try conversation context carryover before giving up
  const ctxResult = resolveContext(input, sessionContext.conversationHistory);
  if (ctxResult) {
    sessionContext.conversationHistory.push({
      input,
      matched: true,
      intent: ctxResult.builtin || null,
      entry: null,
      projectId,
    });
    if (sessionContext.conversationHistory.length > 5) {
      sessionContext.conversationHistory.shift();
    }
    await handleBuiltinIntent(ws, ctxResult.builtin, input, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // 4. Best-guess command fallback — no intent or context matched, but maybe we can
  // infer a shell command from the phrasing (e.g. "remove node_modules from git").
  const guessed = guessCommand(input);
  if (guessed) {
    const nearMissId = logNearMiss(project.id, {
      input,
      resolvedCommand: guessed.command,
      description: guessed.description,
      source: 'guess',
      telemetryEntryId: matchResult.telemetryId || undefined,
    });
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      projectId: project.id,
      command: guessed.command,
      trigger: input,
      createdAt: Date.now(),
      nearMissId,
      telemetryEntryId: matchResult.telemetryId || undefined,
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: `${guessed.command}  (${guessed.description})`,
      trigger: 'guessed'
    }));
    return;
  }

  // 5. No match at all: always send the informative fallback text, then attach suggestion
  // chips to it if we have any (getFallbackSuggestions in matcher.js means we almost always
  // do). Suggestions must ride on a preceding 'answer' — the frontend attaches the chip list
  // to the last chat bubble, so sending 'suggestions' with no bubble to attach to is a no-op.
  logNearMiss(project.id, {
    input,
    resolvedCommand: null,
    description: null,
    source: 'fallback',
    telemetryEntryId: matchResult.telemetryId || undefined,
  });
  const idx = project.codebaseIndex;
  let fallback = `I don't have a command configured for that in **[${project.name}]**.\n\n`;
  if (idx) {
    if (idx.entryPoints?.length) fallback += `**Entry point:** \`${idx.entryPoints[0]}\`\n`;
    if (idx.languages?.length) fallback += `**Languages:** ${idx.languages.slice(0, 3).join(', ')}\n`;
    if (idx.hasTests) fallback += '✅ Tests detected — try asking about tests\n';
    if (idx.hasConfig) fallback += '⚙️ Config files present — try "overview" or "stack"\n';
  }
  const ctxFb = injectContext(input, null, project.codebaseIndex);
  if (ctxFb) fallback += `\n${ctxFb}\n`;
  fallback += `\nTry **"help"** for available triggers, **"overview"** for project summary, or **"structure"** to explore directories.`;
  ws.send(JSON.stringify({ type: 'answer', data: fallback }));
  if (matchResult.suggestions && matchResult.suggestions.length > 0) {
    ws.send(JSON.stringify({ type: 'suggestions', data: matchResult.suggestions }));
  }
  ws.send(JSON.stringify({ type: 'end' }));
}

async function handleConfirmResponse(ws, parsed) {
  const { token, confirmed } = parsed.payload;

  if (!token) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token is invalid or expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // AI tool-call confirmations (writeFile/editFile/risky executeCommand from the AI path)
  if (pendingToolConfirmations.has(token)) {
    const pending = pendingToolConfirmations.get(token);
    pendingToolConfirmations.delete(token);
    pending.resolve(!!confirmed);
    return;
  }

  // Manual project-trigger risky-command confirmations
  if (!pendingConfirmations.has(token)) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token is invalid or expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  const pending = pendingConfirmations.get(token);
  pendingConfirmations.delete(token);

  // Interactive port-conflict prompt from a still-running dev server (see executor.js's
  // PORT_PROMPT_RE detection) — there's no new command to run here, just a reply to write into
  // the already-spawned child's stdin. Handled before the near-miss/telemetry bookkeeping below
  // since those fields don't apply to this pending-confirmation shape.
  if (pending.stdinWrite) {
    const proc = runningProcesses.get(pending.projectId);
    const reply = confirmed ? pending.stdinWrite.yes : pending.stdinWrite.no;
    if (proc?.child?.stdin?.writable) {
      proc.child.stdin.write(reply);
      ws.send(JSON.stringify({
        type: 'answer',
        data: confirmed
          ? 'Told the dev server to run on another port — watch for the new URL.'
          : "Told the dev server not to switch ports — it may exit now if the port is still busy.",
      }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: "That process isn't running anymore — nothing to respond to." }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Track near-miss accept/reject + update linked telemetry entry
  if (pending.nearMissId) {
    updateNearMiss(pending.projectId, pending.nearMissId, { accepted: !!confirmed });
  }
  if (pending.telemetryEntryId) {
    updateTelemetryEntry(pending.projectId, pending.telemetryEntryId, {
      falsePositive: !confirmed,
      resolvedByGuess: confirmed ? pending.command : null,
    });
    // Stage 1 ML work (2026-07-29): every confirm/reject response is a fresh labeled example for
    // confidenceModel.js's logistic regression. Retrain right away rather than waiting for the
    // next server restart, so the learned floor in suggestThresholds() reflects real usage as it
    // happens — fire-and-forget since retraining is fast (a few hundred gradient steps over a
    // small feature vector) but there's no reason to make the user wait on it.
    Promise.resolve().then(() => retrainConfidenceModel()).catch(() => {});
  }

  if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  if (!confirmed) {
    ws.send(JSON.stringify({ type: 'answer', data: `Cancelled: "${pending.command}"` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  const project = state.activeProjectsCache.find((p) => p.id === pending.projectId);
  if (!project) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Project not found.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Direct file-tool confirmations from trigger mode (file_create/file_append — see
  // queueFileOpConfirmation in builtinIntents.js) — there's no shell command here, just a
  // sandboxed tools.js function call, so this skips the shell allow/block checks entirely.
  if (pending.fileOp) {
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
    const tools = await createProjectTools(project);
    const fn = tools[pending.fileOp.tool];
    if (!fn) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Unknown file operation: ${pending.fileOp.tool}\n` }));
    } else {
      const result = await fn(pending.fileOp.args);
      if (result.success) {
        ws.send(JSON.stringify({ type: 'answer', data: `✅ ${result.data || 'Done.'}` }));
        const suggestion = trackFileEdit(project.path, pending.fileOp.args?.path || 'unknown');
        if (suggestion) {
          pendingMemorySuggestions.set(project.id, suggestion);
          ws.send(JSON.stringify({ type: 'memory_suggestion', data: suggestion }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `${result.error}\n` }));
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  if (isCommandBlocked(pending.command)) {
    ws.send(JSON.stringify({ type: 'error_output', data: `SAFETY BLOCK: Command "${pending.command}" is prohibited.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (!isCommandAllowed(pending.command)) {
    ws.send(JSON.stringify({ type: 'error_output', data: `Command not allowed: "${pending.command.split(/\s+/)[0]}" is not in the allowed commands list.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Skip the auto-checkpoint when the user is already making a git commit — the commit
  // itself is the checkpoint and we'd otherwise get a duplicate console-checkpoint commit.
  const isGitCommit = pending.command.trim().startsWith('git add -A && git commit');
  if (!isGitCommit) {
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
  }

  executeCommand(pending.command, project.path, ws, project.id);

  // Track the command in project memory
  const suggestion = trackCommand(project.path, pending.command);
  if (suggestion) {
    pendingMemorySuggestions.set(project.id, suggestion);
    ws.send(JSON.stringify({ type: 'memory_suggestion', data: suggestion }));
  }
}

/** Direct tool invocation from the frontend (not via AI chat). Scoped to the client's active project. */
async function handleToolCall(ws, parsed, sessionContext) {
  const tStart = Date.now();
  const { tool, args } = parsed.payload || {};
  if (!tool) {
    metrics.inc('tool_call.error');
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'Missing tool name.' } }));
    return;
  }
  metrics.inc(`tool_call.${tool}`);

  const projectId = args?.projectId || sessionContext.activeProjectId;
  const project = state.activeProjectsCache.find((p) => p.id === projectId);
  if (!project) {
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'No active project. Select a project first.' } }));
    return;
  }

  if (tool === 'executeCommand') {
    const { command, risky } = args || {};
    if (!command) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'command is required.' } }));
      return;
    }
    if (isCommandBlocked(command)) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'SAFETY BLOCK: Dangerous pattern detected.' } }));
      return;
    }
    if (!isCommandAllowed(command)) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Command not allowed: "${command.split(/\s+/)[0]}" is not in the allowed commands list.` } }));
      return;
    }
    if (risky) {
      const cp = await createCheckpoint(project.path, command);
      ws.send(JSON.stringify({ type: 'tool_start', data: `[GIT SAFETY] ${cp.message}\n` }));
    }
    executeCommand(command, project.path, ws, project.id);
    return;
  }

  const tools = await createProjectTools(project);
  if (!tools[tool]) {
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Unknown tool: ${tool}` } }));
    return;
  }

  if (isGatedToolCall(tool, args) || isCustomToolRisky(tool, project?.path)) {
    const token = crypto.randomUUID();
    const confirmed = await new Promise((resolve) => {
      pendingToolConfirmations.set(token, { resolve, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'tool_confirm_prompt', token, tool, args }));
    });
    if (!confirmed) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `${tool} rejected by user.` } }));
      return;
    }
  } else {
    ws.send(JSON.stringify({ type: 'tool_start', data: `Running ${tool}...` }));
  }

  const result = await tools[tool](args || {});
  metrics.observe('tool_call.duration', Date.now() - tStart);
  metrics.event({ type: 'tool_call_complete', tool, duration: Date.now() - tStart, success: result?.success !== false });
  ws.send(JSON.stringify({ type: 'tool_result', data: result }));
}
