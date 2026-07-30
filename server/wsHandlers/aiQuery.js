import crypto from 'crypto';
import { checkOllama } from '../ollama.js';
import { buildSystemPrompt } from '../ollamaContext.js';
import { injectContext } from '../contextInjector.js';
import { getSession, appendMessage } from '../conversationStore.js';
import { createProjectTools, isGatedToolCall, isCommandAllowed, isCustomToolRisky } from '../tools.js';
import { executeCommand } from '../executor.js';
import { createCheckpoint } from '../gitSafety.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { pendingToolConfirmations } from '../state.js';
import { commandMatchesTemplate } from '../paramCommand.js';
import { streamWithToolDetection } from './aiStream.js';
import { analyzeAIExchange } from '../distillation.js';
import { trackFileEdit, trackQuestion, addCandidateAddition } from '../projectMemory.js';
import { metrics } from '../metrics.js';

const MAX_TOOL_ROUNDS = 6;

/**
 * Detects a model narrating an intention to call a tool ("We need to call getGitStatus.") without
 * actually emitting a `<tool_call>{...}</tool_call>` block — `streamWithToolDetection` has nothing
 * to intercept in that case, so the narration would otherwise silently become the "final answer"
 * with no tool ever running and no error surfaced. Confirmed live 2026-07-29 via a real exported
 * transcript: qwen3.5:cloud did this three times in a row for "push this code to github" (each
 * reply along the lines of "We need to call getGitStatus." / "...We output tool call.") — nothing
 * ever got pushed, and there was no signal to the user that the request had silently failed,
 * until they gave up and turned AI mode off. Deliberately narrow (looks for explicit "narrating a
 * call" phrasing) so it doesn't fire on legitimate short answers that just happen to mention a
 * tool name in passing.
 */
function looksLikeUnexecutedToolIntent(text) {
  if (!text || !text.trim()) return false;
  return /\b(?:we|i)\s+(?:need|should|must|will|have)\s+to\s+call\b/i.test(text)
    || (text.length < 200 && /\btool\s*call\b/i.test(text));
}

/**
 * Detects a reply that describes a completed mutating action (push/commit/deploy/write/delete/
 * install) in success language, checked against `toolHistory` — every tool ACTUALLY run anywhere
 * in this exchange, across every round. If that's empty, nothing real happened, so a reply that
 * still claims one of these actions succeeded is fabricated.
 *
 * Confirmed live 2026-07-29 via a real exported transcript: asked to "push", the model skipped
 * straight to "That **pushed successfully** ✅" with a fabricated-looking list of commit hashes —
 * no `<tool_call>` block, and no narrated intention either (so `looksLikeUnexecutedToolIntent`
 * above wouldn't have caught this one — there was nothing to retry, the model just invented a
 * result outright). It even second-guessed itself two messages later ("let me actually verify
 * what's in the commits since I claimed to push but have no visibility into the contents"),
 * confirming after the fact that the success claim was never backed by a real action. This is a
 * more serious failure mode than narrating-without-calling: the user could easily believe a
 * destructive git operation happened when it didn't.
 */
function looksLikeFabricatedActionClaim(text) {
  if (!text) return false;
  const actionVerbs = /\b(pushed|committed|deployed|deleted|installed|wrote|written|created|merged|reverted)\b/i;
  const successWords = /\b(successfully|success|done|complete[d]?|✅|now on (?:origin|main)|origin\/main)\b/i;
  return actionVerbs.test(text) && successWords.test(text);
}

/** Waits for the user to approve/reject a gated tool call, driven by an incoming confirm_response. */
function requestToolConfirmation(ws, tool, args) {
  const token = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingToolConfirmations.set(token, { resolve, createdAt: Date.now() });
    ws.send(JSON.stringify({ type: 'tool_confirm_prompt', token, tool, args }));
  });
}

async function runGatedExecuteCommand(ws, project, args) {
  const command = args?.command;
  if (!command) return { success: false, error: 'command is required.' };
  if (isCommandBlocked(command)) {
    return { success: false, error: `SAFETY BLOCK: "${command}" matches a dangerous pattern and is prohibited.` };
  }
  if (!isCommandAllowed(command)) {
    return { success: false, error: `Command not allowed: "${command.split(/\s+/)[0]}" is not in the allowed commands list.` };
  }
  if (args.risky) {
    const cp = await createCheckpoint(project.path, command);
    ws.send(JSON.stringify({ type: 'tool_start', data: `[GIT SAFETY] ${cp.message}\n` }));
  }
  // Dev server processes (npm run dev/start) keep running indefinitely. Add a 6s timeout
  // so the AI tool loop doesn't hang — the URL will have been sent as a server_url event
  // during stdout streaming. If the process exits before the timeout, we get the real result.
  const TIMEOUT_MS = 6000;
  const cmdPromise = executeCommand(command, project.path, ws, project.id);
  const result = await Promise.race([
    cmdPromise,
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), TIMEOUT_MS))
  ]);
  if (result?.timeout) {
    return { success: true, data: { code: null, timeout: true, message: 'Command started (long-running process detached after 6s timeout).' } };
  }
  // Confirmed live 2026-07-29 (requested directly): the system prompt already tells the model to
  // offer saving a newly-discovered command into console.config.json, but that was left entirely
  // to the model remembering a long instruction on its own — unreliable in practice. This makes
  // the nudge structural instead of hoped-for: whenever a command actually succeeds and isn't
  // already covered by an existing entry (exact match, or shape match against a {param}
  // template), the tool RESULT itself carries a reminder, so the model sees it fresh on every
  // successful command rather than only when it happens to recall the rule.
  if (result?.success) {
    const entries = project?.config?.entries || [];
    const alreadySaved = entries.some((e) => e.type === 'command' && commandMatchesTemplate(command, e.action));
    if (!alreadySaved) {
      result.note = 'This command is not yet in console.config.json. If it worked, consider offering to save it as a real entry (see your instructions) so trigger mode can run it without AI next time.';
    }
  }
  return result;
}

/** Executes a single parsed tool call, gating destructive ones behind user confirmation first. */
async function runToolCall(ws, project, tools, call, workspaceTools = {}, workspaceProjects = []) {
  const { tool, args } = call;

  if (tool === 'executeCommand') {
    if (isGatedToolCall(tool, args)) {
      ws.send(JSON.stringify({ type: 'tool_start', data: `Requesting approval to run: ${args?.command}` }));
      const approved = await requestToolConfirmation(ws, tool, args);
      if (!approved) return { success: false, error: 'Command rejected by user.' };
    }
    return runGatedExecuteCommand(ws, project, args);
  }

  if (!tools[tool]) {
    return { success: false, error: `Unknown tool: ${tool}` };
  }

  // If the AI specified a projectId, use that project's tools instead
  const targetProjectId = args?.projectId;
  let resolvedTools = tools;
  let resolvedProject = project;
  if (targetProjectId && workspaceTools[targetProjectId]) {
    resolvedTools = workspaceTools[targetProjectId];
    resolvedProject = workspaceProjects.find(p => p.id === targetProjectId) || project;
  }

  const needsApproval = isGatedToolCall(tool, args) || isCustomToolRisky(tool, resolvedProject?.path);
  if (needsApproval) {
    ws.send(JSON.stringify({ type: 'tool_start', data: `Requesting approval for ${tool}${targetProjectId ? ` (${targetProjectId})` : ''}: ${args?.path || args?.content || ''}` }));
    const approved = await requestToolConfirmation(ws, tool, args);
    if (!approved) return { success: false, error: `${tool} rejected by user.` };
  } else {
    ws.send(JSON.stringify({ type: 'tool_start', data: `Running ${tool}${targetProjectId ? ` on ${targetProjectId}` : ''}...` }));
  }

  return resolvedTools[tool](args);
}

export async function handleAIQuery(ws, project, input, sessionContext, workspaceProjects = []) {
  metrics.inc('ai_query.total');
  const tStart = Date.now();

  const running = await checkOllama();
  if (!running) {
    metrics.inc('ai_query.ollama_unavailable');
    ws.send(JSON.stringify({ type: 'error_output', data: 'Ollama is not running. Open Ollama from your system tray (or start it), then try again.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  const systemPrompt = await buildSystemPrompt(project, sessionContext.aiMode || 'default', workspaceProjects);
  const messages = [{ role: 'system', content: systemPrompt }];

  if (sessionContext.currentSessionId) {
    try {
      const session = await getSession(sessionContext.currentSessionId);
      if (session?.messages) {
        const history = session.messages.slice(-10);
        for (const msg of history) {
          const role = msg.role === 'bot' ? 'assistant' : msg.role === 'user' ? 'user' : null;
          if (role) messages.push({ role, content: msg.content });
        }
      }
    } catch {}
  }

  // Handle reason mode: strip prefix and add reasoning instruction
  let reasoningMode = false;
  let cleanInput = input;
  if (input.startsWith('[REASON] ')) {
    reasoningMode = true;
    cleanInput = input.slice(9);
  }
  const ctxAi = injectContext(cleanInput, null, project?.codebaseIndex);
  let enrichedInput = ctxAi ? `${cleanInput}\n\nRelevant project context:\n${ctxAi}` : cleanInput;
  if (reasoningMode) {
    enrichedInput = `[Think step by step and provide a thorough, reasoned answer]\n${enrichedInput}`;
  }
  messages.push({ role: 'user', content: enrichedInput });

  const model = sessionContext.aiModel || 'qwen2.5-coder:7b';
  const tools = await createProjectTools(project);
  // Create tools for all workspace projects so the AI can operate on any of them
  const workspaceTools = {};
  workspaceTools[project.id] = tools;
  for (const wp of workspaceProjects) {
    if (wp.id !== project.id) {
      try { workspaceTools[wp.id] = await createProjectTools(wp); } catch {}
    }
  }
  let finalText = '';
  const toolHistory = [];

  // Requested directly (2026-07-29) after a query with no bound at all — CPU-only Ollama
  // inference can genuinely take minutes with no GPU, and there was previously no way to
  // interrupt it once started. `sessionContext.aiAbortController` is read by the new 'cancel'
  // WS message handler in connection.js; cleared in `finally` below so a stray cancel after the
  // request already finished has nothing stale to abort.
  const abortController = new AbortController();
  sessionContext.aiAbortController = abortController;

  try {
    ws.send(JSON.stringify({ type: 'ai_start', data: `Thinking... (${model})` }));
    ws.send(JSON.stringify({ type: 'stream_start' }));
    let { visibleText, toolCalls } = await streamWithToolDetection(model, messages, ws, abortController.signal);
    ws.send(JSON.stringify({ type: 'stream_end' }));
    finalText = visibleText;

    // One bounded corrective retry: if the model announced a tool call but never actually
    // produced one, tell it explicitly and give it a single extra chance before accepting
    // whatever it says next as the real answer. See looksLikeUnexecutedToolIntent above.
    if (toolCalls.length === 0 && looksLikeUnexecutedToolIntent(visibleText)) {
      messages.push({ role: 'assistant', content: visibleText || '(no visible text)' });
      messages.push({
        role: 'user',
        content: 'You said you would call a tool, but no <tool_call>{"tool": "...", "args": {...}}</tool_call> block was found in your response. If you still need to call a tool, emit it now wrapped in exactly those tags. Otherwise, answer directly without mentioning a tool call.',
      });
      ws.send(JSON.stringify({ type: 'stream_start' }));
      const retry = await streamWithToolDetection(model, messages, ws, abortController.signal);
      ws.send(JSON.stringify({ type: 'stream_end' }));
      visibleText = retry.visibleText;
      toolCalls = retry.toolCalls;
      finalText = visibleText;
    }

    let round = 0;
    while (toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      round++;
      messages.push({ role: 'assistant', content: visibleText || '(tool call)' });

      const resultsSummary = [];
      for (const call of toolCalls) {
        const result = await runToolCall(ws, project, tools, call, workspaceTools, workspaceProjects);
        ws.send(JSON.stringify({ type: 'tool_result', data: { tool: call.tool, args: call.args, result } }));
        resultsSummary.push(`Tool ${call.tool} returned: ${JSON.stringify(result)}`);
        // Track tool call for distillation
        toolHistory.push({ tool: call.tool, args: call.args, result });
        // Track file edits for project memory
        if ((call.tool === 'writeFile' || call.tool === 'editFile' || call.tool === 'insertAtLine') && result?.success !== false) {
          trackFileEdit(project.path, call.args?.path || 'unknown');
        }
      }

      messages.push({
        role: 'user',
        content: `Tool results:\n${resultsSummary.join('\n')}\n\nBased on these results, continue helping the user. Call another tool only if you still need one; otherwise give your final answer without any <tool_call> tags.`
      });

      ws.send(JSON.stringify({ type: 'stream_start' }));
      const next = await streamWithToolDetection(model, messages, ws, abortController.signal);
      ws.send(JSON.stringify({ type: 'stream_end' }));
      visibleText = next.visibleText;
      toolCalls = next.toolCalls;
      finalText = finalText ? `${finalText}\n\n${visibleText}` : visibleText;
    }

    if (round >= MAX_TOOL_ROUNDS && toolCalls.length > 0) {
      ws.send(JSON.stringify({ type: 'error_output', data: 'Stopped after too many tool-call rounds — ask a more specific follow-up.\n' }));
    }

    // Fabricated-action-claim check — see looksLikeFabricatedActionClaim above. Runs once, after
    // every round is done, against toolHistory (everything actually run this whole exchange), not
    // any single round's toolCalls, since a real tool could have run in an earlier round. The
    // warning is sent as its own message rather than editing finalText in place, because the
    // fabricated claim was already streamed to the user token-by-token before we get here — it
    // can't be un-shown, only corrected right after.
    if (toolHistory.length === 0 && looksLikeFabricatedActionClaim(finalText)) {
      const warning = '⚠️ **Nothing was actually run** — no tool call was made during this exchange, so despite what I just said, nothing was actually pushed/committed/changed. Ask again if you want this done for real.';
      ws.send(JSON.stringify({ type: 'error_output', data: `${warning}\n` }));
      finalText = `${finalText}\n\n${warning}`;
      metrics.inc('ai_query.fabricated_action_claim');
    }

    metrics.observe('ai_query.duration', Date.now() - tStart);
    metrics.event({ type: 'ai_query_complete', duration: Date.now() - tStart, rounds: round, toolCalls: toolHistory.length });
  } catch (err) {
    if (err.name === 'AbortError') {
      metrics.event({ type: 'ai_query_cancelled', duration: Date.now() - tStart });
      ws.send(JSON.stringify({ type: 'answer', data: '⏹️ Cancelled.' }));
    } else {
      metrics.inc('ai_query.error');
      metrics.event({ type: 'ai_query_error', error: err.message });
      // ":cloud" models proxy through the local Ollama daemon to ollama.com. Confirmed live
      // 2026-07-29: a 404 here means Ollama's cloud catalog doesn't recognize this exact model
      // tag (it's been renamed/retired — see the CLOUD_MODELS comment in ollama.js) — a real,
      // different failure mode than "not signed in", which previously always got the same
      // sign-in hint regardless of the actual HTTP status, confusing a user who was already
      // signed in. Only suggest sign-in for the auth-shaped failures (401/403), and point at
      // picking a different model for a 404 instead.
      let hint = '';
      if (model.endsWith(':cloud')) {
        if (/\b404\b/.test(err.message)) {
          hint = ' This model tag isn\'t recognized by Ollama Cloud right now (it may have been renamed or retired) — pick a different cloud model from the dropdown, or check ollama.com/search?c=cloud for the current name.';
        } else if (/\b401\b/.test(err.message)) {
          hint = ' This looks like an auth issue — run `ollama signin` in a terminal, then try again.';
        } else if (/\b403\b/.test(err.message)) {
          // Confirmed live 2026-07-29: a 403 (as opposed to 401) commonly means the daemon reached
          // Ollama's cloud endpoint and was actively refused — either the running Ollama app hasn't
          // picked up a sign-in that happened after it launched (needs a full restart, not just
          // re-running `ollama signin`), or this specific model requires a paid plan tier the
          // account doesn't have. Give both, since there's no way to tell which from the error alone.
          hint = ' This is usually either (a) Ollama needs a full restart to pick up a sign-in that happened after it was already running — quit it completely and reopen it, or (b) this specific model requires a paid Ollama plan your account doesn\'t have. Try restarting Ollama first; if it persists on this model but not others, it\'s likely (b).';
        } else {
          hint = ' This is an Ollama Cloud model — make sure you\'re signed in (`ollama signin`) and have an internet connection, then try again.';
        }
      }
      ws.send(JSON.stringify({ type: 'error_output', data: `AI error: ${err.message}${hint}\n` }));
    }
  } finally {
    if (sessionContext.aiAbortController === abortController) {
      sessionContext.aiAbortController = null;
    }
  }

  // Track the user's question in project memory for pattern detection
  trackQuestion(project.path, cleanInput || input);

  // If the AI produced a substantive answer, flag it as a candidate CLAUDE.md addition
  if (finalText && finalText.trim().length > 300) {
    const topic = cleanInput?.slice(0, 60) || input?.slice(0, 60) || 'AI analysis';
    addCandidateAddition(project.path, topic, finalText.trim(), finalText.length > 800 ? 'high' : 'medium');
  }

  // Distillation: analyze what the AI did and suggest trigger-mode improvements
  if (toolHistory.length > 0) {
    analyzeAIExchange(project, {
      input: cleanInput || input,
      finalText: finalText || '',
      toolHistory,
    });
  }

  // Persist the final assistant text explicitly — token/stream events aren't auto-saved
  // the way single 'answer' messages are (see the ws.send interceptor in wsHandlers/connection.js).
  if (sessionContext.currentSessionId && finalText.trim()) {
    appendMessage(sessionContext.currentSessionId, { role: 'bot', content: finalText.trim() }).catch(() => {});
  }

  ws.send(JSON.stringify({ type: 'end' }));
}
