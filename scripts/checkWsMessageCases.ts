/**
 * checkWsMessageCases — self-asserting regression harness for the WS-message case tables
 * (src/hooks/wsMessageCases.ts + wsStreamingCases.ts). The client has no test runner, so this
 * uses the same pattern as the server check-* scripts but runs via tsx (already a devDependency):
 *   npm run check-ws-cases
 *
 * Every case handler is a pure function of (ctx, payload) — the fake ctx below records every
 * side effect (messages, terminal/AI/workspace setters, stream refs, dock hooks), and each
 * assertion checks the exact behavior moved out of useConsole.ts's handleWebSocketMessage.
 * Run after ANY edit to the case modules or the WsCtx shape.
 *
 * Also enforces CLI parity (Phase 0): every key in WS_CORE_CASES must have a `case` entry in
 * server/cli-client.js's switch — rendered or an explicit no-op — so a new WS message type can
 * never silently vanish in the second renderer of the same protocol.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WS_CORE_CASES, WS_MESSAGE_CASES } from '../src/hooks/wsMessageCases';
import type { WsCtx } from '../src/hooks/wsCtx';

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`FAIL: ${name}`);
}

function makeFakeCtx() {
  const state: any = {
    msgs: [],
    pendingConfirm: null,
    pendingToolConfirm: null,
    pendingMemorySuggestion: null,
    aiEnabled: false,
    aiModel: '',
    aiMode: '',
    aiThinking: true,
    aiThinkingText: '',
    aiQueryInFlight: false,
    knownDevUrls: [],
    projectsList: [],
    indexingProjectId: 'p1',
    workspace: [],
    commandPending: true,
    dashboardSignals: 0,
    appendedOutput: [],
    toolCalls: [],
    fetchProcessCount: 0,
    clipText: '',
    updateNotice: null,
    toolPanelOpen: false,
    activeToolPanel: null,
    ws: { _streamId: null },
  };
  const tokenBuffer: { current: string } = { current: '' };
  const flushTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
  const streamHadTokenRef: { current: boolean } = { current: false };

  const ctx: WsCtx = {
    wsRef: { current: state.ws },
    sessions: {
      setMessages: (updater: any) => {
        const next = typeof updater === 'function' ? updater(state.msgs) : updater;
        state.msgs = next;
      },
    },
    terminal: {
      setPendingConfirm: (v: any) => { state.pendingConfirm = v; },
      setPendingToolConfirm: (v: any) => { state.pendingToolConfirm = v; },
      setPendingMemorySuggestion: (v: any) => { state.pendingMemorySuggestion = v; },
    },
    ai: {
      setAiEnabled: (v: any) => { state.aiEnabled = typeof v === 'function' ? v(state.aiEnabled) : v; },
      setAiModel: (v: any) => { state.aiModel = typeof v === 'function' ? v(state.aiModel) : v; },
      setAiMode: (v: any) => { state.aiMode = typeof v === 'function' ? v(state.aiMode) : v; },
      setAiThinking: (v: any) => { state.aiThinking = typeof v === 'function' ? v(state.aiThinking) : v; },
      setAiThinkingText: (v: any) => { state.aiThinkingText = typeof v === 'function' ? v(state.aiThinkingText) : v; },
      get aiQueryInFlight() { return state.aiQueryInFlight; },
      setAiQueryInFlight: (v: any) => { state.aiQueryInFlight = typeof v === 'function' ? v(state.aiQueryInFlight) : v; },
    },
    projects: {
      get projects() { return state.projectsList; }, // live read — mirrors the orchestrator's fresh ctx per event
      setProjects: (u: any) => { state.projectsList = typeof u === 'function' ? u(state.projectsList) : u; },
      setActiveProject: (u: any) => { state.activeProject = typeof u === 'function' ? u(state.activeProject) : u; },
      setIndexingProjectId: (u: any) => { state.indexingProjectId = typeof u === 'function' ? u(state.indexingProjectId) : u; },
    },
    workspace: {
      setWorkspaceProjects: (u: any) => { state.workspace = typeof u === 'function' ? u(state.workspace) : u; },
    },
    stream: { tokenBuffer, flushTimer, streamHadTokenRef },
    commandPending: {
      setCommandPending: (v: any) => { state.commandPending = typeof v === 'function' ? v(state.commandPending) : v; },
    },
    setDashboardUpdateSignal: (u: any) => { state.dashboardSignals = u(state.dashboardSignals); },
    setKnownDevUrls: (u: any) => { state.knownDevUrls = typeof u === 'function' ? u(state.knownDevUrls) : u; },
    appendProcessOutput: (text: string) => { state.appendedOutput.push(text); },
    addToolCall: (tool: string, args: any, result: any) => { state.toolCalls.push({ tool, args, result }); },
    fetchProcesses: () => { state.fetchProcessCount++; },
    setUpdateNotice: (v: any) => { state.updateNotice = typeof v === 'function' ? v(state.updateNotice) : v; },
    toolPanel: {
      setActiveToolPanel: (v: any) => { state.activeToolPanel = typeof v === 'function' ? v(state.activeToolPanel) : v; },
      setToolsOpen: (v: any) => { state.toolPanelOpen = typeof v === 'function' ? v(state.toolPanelOpen) : v; },
    },
  };
  return { ctx, state, tokenBuffer, flushTimer, streamHadTokenRef };
}

const dispatch = (ctx: WsCtx, type: string, payload: any) => {
  // The real app sends the whole message object as the payload — `type` is a property of it.
  WS_MESSAGE_CASES[type]?.(ctx, { type, ...payload });
};
const last = (state: any) => state.msgs[state.msgs.length - 1];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  // Completeness: every WS event type the app emits must have a handler.
  const ALL_TYPES = [
    'answer', 'output', 'start', 'end', 'error_output', 'warning', 'suggestions',
    'did_you_mean', 'clear_console', 'confirm_prompt', 'projects_updated',
    'project_updated', 'ai_status', 'ai_start', 'thinking', 'tool_start',
    'tool_confirm_prompt', 'task_granted', 'memory_suggestion', 'tool_result',
    'workspace_updated', 'server_url', 'copy_to_clipboard', 'dashboard_update',
    'processes_update', 'learning_suggestion', 'stream_start', 'token', 'stream_end',
    'update_available', 'semantic_matcher_progress', 'display_name_set',
  ];
  for (const t of ALL_TYPES) check(`case registered: ${t}`, typeof WS_MESSAGE_CASES[t] === 'function');

  // --- CLI parity (Phase 0) ---
  // cli-client.js can't be imported (it executes main() and pulls in cowsay/boxen/figlet), so
  // parse its switch labels from source. A WS_CORE_CASES key with no `case 'x':` in the CLI —
  // rendered or explicit no-op — is a message the CLI silently drops. cli-client.js uses single
  // quotes exclusively; fallthrough groupings like `case 'a': case 'b': break;` match too.
  const cliSource = readFileSync(BASE + 'server/cli-client.js', 'utf8');
  const cliCases = new Set<string>();
  for (const m of cliSource.matchAll(/\bcase\s+'([^']+)'\s*:/g)) cliCases.add(m[1]);
  for (const key of Object.keys(WS_CORE_CASES)) {
    check(`CLI has a case for WS type: ${key}`, cliCases.has(key));
  }

  // --- answer ---
  let c = makeFakeCtx();
  dispatch(c.ctx, 'answer', { data: 'hello' });
  check('answer appends bot bubble', last(c.state).type === 'bot' && last(c.state).content === 'hello' && last(c.state).isMarkdown === true);
  check('answer clears aiThinking', c.state.aiThinking === false);
  dispatch(c.ctx, 'answer', { data: '   ' });
  check('answer whitespace-only ignored', c.state.msgs.length === 1);

  // --- answer + openPanel (Phase 1.5 tool-panel opener) ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'answer', { data: 'open calculator note', openPanel: 'calculator' });
  check('answer with openPanel switches the Tools view to that panel', c.state.toolPanelOpen === true && c.state.activeToolPanel === 'calculator');
  check('answer with openPanel still appends the plain-text bubble', last(c.state).type === 'bot' && last(c.state).content === 'open calculator note');
  dispatch(c.ctx, 'answer', { data: 'plain' });
  check('answer without openPanel leaves Tools view untouched', c.state.toolPanelOpen === true && c.state.activeToolPanel === 'calculator');

  // --- output/start/end stream ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'start', { data: 'npm run dev' });
  check('start opens output block', last(c.state).type === 'output' && last(c.state).content === 'npm run dev');
  check('start does not clear commandPending', c.state.commandPending === true);
  dispatch(c.ctx, 'output', { data: 'VITE ready' });
  check('output appends into open block', last(c.state).content === 'npm run dev\nVITE ready');
  check('output feeds dock log', c.state.appendedOutput.includes('VITE ready'));
  dispatch(c.ctx, 'end', { data: 'done' });
  check('end appends + clears commandPending', last(c.state).content === 'npm run dev\nVITE ready\ndone' && c.state.commandPending === false);
  c = makeFakeCtx();
  dispatch(c.ctx, 'output', { data: 'orphan' });
  check('output without open block creates one', last(c.state).type === 'output' && last(c.state).content === 'orphan');

  // --- error_output / warning ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'error_output', { data: 'boom', switchProjectAction: { projectId: 'p9', projectName: 'P9' } });
  check('error_output -> error bubble + switch action', last(c.state).type === 'error' && last(c.state).switchProjectAction?.projectId === 'p9');
  check('error_output clears busy + feeds dock', c.state.commandPending === false && c.state.appendedOutput.at(-1) === 'boom');
  dispatch(c.ctx, 'warning', { data: 'notice' });
  check('warning -> warning bubble', last(c.state).type === 'warning' && last(c.state).content === 'notice');

  // --- suggestions / did_you_mean ---
  c = makeFakeCtx();
  c.state.msgs.push({ id: 'm0', type: 'bot', content: 'hi' }); // seed — chips attach to the last bubble
  dispatch(c.ctx, 'suggestions', { data: ['a', 'b'] });
  check('suggestions attach to last bubble', last(c.state).suggestions?.length === 2);
  dispatch(c.ctx, 'did_you_mean', { data: { intent: 'run_project', confidence: 0.6 } });
  check('did_you_mean attaches to last bubble', last(c.state).didYouMean?.intent === 'run_project');

  // --- clear_console ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'clear_console', {});
  check('clear_console empties chat + clears busy', c.state.msgs.length === 0 && c.state.commandPending === false);

  // --- confirm_prompt ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'confirm_prompt', { token: 't1', command: 'git push' });
  check('confirm_prompt -> pendingConfirm + clears busy', c.state.pendingConfirm?.token === 't1' && c.state.pendingConfirm?.command === 'git push' && c.state.commandPending === false);

  // --- projects_updated / project_updated ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'projects_updated', { data: [{ id: 'p1' }, { id: 'p2' }] });
  check('projects_updated replaces list', c.state.projectsList.length === 2);
  c = makeFakeCtx();
  c.state.projectsList = [{ id: 'p1', name: 'old' }];
  c.state.indexingProjectId = 'p1';
  dispatch(c.ctx, 'project_updated', { data: { id: 'p1', name: 'new' } });
  check('project_updated maps entry + clears index flag', c.state.projectsList[0].name === 'new' && c.state.indexingProjectId === null);

  // --- ai_status / ai_start / thinking ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'ai_status', { data: { enabled: true, model: 'm1', mode: 'default' } });
  check('ai_status applies all three', c.state.aiEnabled === true && c.state.aiModel === 'm1' && c.state.aiMode === 'default');
  c.state.aiThinkingText = 'x';
  dispatch(c.ctx, 'ai_start', {});
  check('ai_start thinks + clears text', c.state.aiThinking === true && c.state.aiThinkingText === '');
  check('ai_start arms aiQueryInFlight', c.state.aiQueryInFlight === true);
  dispatch(c.ctx, 'thinking', { data: ' hmm' });
  check('thinking appends text', c.state.aiThinkingText === ' hmm');

  // --- output blocks during an AI turn auto-expand; trigger-mode blocks stay collapsed ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'ai_start', {});
  dispatch(c.ctx, 'start', { data: 'venv\\Scripts\\python.exe main.py watch --interval 5' });
  check('output block created during AI turn starts expanded', last(c.state).autoExpand === true);
  dispatch(c.ctx, 'stream_end', {});
  check('stream_end keeps aiQueryInFlight (turn not over — tool rounds may follow)', c.state.aiQueryInFlight === true);
  dispatch(c.ctx, 'start', { data: 'npm run dev' });
  check('output block between stream_end and final end still auto-expands', last(c.state).autoExpand === true);
  dispatch(c.ctx, 'end', { data: 'summarizer callout' });
  check('mid-turn end with data does not clear aiQueryInFlight', c.state.aiQueryInFlight === true);
  dispatch(c.ctx, 'end', {});
  check('data-less final end clears aiQueryInFlight', c.state.aiQueryInFlight === false);
  dispatch(c.ctx, 'start', { data: 'git push' });
  check('output block after AI turn stays collapsed', last(c.state).autoExpand !== true && last(c.state).type === 'output');
  c = makeFakeCtx();
  dispatch(c.ctx, 'ai_start', {});
  dispatch(c.ctx, 'thinking', { data: ' hmm' });
  dispatch(c.ctx, 'end', {});
  check('final end clears reasoning trace', c.state.aiThinkingText === '');

  // --- server_url feeds knownDevUrls (the chip gate) ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'server_url', { data: 'http://localhost:5000' });
  check('server_url -> bot bubble', last(c.state).type === 'bot' && last(c.state).content.includes('http://localhost:5000'));
  check('server_url records known dev URL', c.state.knownDevUrls.includes('http://localhost:5000'));
  dispatch(c.ctx, 'server_url', { data: 'http://localhost:5000' });
  check('server_url dedupes known URLs', c.state.knownDevUrls.length === 1);

  // --- tool_start / tool_confirm_prompt / task_granted / memory_suggestion / tool_result ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'tool_start', { data: 'git push' });
  check('tool_start -> system line', last(c.state).type === 'system' && last(c.state).content === '⚙ git push');
  dispatch(c.ctx, 'tool_confirm_prompt', { token: 't2', tool: 'writeFile', args: { path: 'a' } });
  check('tool_confirm_prompt -> pendingToolConfirm', c.state.pendingToolConfirm?.tool === 'writeFile');
  dispatch(c.ctx, 'task_granted', {});
  check('task_granted -> system line', last(c.state).content.includes('Approved this task'));
  dispatch(c.ctx, 'memory_suggestion', { data: { type: 'question_repeat', topic: 't' } });
  check('memory_suggestion -> pendingMemorySuggestion', c.state.pendingMemorySuggestion?.type === 'question_repeat');
  dispatch(c.ctx, 'tool_result', { data: { tool: 'readFile', args: { path: 'a' }, result: 'content' } });
  check('tool_result records call + system line', c.state.toolCalls.length === 1 && c.state.toolCalls[0].tool === 'readFile' && last(c.state).content.startsWith('⚙ Tool: readFile'));

  // --- workspace_updated ---
  c = makeFakeCtx();
  c.state.projectsList = [{ id: 'w1', name: 'W' }];
  dispatch(c.ctx, 'workspace_updated', { data: { projectIds: ['w1', 'gone'] } });
  check('workspace_updated resolves known ids only', c.state.workspace.length === 1 && c.state.workspace[0].name === 'W');

  // --- server_url / copy_to_clipboard / dashboard_update / processes_update ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'server_url', { data: 'http://localhost:3001' });
  check('server_url -> bot bubble', last(c.state).type === 'bot' && last(c.state).content.includes('http://localhost:3001'));
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t: string) => { c.state.clipText = t; } } },
    configurable: true,
  });
  dispatch(c.ctx, 'copy_to_clipboard', { data: 'C:\\path' });
  await sleep(10);
  check('copy_to_clipboard copies + confirms', c.state.clipText === 'C:\\path' && last(c.state).content.includes('Copied to clipboard'));
  dispatch(c.ctx, 'dashboard_update', {});
  check('dashboard_update bumps signal', c.state.dashboardSignals === 1);
  dispatch(c.ctx, 'processes_update', {});
  check('processes_update refetches dock', c.state.fetchProcessCount === 1);

  // --- learning_suggestion ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'learning_suggestion', { data: { suggestions: [] } });
  check('learning_suggestion empty', last(c.state).content.includes('No learning suggestions yet'));
  dispatch(c.ctx, 'learning_suggestion', { data: { suggestions: [{ intent: 'x', confidence: 'high', count: 5, accepted: 4, rejected: 1, phrases: ['a', 'b'] }] } });
  check('learning_suggestion formatted + chips', last(c.state).content.includes('### Learning Suggestions') && last(c.state).suggestions?.[0] === 'approve 1');
  dispatch(c.ctx, 'learning_suggestion', {});
  check('learning_suggestion malformed (no suggestions) does not throw', last(c.state).content.includes('No learning suggestions yet'));

  // --- streaming trio ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'stream_start', {});
  check('stream_start opens placeholder + sets _streamId', last(c.state).type === 'bot' && last(c.state).streaming === true && c.state.ws._streamId !== null);
  check('stream_start clears aiThinking', c.state.aiThinking === false);
  dispatch(c.ctx, 'token', { data: 'Hel' });
  dispatch(c.ctx, 'token', { data: 'lo' });
  check('token marks streamHadToken', c.streamHadTokenRef.current === true);
  await sleep(50);
  check('token flush appends into placeholder', last(c.state).content === 'Hello');
  dispatch(c.ctx, 'stream_end', {});
  check('stream_end clears streaming + id', last(c.state).streaming === false && c.state.ws._streamId === null);
  dispatch(c.ctx, 'token', { data: 'stray' });
  await sleep(20);
  check('token without stream id ignored', last(c.state).content === 'Hello');
  c = makeFakeCtx();
  dispatch(c.ctx, 'stream_start', {});
  dispatch(c.ctx, 'token', { data: 'abc' });
  await sleep(50);
  dispatch(c.ctx, 'stream_end', {});
  check('stream_end keeps real content', last(c.state).content === 'abc');
  c = makeFakeCtx();
  dispatch(c.ctx, 'stream_start', {});
  dispatch(c.ctx, 'stream_end', {});
  check('stream_end empty -> fallback text', last(c.state).content === '(AI returned no response — try rephrasing your request.)');
  check('stream_end resets streamHadToken', c.streamHadTokenRef.current === false);

  // --- update_available (Phase 5 banner) ---
  c = makeFakeCtx();
  dispatch(c.ctx, 'update_available', { data: { current: '1.0.1', latest: '1.0.2' } });
  check('update_available sets banner state', c.state.updateNotice?.current === '1.0.1' && c.state.updateNotice?.latest === '1.0.2');
  check('update_available never touches chat', c.state.msgs.length === 0);
  dispatch(c.ctx, 'update_available', { data: { current: '1.0.2' } });
  check('update_available malformed ignored', c.state.updateNotice?.latest === '1.0.2');

  // --- unknown type is a no-op ---
  c = makeFakeCtx();
  const before = c.state.msgs.length;
  dispatch(c.ctx, 'banana_event', { data: 'x' });
  check('unknown type no-op', c.state.msgs.length === before);

  console.log(`check-ws-cases: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('check-ws-cases crashed:', err);
  process.exit(1);
});
