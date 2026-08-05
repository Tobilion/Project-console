import { checkOllama } from '../ollama.js';
import { appendMessage } from '../conversationStore.js';
import { streamWithToolDetection } from './aiStream.js';
import { analyzeAIExchange } from '../distillation.js';
import { trackFileEdit, trackQuestion, addCandidateAddition } from '../projectMemory.js';
import { metrics } from '../metrics.js';
import { MAX_TOOL_ROUNDS, runToolCall } from './aiQueryToolRun.js';
import { buildAIQueryContext } from './aiQueryContext.js';
import { looksLikeUnexecutedToolIntent, looksLikeFabricatedActionClaim } from './aiQueryDetectors.js';

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

  const { messages, cleanInput, model, tools, workspaceTools } =
    await buildAIQueryContext(project, input, sessionContext, workspaceProjects);
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
        const result = await runToolCall(ws, project, tools, call, workspaceTools, workspaceProjects, sessionContext.toolGrants);
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
      const warning = '⚠ **Nothing was actually run** — no tool call was made during this exchange, so despite what I just said, nothing was actually pushed/committed/changed. Ask again if you want this done for real.';
      ws.send(JSON.stringify({ type: 'error_output', data: `${warning}\n` }));
      finalText = `${finalText}\n\n${warning}`;
      metrics.inc('ai_query.fabricated_action_claim');
    }

    metrics.observe('ai_query.duration', Date.now() - tStart);
    metrics.event({ type: 'ai_query_complete', duration: Date.now() - tStart, rounds: round, toolCalls: toolHistory.length });
  } catch (err) {
    if (err.name === 'AbortError') {
      metrics.event({ type: 'ai_query_cancelled', duration: Date.now() - tStart });
      ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled.' }));
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
    appendMessage(sessionContext.currentSessionId, { role: 'bot', content: finalText.trim(), isMarkdown: true }).catch(() => {});
  }

  ws.send(JSON.stringify({ type: 'end' }));
}
