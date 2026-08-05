import type { WsCtx, WsCaseHandler } from './wsCtx';
import { makeId } from './wsCtx';
import { WS_STREAMING_CASES } from './wsStreamingCases';

/**
 * The non-streaming WS-message case handlers, extracted verbatim from useConsole.ts's
 * handleWebSocketMessage switch. Every handler is a pure function of (ctx, payload) — no
 * module-level state, no captures — so they're testable without React (see
 * scripts/checkWsMessageCases.ts). The orchestrator merges this table with the streaming
 * trio into the single WS_MESSAGE_CASES dispatch map.
 */

const answerCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  // Plain informational message (intent answers, the command-output summarizer callout on
  // 'end') — its own bubble, unchanged.
  ctx.ai.setAiThinking(false);
  if (!payload.data?.trim()) return;
  ctx.sessions.setMessages(prev => [...prev, { id, type: 'bot', content: payload.data, isMarkdown: true }]);
};

const streamOutputCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  // Phase 6 (PASS 6.3): command output no longer accumulates into the previous chat bubble
  // — 'start' opens a fresh collapsible 'output'-type block per command and 'output'/'end'
  // append into the open block, so the chat keeps the ▶ start line and the rest of the
  // stream lives inside a terminal-style block (the summarizer callout and URL links come
  // as their own 'answer'/'server_url' bubbles and stay separate). 'end' opens a block
  // only defensively if none is open (executor always sends 'start' first).
  ctx.ai.setAiThinking(false);
  // 'end' is the one reliable "this turn is fully finished" signal across every
  // trigger-mode path (including ones with no visible text, e.g. a bare `{type:'end'}`
  // after a builtin intent) — deliberately NOT cleared on 'start'/'output' alone, since a
  // still-booting dev server keeps emitting those without actually being done yet.
  if (payload.type === 'end') ctx.commandPending.setCommandPending(false);
  if (payload.type === 'output' && payload.data) ctx.appendProcessOutput(payload.data);
  if (!payload.data?.trim()) return;
  ctx.sessions.setMessages(prev => {
    const lastMsg = prev[prev.length - 1];
    if (lastMsg && lastMsg.type === 'output' && payload.type !== 'start') {
      const newMsgs = [...prev];
      newMsgs[newMsgs.length - 1] = { ...lastMsg, content: lastMsg.content + '\n' + payload.data };
      return newMsgs;
    }
    return [...prev, { id, type: 'output', content: payload.data }];
  });
};

const errorOutputCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  // Some paths (a top-level WS parse error) send only this with no 'end' to follow —
  // don't leave the busy indicator stuck on.
  ctx.commandPending.setCommandPending(false);
  if (payload.data) ctx.appendProcessOutput(payload.data);
  ctx.sessions.setMessages(prev => [...prev, {
    id, type: 'error', content: payload.data,
    switchProjectAction: payload.switchProjectAction,
  }]);
};

const warningCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  // Informational notices (e.g. the collapsed LF/CRLF "line endings will be normalized"
  // summary) — rendered as an amber banner by Terminal, persisted as role 'warning' so
  // reloaded sessions keep the styling.
  ctx.commandPending.setCommandPending(false);
  if (payload.data) ctx.appendProcessOutput(payload.data);
  ctx.sessions.setMessages(prev => [...prev, {
    id, type: 'warning', content: payload.data,
  }]);
};

const suggestionsCase: WsCaseHandler = (ctx, payload) => {
  ctx.sessions.setMessages(prev => {
    const last = prev[prev.length - 1];
    if (last) {
      const newMsgs = [...prev];
      newMsgs[newMsgs.length - 1] = { ...last, suggestions: payload.data };
      return newMsgs;
    }
    return prev;
  });
};

const didYouMeanCase: WsCaseHandler = (ctx, payload) => {
  ctx.sessions.setMessages(prev => {
    const last = prev[prev.length - 1];
    if (last) {
      const newMsgs = [...prev];
      newMsgs[newMsgs.length - 1] = { ...last, didYouMean: payload.data };
      return newMsgs;
    }
    return prev;
  });
};

const clearConsoleCase: WsCaseHandler = (ctx) => {
  ctx.commandPending.setCommandPending(false);
  ctx.sessions.setMessages([]);
};

const confirmPromptCase: WsCaseHandler = (ctx, payload) => {
  // Some trigger-mode paths (a guessed direct command, an unrecognized-but-guessable
  // command) send this and nothing else — no 'end' follows, so this has to double as an
  // end-of-turn signal too or the busy indicator would stay stuck on until the user
  // approves/cancels.
  ctx.commandPending.setCommandPending(false);
  ctx.terminal.setPendingConfirm({ token: payload.token, command: payload.command });
};

const projectsUpdatedCase: WsCaseHandler = (ctx, payload) => {
  if (payload.data) ctx.projects.setProjects(payload.data);
};

const projectUpdatedCase: WsCaseHandler = (ctx, payload) => {
  if (payload.data) {
    ctx.projects.setProjects(prev => prev.map(p => p.id === payload.data.id ? payload.data : p));
    ctx.projects.setIndexingProjectId(prev => prev === payload.data.id ? null : prev);
  }
};

const aiStatusCase: WsCaseHandler = (ctx, payload) => {
  if (payload.data) {
    ctx.ai.setAiEnabled(payload.data.enabled);
    if (payload.data.model) ctx.ai.setAiModel(payload.data.model);
    if (payload.data.mode) ctx.ai.setAiMode(payload.data.mode);
  }
};

const aiStartCase: WsCaseHandler = (ctx) => {
  ctx.ai.setAiThinking(true);
  ctx.ai.setAiThinkingText('');
  // Used to force the tool trace panel open on every single AI message ("so live activity
  // is visible without an extra click") — reported directly as an annoyance once AI mode
  // was actually being used for real (it popped the panel open on every message, including
  // ones with no tool calls at all, overriding the user's own choice to keep it closed).
  // The manual toggle button (now reliably visible after the earlier layout fix) is enough.
};

const thinkingCase: WsCaseHandler = (ctx, payload) => {
  // A reasoning model's internal deliberation, separate from its actual answer (see
  // ollama.js/aiStream.js) — previously received and silently dropped. Appended directly
  // rather than run through the token buffer/flush-timer machinery below: thinking text is
  // typically much lower-volume than the final answer and this is a plain italic status
  // line, not markdown-rendered chat content, so the extra batching isn't worth the delay.
  if (payload.data) {
    ctx.ai.setAiThinkingText(prev => prev + payload.data);
  }
};

const toolStartCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  // Previously sent by the server and silently dropped client-side — the user had no
  // live indication a command/tool was actually running until it finished (or, worse,
  // no visible progress at all for long-running steps). Surface it immediately as its
  // own lightweight line instead of waiting for the eventual tool_result.
  if (payload.data) {
    ctx.sessions.setMessages(prev => [...prev, { id, type: 'system', content: `⚙️ ${payload.data}` }]);
  }
};

const toolConfirmPromptCase: WsCaseHandler = (ctx, payload) => {
  ctx.terminal.setPendingToolConfirm({ token: payload.token, tool: payload.tool, args: payload.args || {} });
};

const taskGrantedCase: WsCaseHandler = (ctx) => {
  const id = makeId();
  // Phase 5 (PASS 5.1): "Approve this task" acknowledged server-side.
  ctx.sessions.setMessages(prev => [...prev, { id, type: 'system', content: '✅ Approved this task — file edits for this conversation will run without further prompts (commands and tests still confirm).' }]);
};

const memorySuggestionCase: WsCaseHandler = (ctx, payload) => {
  // Proactive Layer-4 self-learning nudge (repeated question / frequent command / frequent
  // file edit / candidate CLAUDE.md addition) — previously silently dropped here, so the
  // whole adaptive-memory feature never reached the user despite firing server-side.
  ctx.terminal.setPendingMemorySuggestion(payload.data || payload);
};

const toolResultCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  const toolData = payload.data || {};
  ctx.addToolCall(toolData.tool || 'unknown', toolData.args || {}, toolData.result || toolData);
  if (toolData.tool && toolData.result && !toolData.error) {
    ctx.sessions.setMessages(prev => [...prev, {
      id, type: 'system',
      content: `🔧 Tool: ${toolData.tool}\n${typeof toolData.result === 'string' ? toolData.result : JSON.stringify(toolData.result, null, 2).slice(0, 500)}${JSON.stringify(toolData.result, null, 2).length > 500 ? '…' : ''}`
    }]);
  }
};

const workspaceUpdatedCase: WsCaseHandler = (ctx, payload) => {
  if (payload.data) {
    const wsProjects = payload.data.projectIds
      .map((id: string) => ctx.projects.projects.find(p => p.id === id))
      .filter(Boolean);
    ctx.workspace.setWorkspaceProjects(wsProjects);
  }
};

const serverUrlCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  ctx.sessions.setMessages(prev => [...prev, { id, type: 'bot', content: `🔗 Dev server running at **${payload.data}**`, isMarkdown: true }]);
};

const copyToClipboardCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  navigator.clipboard.writeText(payload.data).then(() => {
    ctx.sessions.setMessages(prev => [...prev, { id, type: 'system', content: `✅ Copied to clipboard: \`${payload.data}\`` }]);
  }).catch(() => {
    ctx.sessions.setMessages(prev => [...prev, { id, type: 'error', content: 'Failed to copy to clipboard' }]);
  });
};

const dashboardUpdateCase: WsCaseHandler = (ctx) => {
  ctx.setDashboardUpdateSignal(n => n + 1);
};

const processesUpdateCase: WsCaseHandler = (ctx) => {
  // Phase 6: any process started, detached, stopped, or got a URL → refresh the dock
  // registry (selection/log pruning handled inside fetchProcesses).
  ctx.fetchProcesses();
};

const learningSuggestionCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  const { suggestions } = payload.data;
  if (suggestions.length === 0) {
    ctx.sessions.setMessages(prev => [...prev, { id, type: 'bot', content: 'No learning suggestions yet — keep using the console and check back later!' }]);
  } else {
    const formatted = suggestions.map((s: any) =>
      `**${s.intent}** (${s.confidence}) — ${s.count} occurrences, ${s.accepted} accepted, ${s.rejected} rejected\nPhrases: ${s.phrases.slice(0, 5).join(', ')}${s.phrases.length > 5 ? ` (+${s.phrases.length - 5} more)` : ''}`
    ).join('\n\n');
    ctx.sessions.setMessages(prev => [...prev, {
      id, type: 'bot', content: `### Learning Suggestions\n\n${formatted}\n\nType "approve suggestions" to add all, or "approve suggestions 1 3" to approve specific ones.`,
      isMarkdown: true,
      suggestions: suggestions.map((_: any, i: number) => `approve ${i + 1}`)
    }]);
  }
};

const WS_CORE_CASES: Record<string, WsCaseHandler> = {
  answer: answerCase,
  output: streamOutputCase,
  start: streamOutputCase,
  end: streamOutputCase,
  error_output: errorOutputCase,
  warning: warningCase,
  suggestions: suggestionsCase,
  did_you_mean: didYouMeanCase,
  clear_console: clearConsoleCase,
  confirm_prompt: confirmPromptCase,
  projects_updated: projectsUpdatedCase,
  project_updated: projectUpdatedCase,
  ai_status: aiStatusCase,
  ai_start: aiStartCase,
  thinking: thinkingCase,
  tool_start: toolStartCase,
  tool_confirm_prompt: toolConfirmPromptCase,
  task_granted: taskGrantedCase,
  memory_suggestion: memorySuggestionCase,
  tool_result: toolResultCase,
  workspace_updated: workspaceUpdatedCase,
  server_url: serverUrlCase,
  copy_to_clipboard: copyToClipboardCase,
  dashboard_update: dashboardUpdateCase,
  processes_update: processesUpdateCase,
  learning_suggestion: learningSuggestionCase,
};

/** Full dispatch map: core cases + the streaming trio (stream_start/token/stream_end). */
export const WS_MESSAGE_CASES: Record<string, WsCaseHandler> = {
  ...WS_CORE_CASES,
  ...WS_STREAMING_CASES,
};
