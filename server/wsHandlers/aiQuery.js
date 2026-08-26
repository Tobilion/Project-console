import { checkOllama } from '../ollama.js';
import crypto from 'crypto';
import { appendMessage } from '../conversationStore.js';
import { streamWithToolDetection } from './aiStream.js';
import { analyzeAIExchange } from '../distillation.js';
import { trackFileEdit, trackQuestion, addCandidateAddition } from '../projectMemory.js';
import { metrics } from '../metrics.js';
import { MAX_TOOL_ROUNDS, runToolCall } from './aiQueryToolRun.js';
import { readProfile } from '../routes/profileRoutes.js';
import { buildAIQueryContext } from './aiQueryContext.js';
import { looksLikeUnexecutedToolIntent, looksLikeFabricatedActionClaim } from './aiQueryDetectors.js';
import { log } from '../logger.js';

/**
 * AI-mode query orchestrator (Phase 14 split, 2026-08-05 — bodies moved verbatim). The tool
 * execution/gating lives in aiQueryToolRun.js, the message/context assembly in
 * aiQueryContext.js, and the two confirmed-live "model didn't actually call a tool" detectors
 * in aiQueryDetectors.js. This file keeps only the streaming loop, the cancellation wiring,
 * and the post-query tracking/persistence.
 */
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

  let messages, cleanInput, model, tools, workspaceTools;
  try {
    ({ messages, cleanInput, model, tools, workspaceTools } =
      await buildAIQueryContext(project, input, sessionContext, workspaceProjects));
  } catch (err) {
    // buildAIQueryContext runs before the AbortController exists — a throw here used to reject
    // out of handleAIQuery entirely, skipping both the error reply and the turn's end message
    // (audit 2026-08-06, Phase 2).
    metrics.inc('ai_query.error');
    metrics.event({ type: 'ai_query_error', error: err.message });
    ws.send(JSON.stringify({ type: 'error_output', data: `AI error: ${err.message}\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
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
  // Turn ownership tag for processes this turn starts via executeCommand — `cancel` uses it to
  // kill ONLY this turn's processes, never a dev server the user started separately (audit
  // 2026-08-17). Cleared in finally below alongside aiAbortController.
  const turnKey = crypto.randomUUID();
  sessionContext.turnKey = turnKey;

  // Round-6 audit (2026-08-24): read-only "Ask" permission mode — read once per turn so the
  // whole exchange behaves consistently even if the profile changes mid-turn. Passed into
  // runToolCall, which blocks mutating tools with a plain error (no prompts, no checkpoint).
  const askMode = readProfile().permissionMode === 'ask';

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
        const result = await runToolCall(ws, project, tools, call, workspaceTools, workspaceProjects, sessionContext.toolGrants, turnKey, askMode);
        ws.send(JSON.stringify({ type: 'tool_result', data: { tool: call.tool, args: call.args, result } }));
        resultsSummary.push(`Tool ${call.tool} returned: ${JSON.stringify(result)}`);
        // Track tool call for distillation
        toolHistory.push({ tool: call.tool, args: call.args, result });
        // Track file edits for project memory
        if ((call.tool === 'writeFile' || call.tool === 'editFile' || call.tool === 'insertAtLine') && result?.success !== false) {
          trackFileEdit(project.path, call.args?.path || 'unknown');
        }
      }

      // Same-tool failure-streak detection (Phase 4, audit 2026-08-10 §2.3): a tool call that
      // executes and fails was previously just folded into resultsSummary as plain text —
      // nothing stopped the model from retrying the identical failing call every round up to
      // MAX_TOOL_ROUNDS, burning the whole exchange on a call that was never going to succeed.
      // Counts failures per tool across the WHOLE exchange (toolHistory accumulates every round,
      // not just this one), so a streak that started two rounds ago is still caught here.
      const failureCounts = new Map();
      for (const { tool, result } of toolHistory) {
        if (result?.success === false) failureCounts.set(tool, (failureCounts.get(tool) || 0) + 1);
      }
      const stuckTools = [...failureCounts.entries()].filter(([, n]) => n >= 2).map(([tool]) => tool);
      const stuckNote = stuckTools.length
        ? `\n\nNote: ${stuckTools.map((t) => `"${t}"`).join(', ')} has now failed twice with the same kind of error this exchange — don't retry it with the same or similar arguments. Try a different approach, or tell the user why it can't be done.`
        : '';

      messages.push({
        role: 'user',
        content: `Tool results:\n${resultsSummary.join('\n')}\n\nBased on these results, continue helping the user. Call another tool only if you still need one; otherwise give your final answer without any <tool_call> tags.${stuckNote}`
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

    // A stream that produced neither text nor a tool call would otherwise end the turn
    // silently — nothing shown, nothing persisted, and the placeholder bubble stayed empty
    // (audit 2026-08-06, Phase 2).
    if (!finalText || !finalText.trim()) {
      ws.send(JSON.stringify({ type: 'error_output', data: 'The model returned an empty response — try again, or rephrase the request.\n' }));
      metrics.inc('ai_query.empty_response');
    }

    // Fabricated-action-claim check — see looksLikeFabricatedActionClaim above. Runs once, after
    // every round is done, against toolHistory (everything actually run this whole exchange), not
    // any single round's toolCalls, since a real tool could have run in an earlier round. The
    // warning is sent as its own message rather than editing finalText in place, because the
    // fabricated claim was already streamed to the user token-by-token before we get here — it
    // can't be un-shown, only corrected right after.
    if (looksLikeFabricatedActionClaim(finalText, toolHistory)) {
      const warning = '⚠ **Nothing was actually run** — no tool call was made during this exchange, so despite what I just said, nothing was actually pushed/committed/changed. Ask again if you want this done for real.';
      ws.send(JSON.stringify({ type: 'error_output', data: `${warning}\n` }));
      finalText = `${finalText}\n\n${warning}`;
      metrics.inc('ai_query.fabricated_action_claim');
    }

    metrics.observe('ai_query.duration', Date.now() - tStart);
    metrics.event({ type: 'ai_query_complete', duration: Date.now() - tStart, rounds: round, toolCalls: toolHistory.length });
  } catch (err) {
    // A stream that threw or was aborted never reached its own stream_end — the frontend
    // clears its AI-busy state and finalizes the placeholder bubble ONLY on stream_end, so
    // skipping it left the spinner stuck forever and an empty streaming bubble in the chat
    // (audit 2026-08-06, Phase 2). Send it in every failure path; the frontend's stream_end
    // case tolerates a stream with zero tokens.
    try { ws.send(JSON.stringify({ type: 'stream_end' })); } catch {}
    if (err.name === 'AbortError') {
      if (abortController.signal.aborted) {
        metrics.event({ type: 'ai_query_cancelled', duration: Date.now() - tStart });
        ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled.' }));
      } else {
        // The user's signal was never aborted, so this AbortError came from chatStream's idle
        // watchdog (hung daemon/GPU stall) — report it as an error, not a cancellation.
        const timeoutMsg = err.reason?.message || err.message;
        metrics.inc('ai_query.error');
        metrics.event({ type: 'ai_query_error', error: timeoutMsg });
        ws.send(JSON.stringify({ type: 'error_output', data: `AI error: ${timeoutMsg}\n` }));
      }
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
    if (sessionContext.turnKey === turnKey) {
      sessionContext.turnKey = null;
    }
  }

  // Post-query tracking (project memory, distillation, persistence) must never be able to drop
  // the turn's 'end' — a throw in any of these used to skip it, leaving the frontend's busy
  // indicator stuck forever after a fully streamed answer (audit 2026-08-06, Phase 2).
  try {
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
      appendMessage(sessionContext.currentSessionId, { role: 'bot', content: finalText.trim(), isMarkdown: true }).catch(() => {});
    }
  } catch (err) {
    metrics.inc('ai_query.post_error');
    log.error('AI post-query tracking error:', err);
  }

  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'end' }));
}
