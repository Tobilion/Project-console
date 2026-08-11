/**
 * checkHandlerCoverage.js — committed regression harness for the builtin-intent handler layer
 * (Phase 10, 2026-08-04). Asserts against the REAL modules — the builtinIntents.js orchestrator
 * and its six leaf modules (builtinGit/builtinChitChat/builtinFileNpm/builtinProjectKnowledge/
 * builtinProjectContext/builtinProjectActions) plus intentRegistry.js's BUILTIN_INTENTS gate —
 * no server, no network, no Ollama, seconds to run.
 *
 * Run:  npm run check-handlers
 * Probe: node server/scripts/checkHandlerCoverage.js --probe  (prints actuals, no asserts)
 *
 * Same calibration flow as checkMatcherCoverage.js/checkIndexerCoverage.js/checkToolsCoverage.js.
 * Run after ANY edit to the builtin handler modules or to intentRegistry.js's BUILTIN_INTENTS.
 *
 * Batteries:
 *  - BIDIRECTIONAL: every handler key in the merged maps is a member of BUILTIN_INTENTS (the
 *    dispatch gate that has silently killed intents 5+ times), and every BUILTIN_INTENTS member
 *    has a handler (a registered-but-handlerless intent would dispatch to `return false`), and
 *    every INTENTS key is both in BUILTIN_INTENTS and in the handler maps (nothing unreachable).
 *  - ALIAS: the legacy bare 'undo' alias maps to system.chit_chat.undo.
 *  - DISPATCH: fake-ws smoke, one deterministic handler per leaf module + unknown-intent fallback.
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const PROBE = process.argv.includes('--probe');
// Derived from this script's own location, not hardcoded to one machine/username (audit
// 2026-08-10 — see checkMatcherCoverage.js for the full rationale).
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;

const { handleBuiltinIntent } = await import(pathToFileURL(base + 'wsHandlers/builtinIntents.js').href);
const { gitHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinGit.js').href);
const { chitChatHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinChitChat.js').href);
const { fileNpmHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinFileNpm.js').href);
const { projectKnowledgeHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinProjectKnowledge.js').href);
const { projectContextHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinProjectContext.js').href);
const { projectActionHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinProjectActions.js').href);
const { normalizeGithubPageUrl } = await import(pathToFileURL(base + 'wsHandlers/builtinProjectActions.js').href);
const { diagnosticsHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinDiagnostics.js').href);
const { BUILTIN_INTENTS } = await import(pathToFileURL(base + 'intentRegistry.js').href);
const { INTENTS } = await import(pathToFileURL(base + 'intentsData.js').href);
const { state } = await import(pathToFileURL(base + 'state.js').href);

let total = 0, failed = 0;
function eq(label, got, expect) {
  total++;
  const g = JSON.stringify(got);
  const e = JSON.stringify(expect);
  const ok = g === e;
  if (!ok) failed++;
  if (PROBE) console.log(`  ${String(label).padEnd(48)} -> ${g}`);
  else if (!ok) console.log(`  FAIL ${label}\n    expected: ${e}\n    got:      ${g}`);
}

const merged = { ...gitHandlers, ...chitChatHandlers, ...fileNpmHandlers, ...projectKnowledgeHandlers, ...projectContextHandlers, ...projectActionHandlers, ...diagnosticsHandlers };
const handlerKeys = Object.keys(merged).sort();
const builtinKeys = [...BUILTIN_INTENTS].sort();
const intentKeys = Object.keys(INTENTS).sort();

// --- BIDIRECTIONAL -----------------------------------------------------------
eq('handler count == BUILTIN_INTENTS count', handlerKeys.length, builtinKeys.length);
eq('INTENTS key count == BUILTIN_INTENTS count', intentKeys.length, builtinKeys.length);
eq('handlers - BUILTIN_INTENTS (should be [])', handlerKeys.filter((k) => !BUILTIN_INTENTS.has(k)), []);
eq('BUILTIN_INTENTS - handlers (should be [])', builtinKeys.filter((k) => !merged[k]), []);
eq('INTENTS - handlers (should be [])', intentKeys.filter((k) => !merged[k]), []);
eq('INTENTS - BUILTIN_INTENTS (should be [])', intentKeys.filter((k) => !BUILTIN_INTENTS.has(k)), []);
eq('BUILTIN_INTENTS - INTENTS (should be [])', builtinKeys.filter((k) => !INTENTS[k]), []);

// --- ALIAS -------------------------------------------------------------------
const undoAlias = await handleBuiltinIntent({ send: () => {} }, 'undo', 'undo', {}, {});
eq("'undo' alias dispatches to chit_chat.undo", undoAlias, true);

// --- DISPATCH (fake ws, one deterministic handler per leaf module) -----------
const sent = [];
const ws = { sent, readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
const proj = {
  id: 'p1', name: 'HProj', path: 'C:/tmp/nowhere', config: { entries: [] }, contextFiles: [],
  parsedKnowledge: { stack: 'Node' }, codebaseIndex: { languages: [], keyFiles: {} },
};
state.activeProjectsCache = [proj];
state.lastDevUrls = new Map();

sent.length = 0;
await handleBuiltinIntent(ws, 'git_remote_add', 'attach the github link', proj, {});
eq('git leaf: remote_add asks for URL', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /url/i.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.ack', 'nice', proj, {});
eq('chitchat leaf: ack answers', ws.sent.length === 1 && ws.sent[0].type === 'answer', true);

sent.length = 0;
await handleBuiltinIntent(ws, 'file_delete', 'delete t.txt', proj, {});
eq('file/npm leaf: file_delete answers AI-mode guidance', ws.sent.length === 1 && ws.sent[0].data.includes('AI mode'), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.knowledge.stack', 'stack', proj, {});
eq('knowledge leaf: stack answers from parsedKnowledge', ws.sent.length === 1 && ws.sent[0].data.includes('Node'), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.context.dev_server_status', 'is the server running', proj, {});
// Phase 15 calibration: since the Phase 14 common-ports fallback, a hint-less project with no
// tracked/recorded server is probed against COMMON_DEV_PORTS — on a machine where any of those
// ports is actually live (e.g. the console dev server or a site on :5000), the handler honestly
// reports "responding at ... started outside the console" instead of "has no server running".
// Both are valid answers; what's under test is the dispatch + single-answer shape, not the probe.
eq('context leaf: dev_server_status (nothing) answers running-or-not', ws.sent.length === 1 && ws.sent[0].type === 'answer' && (ws.sent[0].data.includes('has no server running') || ws.sent[0].data.includes('responding at')), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.action.copy_path', 'copy path', proj, {});
eq('actions leaf: copy_path emits clipboard + answer', ws.sent.length === 2 && ws.sent[0].type === 'copy_to_clipboard', true);

// Phase 16 (2026-08-05): two new deterministic dispatch shapes — open_github_page hits the
// isGitRepo gate first (fixture path is not a repo -> no-repo answer, no git subprocess needed
// for the assertion), and open_file with no parsed name asks. open_in_terminal / open_in_cursor
// spawn real processes so they're covered by the BIDIRECTIONAL gate only, same as open_in_vscode.
sent.length = 0;
await handleBuiltinIntent(ws, 'project.action.open_github_page', 'open the github page', proj, {});
eq('actions leaf: open_github_page on non-git project answers no-repo', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].data.includes('not a git repository'), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.action.open_file', 'open a file', proj, {});
eq('actions leaf: open_file without a name asks which file', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].data.includes('Which file'), true);

// --- NORMALIZER (Phase 16: GitHub remote URL -> repo page) --------------------
eq('normalizer: git@ ssh shape', normalizeGithubPageUrl('git@github.com:tobi/user-repo.git'), 'https://github.com/tobi/user-repo');
eq('normalizer: https with .git', normalizeGithubPageUrl('https://github.com/tobi/user-repo.git'), 'https://github.com/tobi/user-repo');
eq('normalizer: ssh:// scheme', normalizeGithubPageUrl('ssh://git@github.com/tobi/repo.git'), 'https://github.com/tobi/repo');
eq('normalizer: git:// scheme', normalizeGithubPageUrl('git://github.com/tobi/repo.git'), 'https://github.com/tobi/repo');
eq('normalizer: trailing slash stripped', normalizeGithubPageUrl('https://github.com/tobi/repo/'), 'https://github.com/tobi/repo');
eq('normalizer: non-github host -> null', normalizeGithubPageUrl('https://gitlab.com/tobi/x'), null);
eq('normalizer: ssh non-github host -> null', normalizeGithubPageUrl('git@gitlab.com:tobi/x.git'), null);
eq('normalizer: empty -> null', normalizeGithubPageUrl(''), null);
eq('normalizer: local path -> null', normalizeGithubPageUrl('C:/Users/tobil/foo'), null);

// Phase 5 (audit 2026-08-10): diagnostics leaf + git-maintenance leaf dispatch shapes.
sent.length = 0;
await handleBuiltinIntent(ws, 'project.diagnostics.env_check', 'check my env variables', proj, {});
eq('diagnostics leaf: env_check answers', ws.sent.length === 1 && ws.sent[0].type === 'answer', true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.diagnostics.dead_code', 'find dead code', proj, {});
eq('diagnostics leaf: dead_code answers (no symbol index on fixture)', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /no symbol index/i.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.diagnostics.test_coverage_report', 'what is my test coverage', proj, {});
eq('diagnostics leaf: coverage answers no-artifact (fixture has none)', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No coverage report/i.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.diagnostics.bundle_size_analysis', 'analyze bundle size', proj, {});
eq('diagnostics leaf: bundle answers no-output (fixture has none)', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No build output/i.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'git_branch_cleanup', 'clean up merged branches', proj, {});
eq('git leaf: branch_cleanup on non-git project answers no-repo', ws.sent.length === 1 && ws.sent[0].type === 'answer' && (ws.sent[0].data.includes('not a git repository') || ws.sent[0].data.includes("isn't a git repository")), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.how_do_i', 'how do i export this chat', proj, {});
eq('chitchat leaf: how_do_i answers from the command catalog', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /export/i.test(ws.sent[0].data) && /chat header download icon/.test(ws.sent[0].data), true);

sent.length = 0;
const unknown = await handleBuiltinIntent(ws, 'no_such_intent', 'x', proj, {});
eq('unknown intent -> false, nothing sent', unknown === false && ws.sent.length === 0, true);

console.log(`check-handlers: ${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
