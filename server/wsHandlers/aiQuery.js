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
import { streamWithToolDetection } from './aiStream.js';
import { analyzeAIExchange } from '../distillation.js';
import { trackFileEdit, trackQuestion, addCandidateAddition } from '../projectMemory.js';
import { metrics } from '../metrics.js';

const MAX_TOOL_ROUNDS = 6;

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
    ws.send(JSON.stringify({ type: 'tool_start', data: `Requesting approval for ${tool}${targetProjectId ? ` (${targetProjectId})` : ''}: ${args?.path || ''}` }));
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

  try {
    ws.send(JSON.stringify({ type: 'ai_start', data: `Thinking... (${model})` }));
    ws.send(JSON.stringify({ type: 'stream_start' }));
    let { visibleText, toolCalls } = await streamWithToolDetection(model, messages, ws);
    ws.send(JSON.stringify({ type: 'stream_end' }));
    finalText = visibleText;

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
      const next = await streamWithToolDetection(model, messages, ws);
      ws.send(JSON.stringify({ type: 'stream_end' }));
      visibleText = next.visibleText;
      toolCalls = next.toolCalls;
      finalText = finalText ? `${finalText}\n\n${visibleText}` : visibleText;
    }

    if (round >= MAX_TOOL_ROUNDS && toolCalls.length > 0) {
      ws.send(JSON.stringify({ type: 'error_output', data: 'Stopped after too many tool-call rounds — ask a more specific follow-up.\n' }));
    }
    metrics.observe('ai_query.duration', Date.now() - tStart);
    metrics.event({ type: 'ai_query_complete', duration: Date.now() - tStart, rounds: round, toolCalls: toolHistory.length });
  } catch (err) {
    metrics.inc('ai_query.error');
    metrics.event({ type: 'ai_query_error', error: err.message });
    // ":cloud" models proxy through the local Ollama daemon to ollama.com — the most common
    // failure mode is simply "not signed in" or "offline," which surfaces as an opaque HTTP
    // error from chatStream(). Give a concrete next step instead of a bare status code.
    const hint = model.endsWith(':cloud')
      ? ' This is an Ollama Cloud model — run `ollama signin` in a terminal and make sure you have an internet connection, then try again.'
      : '';
    ws.send(JSON.stringify({ type: 'error_output', data: `AI error: ${err.message}${hint}\n` }));
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
