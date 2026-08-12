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
import fs from 'fs';
import os from 'os';

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
const { generalFileHandlers, performTidy, planDuplicateDeletes, performDuplicateDeletes, extractFindQuery } = await import(pathToFileURL(base + 'wsHandlers/builtinGeneralFiles.js').href);
const { toolsHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinTools.js').href);
const { pdfHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinPdfTools.js').href);
const { reminderHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinReminders.js').href);
const { noteHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinNotes.js').href);
const { csvHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinCsvTools.js').href);
const { clipboardHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinClipboard.js').href);
const { backupHandlers } = await import(pathToFileURL(base + 'wsHandlers/builtinBackup.js').href);
const { parseReminderInput } = await import(pathToFileURL(base + 'schedules/reminderParser.js').href);
const {
  parsePdfNames, parsePdfOutput, parsePageSpec, extractWatermarkText,
  resolvePdfInput, listPdfFiles, mergePdfs, extractPages, watermarkPdf,
} = await import(pathToFileURL(base + 'pdfKit.js').href);
const { PDFDocument } = await import('pdf-lib');
const { revertAction, listActions } = await import(pathToFileURL(base + 'actionHistory.js').href);
const { BUILTIN_INTENTS, WORKSPACE_DEV_ONLY_INTENTS, intentWorkspaceEligible } = await import(pathToFileURL(base + 'intentRegistry.js').href);
const { detectWorkspaceType, isRecognizableByCodeAlone } = await import(pathToFileURL(base + 'projectScanHelpers.js').href);
const { handleModeCommand } = await import(pathToFileURL(base + 'wsHandlers/connectionModeAdmin.js').href);
const { INTENTS } = await import(pathToFileURL(base + 'intentsData.js').href);
const { state, pendingConfirmations } = await import(pathToFileURL(base + 'state.js').href);

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

const merged = { ...gitHandlers, ...chitChatHandlers, ...fileNpmHandlers, ...projectKnowledgeHandlers, ...projectContextHandlers, ...projectActionHandlers, ...diagnosticsHandlers, ...generalFileHandlers, ...toolsHandlers, ...pdfHandlers, ...reminderHandlers, ...noteHandlers, ...csvHandlers, ...clipboardHandlers, ...backupHandlers };
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
eq('chitchat leaf: how_do_i answers from the command catalog', ws.sent.length === 2 && ws.sent[0].type === 'answer' && /export/i.test(ws.sent[0].data) && /chat header download icon/.test(ws.sent[0].data), true);
eq('chitchat leaf: how_do_i emits suggestion chips after the answer', ws.sent[1].type === 'suggestions' && ws.sent[1].data.includes('chat header download icon'), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.needs_ai_mode', 'make me a landing page', proj, {});
eq('chitchat leaf: needs_ai_mode guidance names the AI dock with a concrete instruction', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /AI dock/.test(ws.sent[0].data) && /write it for you/.test(ws.sent[0].data), true);

// Phase 1.5 (2026-08-11): tool-panel openers. The answer must carry the additive `openPanel`
// field on the SAME 'answer' payload (never a new WS type), stay plain-text-usable for the CLI,
// and the calculator opener must attach chat-command chips after the answer.
sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_calculator', 'open calculator', proj, {});
eq('tools leaf: open_calculator answers with openPanel on the answer payload', ws.sent.length === 2 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'calculator' && /calculate 15% of 80/.test(ws.sent[0].data), true);
eq('tools leaf: open_calculator attaches chat-command chips', ws.sent[1].type === 'suggestions' && ws.sent[1].data.includes('calculate 15% of 80'), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_pdf_tools', 'open pdf tools', proj, {});
eq('tools leaf: open_pdf_tools answers with openPanel + CLI-usable text', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'pdf-tools' && /web-UI panel/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_reminders', 'open reminders', proj, {});
eq('tools leaf: open_reminders answers with openPanel + CLI-usable reminder list', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'reminders' && /Current reminders/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_file_tools', 'open file tools', proj, {});
eq('tools leaf: open_file_tools answers with openPanel + CLI-usable text', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'file-tools' && /find files matching/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_notes', 'open notes', proj, {});
eq('tools leaf: open_notes answers with openPanel + CLI-usable text', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'notes' && /note: buy milk/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_csv_tools', 'open spreadsheet', proj, {});
eq('tools leaf: open_csv_tools answers with openPanel + CLI-usable text', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'csv-tools' && /sum column sales/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_clipboard', 'open clipboard', proj, {});
eq('tools leaf: open_clipboard answers with openPanel + CLI-usable text', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'clipboard' && /show clipboard history/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'system.tools.open_backup', 'open backup', proj, {});
eq('tools leaf: open_backup answers with openPanel + CLI-usable text', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'backup' && /backup this folder/.test(ws.sent[0].data), true);

sent.length = 0;
const unknown = await handleBuiltinIntent(ws, 'no_such_intent', 'x', proj, {});
eq('unknown intent -> false, nothing sent', unknown === false && ws.sent.length === 0, true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.knowledge.how_to_run', 'how do i run this', proj, {});
eq('knowledge leaf: how_to_run shows example phrasings (nothing documented on fixture)', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /Try saying/.test(ws.sent[0].data), true);

sent.length = 0;
await handleBuiltinIntent(ws, 'project.code.search', 'where do we handle retries', proj, {});
// Phase 7: the fixture has no embedding model loaded (semanticMatcher never initialized in
// this harness), so the code-search handler must answer the clean unavailable path — never
// crash, never touch the fixture's non-existent project dir.
eq('knowledge leaf: code.search answers unavailable without the embedding model', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /embedding model/.test(ws.sent[0].data), true);

// --- WORKSPACE TYPE (Phase 1, 2026-08-11) -------------------------------------
// Eligibility is pure, so it's unit-assertable here. The key regression guard is the sync
// check: the dev-only tag list must never name an intent that left BUILTIN_INTENTS — a stale
// tag would silently stop filtering (same failure mode as a handlerless intent).
eq('workspace: dev-only tag list stays inside BUILTIN_INTENTS', [...WORKSPACE_DEV_ONLY_INTENTS].filter((k) => !BUILTIN_INTENTS.has(k)), []);
eq('workspace: general hides git_push from suggestions', intentWorkspaceEligible('git_push', 'general'), false);
eq('workspace: dev shows git_push', intentWorkspaceEligible('git_push', 'dev'), true);
eq('workspace: general hides code.search', intentWorkspaceEligible('project.code.search', 'general'), false);
eq('workspace: general hides deploy (checkpoint+push)', intentWorkspaceEligible('system.chit_chat.deploy', 'general'), false);
eq('workspace: general keeps chit-chat greeting', intentWorkspaceEligible('system.chit_chat.greeting', 'general'), true);
eq('workspace: general keeps file CRUD', intentWorkspaceEligible('file_append', 'general'), true);
eq('workspace: general keeps project actions', intentWorkspaceEligible('project.action.open_file', 'general'), true);
eq('workspace: general keeps knowledge intents', intentWorkspaceEligible('project.knowledge.overview', 'general'), true);
eq('workspace: no workspaceType -> everything eligible', intentWorkspaceEligible('git_push', undefined), true);

const idxDev = { totalFiles: 3, hasRealCode: true, keyFiles: {}, hasGit: false };
const idxGitOnly = { totalFiles: 1, hasRealCode: false, keyFiles: {}, hasGit: true };
const idxEmpty = { totalFiles: 0, hasRealCode: false, keyFiles: {}, hasGit: false };
// Phase 3 (2026-08-11): document-only folders are recognizable (PDF toolkit) but classify
// 'general', never 'dev'; a code folder carrying PDFs stays 'dev'.
const idxPdfOnly = { totalFiles: 2, hasRealCode: false, keyFiles: {}, hasGit: false, documentCount: 2 };
const idxCodePlusPdf = { totalFiles: 5, hasRealCode: true, keyFiles: {}, hasGit: false, documentCount: 2 };
eq('detect: code folder (hasRealCode) -> dev', detectWorkspaceType(null, idxDev), 'dev');
eq('detect: git-only folder -> dev', detectWorkspaceType(null, idxGitOnly), 'dev');
eq('detect: empty doc folder -> general', detectWorkspaceType(null, idxEmpty), 'general');
eq('detect: override wins over heuristic', detectWorkspaceType({ workspaceType: 'general' }, idxDev), 'general');
eq('detect: invalid override dropped, heuristic used', detectWorkspaceType({ workspaceType: 'prod' }, idxDev), 'dev');
eq('detect: pdf-only folder -> general (Phase 3)', detectWorkspaceType(null, idxPdfOnly), 'general');
eq('detect: code + pdfs stays dev (Phase 3)', detectWorkspaceType(null, idxCodePlusPdf), 'dev');
eq('detect: pdf-only folder is recognizable (Phase 3)', isRecognizableByCodeAlone(idxPdfOnly), true);
eq('detect: junk-only folder still unrecognizable', isRecognizableByCodeAlone({ totalFiles: 2, hasRealCode: false, keyFiles: {}, hasGit: false }), false);

// The admin tier WRITES console.config.json, so it is exercised against a real temp dir (the
// C:/tmp/nowhere fixture above must never receive files). broadcast() is a no-op here — the
// harness's wss has no clients.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-mode-'));
const tmpProj = {
  id: 'mode-p', name: 'ModeProj', path: tmpRoot, workspaceType: 'dev',
  config: { projectName: 'ModeProj', entries: [] }, contextFiles: [],
  parsedKnowledge: {}, codebaseIndex: { languages: [], keyFiles: {} },
};
sent.length = 0;
const switched = await handleModeCommand(ws, tmpProj, 'switch to general mode');
const written = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'console.config.json'), 'utf-8'));
eq('mode admin: switch to general mode consumed', switched, true);
eq('mode admin: answer confirms the switch', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].data.includes('general mode'), true);
eq('mode admin: console.config.json override persisted', written.workspaceType, 'general');
eq('mode admin: in-memory project updated', tmpProj.workspaceType, 'general');
sent.length = 0;
const same = await handleModeCommand(ws, tmpProj, 'switch to general mode');
eq('mode admin: re-switching to the same mode says already', same === true && ws.sent.length === 1 && ws.sent[0].data.includes('already'), true);
sent.length = 0;
const what = await handleModeCommand(ws, tmpProj, 'what mode am i in');
eq('mode admin: what mode am i in answers', what === true && ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].data.includes('general'), true);
sent.length = 0;
const notMode = await handleModeCommand(ws, tmpProj, 'run the tests');
eq('mode admin: unrelated input not consumed', notMode === false && ws.sent.length === 0, true);
fs.rmSync(tmpRoot, { recursive: true, force: true });

// --- GENERAL FILE TOOLS (Phase 2, 2026-08-11) --------------------------------
// Dispatch shapes against the C:/tmp/nowhere fixture (nonexistent dir — walkDir degrades to
// [] there, so every answer is deterministic and no real files are ever touched):
sent.length = 0;
await handleBuiltinIntent(ws, 'general.files.find', 'search my files for budget', proj, {});
eq('general files leaf: find answers no-hits on empty walk', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /budget/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'general.files.tidy', 'tidy this folder', proj, {});
eq('general files leaf: tidy on unreadable dir answers error, never confirms', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /Could not read the folder/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'general.files.duplicates', 'find duplicate files', proj, {});
eq('general files leaf: duplicates answers none on empty walk', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No duplicate files/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'general.files.duplicates_delete', 'delete duplicates keep newest', proj, {});
eq('general files leaf: duplicates_delete answers none on empty walk', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /nothing to delete/.test(ws.sent[0].data), true);

// extractFindQuery unit shapes (the parse contract, independent of the fs fixtures):
eq('find parse: search my files for budget -> content', extractFindQuery('search my files for budget'), { type: 'content', query: 'budget' });
eq('find parse: find files matching invoice -> content', extractFindQuery('find files matching invoice'), { type: 'content', query: 'invoice' });
eq('find parse: search for rent in my files -> content', extractFindQuery('search for rent in my files'), { type: 'content', query: 'rent' });
eq('find parse: find files named like report -> name', extractFindQuery('find files named like report'), { type: 'name', query: 'report' });
eq('find parse: unparseable input -> null', extractFindQuery('find my files'), null);

// Behavior smoke against a real temp dir (like the mode-command smoke above): tidy moves +
// actionHistory file_move journaling + revert moves it back; duplicates delete keeps the
// newest and its revert restores the deleted copy. The confirm_prompt itself is emitted by the
// handler; these assertions drive the perform* side directly (the same functions the confirm
// branch in connectionConfirm.js calls).
const gRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-genfiles-'));
const gProj = {
  id: 'genfiles', name: 'GenFiles', path: gRoot, workspaceType: 'general',
  config: { projectName: 'GenFiles', entries: [] }, contextFiles: [],
  parsedKnowledge: {}, codebaseIndex: { languages: [], keyFiles: {} },
};
fs.writeFileSync(path.join(gRoot, 'pic.jpg'), 'jpeg-bytes');
fs.writeFileSync(path.join(gRoot, 'doc.pdf'), 'pdf-bytes');
fs.writeFileSync(path.join(gRoot, 'notes.txt'), 'hello notes');

sent.length = 0;
await handleBuiltinIntent(ws, 'general.files.tidy', 'tidy this folder', gProj, {});
eq('tidy: emits confirm_prompt with the move preview', ws.sent.length === 1 && ws.sent[0].type === 'confirm_prompt' && /pic\.jpg/.test(ws.sent[0].command), true);
const tidyPending = [...pendingConfirmations.values()].find((p) => p.generalFileOp?.kind === 'tidy');
eq('tidy: pending record carries the move plan', !!tidyPending && tidyPending.generalFileOp.moves.length === 3, true);
if (tidyPending) {
  const moved = await performTidy(gRoot, tidyPending.generalFileOp.moves);
  eq('tidy perform: files moved into category folders', moved.ok === true && moved.moved === 3 && fs.existsSync(path.join(gRoot, 'Images', 'pic.jpg')) && fs.existsSync(path.join(gRoot, 'Documents', 'doc.pdf')) && fs.existsSync(path.join(gRoot, 'Documents', 'notes.txt')), true);
  const moveAction = listActions(gRoot).find((a) => a.type === 'file_move' && a.from === 'pic.jpg');
  eq('tidy perform: move journaled as file_move action', !!moveAction && moveAction.to === 'Images/pic.jpg', true);
  const undone = await revertAction(gRoot, moveAction.id);
  eq('tidy revert: file moved back to root', undone.ok === true && fs.existsSync(path.join(gRoot, 'pic.jpg')) && !fs.existsSync(path.join(gRoot, 'Images', 'pic.jpg')), true);
}
fs.writeFileSync(path.join(gRoot, 'dup-b.txt'), 'same-content');
fs.writeFileSync(path.join(gRoot, 'dup-a.txt'), 'same-content');
fs.writeFileSync(path.join(gRoot, 'unique.txt'), 'unique-content');
const delPlan = await planDuplicateDeletes(gRoot);
eq('duplicates: plan deletes only the older copy', delPlan.length === 1 && delPlan[0] === 'dup-b.txt', true);
sent.length = 0;
await handleBuiltinIntent(ws, 'general.files.duplicates_delete', 'delete duplicates keep newest', gProj, {});
eq('duplicates_delete: emits confirm_prompt', ws.sent.length === 1 && ws.sent[0].type === 'confirm_prompt' && /dup-b\.txt/.test(ws.sent[0].command), true);
const delPending = [...pendingConfirmations.values()].find((p) => p.generalFileOp?.kind === 'duplicates_delete');
if (delPending) {
  const res = await performDuplicateDeletes(gRoot, delPending.generalFileOp.files);
  eq('duplicates perform: older copy deleted, newest kept', res.ok === true && res.deleted === 1 && !fs.existsSync(path.join(gRoot, 'dup-b.txt')) && fs.existsSync(path.join(gRoot, 'dup-a.txt')), true);
  const delAction = listActions(gRoot).find((a) => a.description.includes('Deleted duplicate'));
  eq('duplicates perform: deletion journaled with pre-image', !!delAction && delAction.existed === true && delAction.preContent === 'same-content', true);
  const restored = await revertAction(gRoot, delAction.id);
  eq('duplicates revert: deleted copy restored', restored.ok === true && fs.existsSync(path.join(gRoot, 'dup-b.txt')) && fs.readFileSync(path.join(gRoot, 'dup-b.txt'), 'utf-8') === 'same-content', true);
}
fs.rmSync(gRoot, { recursive: true, force: true });

// --- PDF TOOLKIT (Phase 3, 2026-08-11) ---------------------------------------
// Dispatch shapes against the C:/tmp/nowhere fixture (no PDFs exist there, so every answer is
// deterministic and no files are ever touched): parameter-less intents open the panel with
// the CLI-usable guide, named-but-missing files answer a clean error.
sent.length = 0;
await handleBuiltinIntent(ws, 'pdf.merge', 'merge these pdfs', proj, {});
eq('pdf leaf: merge without names opens the panel + guide', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'pdf-tools' && /merge these pdfs into combined\.pdf/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'pdf.extract_text', 'extract text from report.pdf', proj, {});
eq('pdf leaf: extract_text with a missing file answers not-found', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /Could not find/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'pdf.watermark', 'watermark the pdf with draft', proj, {});
eq('pdf leaf: watermark without names opens the panel + guide', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'pdf-tools' && /watermark/.test(ws.sent[0].data), true);

// Parse-contract unit shapes (independent of the fs fixtures):
eq('pdf parse: names exclude the output clause', parsePdfNames('merge a.pdf and b.pdf into c.pdf'), ['a.pdf', 'b.pdf']);
eq('pdf parse: names from a bare merge', parsePdfNames('merge these pdfs'), []);
eq('pdf parse: output captured', parsePdfOutput('merge a.pdf and b.pdf into combined.pdf'), 'combined.pdf');
eq('pdf parse: no output -> null', parsePdfOutput('split report.pdf at page 5'), null);
eq('pdf parse: per-page spec', parsePageSpec('split report.pdf into one file per page'), { kind: 'perPage' });
eq('pdf parse: range spec', parsePageSpec('extract pages 2-5 from x.pdf'), { kind: 'range', from: 2, to: 5 });
eq('pdf parse: at-page spec', parsePageSpec('split report.pdf at page 3'), { kind: 'at', page: 3 });
eq('pdf parse: no page spec -> null', parsePageSpec('merge these pdfs'), null);
eq('pdf parse: watermark text after with', extractWatermarkText('watermark report.pdf with confidential'), 'confidential');
eq('pdf parse: watermark text strips the output clause first', extractWatermarkText('watermark report.pdf with draft into out.pdf'), 'draft');
eq('pdf parse: watermark without with -> null', extractWatermarkText('watermark report.pdf'), null);

// Behavior smoke against a real temp dir (same pattern as the general-file smoke): build real
// PDFs with pdf-lib, run merge/extract/watermark through pdfKit, and revert the journaled
// file_write entries so the created outputs are deleted.
const pdfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-pdf-'));
async function makeTestPdf(name, pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  fs.writeFileSync(path.join(pdfRoot, name), Buffer.from(await doc.save()));
}
await makeTestPdf('alpha.pdf', 2);
await makeTestPdf('beta.pdf', 1);
eq('pdf list: fixture PDFs listed sorted', listPdfFiles(pdfRoot).map((f) => f.name), ['alpha.pdf', 'beta.pdf']);
eq('pdf resolve: exact name', resolvePdfInput(pdfRoot, 'alpha.pdf').name, 'alpha.pdf');
eq('pdf resolve: stem match', resolvePdfInput(pdfRoot, 'alpha').name, 'alpha.pdf');
eq('pdf resolve: unknown -> null', resolvePdfInput(pdfRoot, 'nope.pdf'), null);
const pdfMerged = await mergePdfs(pdfRoot, ['alpha.pdf', 'beta.pdf'], 'combined.pdf');
eq('pdf merge: output created with 3 pages', pdfMerged.ok === true && pdfMerged.pages === 3 && fs.existsSync(path.join(pdfRoot, 'combined.pdf')), true);
const extracted = await extractPages(pdfRoot, 'alpha.pdf', 1, 1, 'excerpt.pdf');
eq('pdf extract pages: single-page excerpt', extracted.ok === true && extracted.pages === 1 && fs.existsSync(path.join(pdfRoot, 'excerpt.pdf')), true);
const wm = await watermarkPdf(pdfRoot, 'beta.pdf', 'confidential', 'beta-wm.pdf');
eq('pdf watermark: output created', wm.ok === true && fs.existsSync(path.join(pdfRoot, 'beta-wm.pdf')), true);
const noOverwrite = await mergePdfs(pdfRoot, ['alpha.pdf', 'beta.pdf'], 'combined.pdf');
eq('pdf safety: existing output refused, never overwritten', noOverwrite.ok === false && /already exists/.test(noOverwrite.error), true);
const createdActions = listActions(pdfRoot).filter((a) => a.type === 'file_write' && a.existed === false);
eq('pdf journal: created files journaled as file_write existed:false', createdActions.length === 3, true);
const revertOne = await revertAction(pdfRoot, createdActions[0].id);
eq('pdf revert: revert deletes the created output', revertOne.ok === true && !fs.existsSync(path.join(pdfRoot, createdActions[0].path)), true);
fs.rmSync(pdfRoot, { recursive: true, force: true });

// --- REMINDERS (Phase 4, 2026-08-12) ------------------------------------------
// Dispatch against the C:/tmp/nowhere fixture: create with no parseable when answers the
// ask-for-when guidance, list answers the empty state, cancel answers not-found — all
// deterministic, no schedule file writes (handlers fail before touching the store).
sent.length = 0;
await handleBuiltinIntent(ws, 'system.reminders.create', 'remind me to stretch', proj, {});
eq('reminder leaf: create without a when asks for one + opens panel', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'reminders' && /What should I remind you about/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.reminders.list', 'list my reminders', proj, {});
eq('reminder leaf: list answers the empty state', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No reminders/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.reminders.cancel', 'cancel reminder s9', proj, {});
eq('reminder leaf: cancel answers not-found', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No reminder/.test(ws.sent[0].data), true);

// Parse-contract unit shapes (pure, no store interaction; the recurrence types are the
// machine-independent part — fireAt/firstFireAt instants are only asserted as future).
const rOneshot = parseReminderInput('remind me tomorrow at 9am to renew my license');
eq('reminder parse: oneshot shape', rOneshot.ok === true && rOneshot.type === 'oneshot' && rOneshot.text === 'renew my license' && typeof rOneshot.fireAt === 'number' && rOneshot.fireAt > Date.now(), true);
const rWeekly = parseReminderInput('remind me every friday at 5pm to call the accountant');
eq('reminder parse: weekly shape', rWeekly.ok === true && rWeekly.type === 'weekly' && rWeekly.weekday === 5 && rWeekly.hour === 17 && rWeekly.minute === 0 && rWeekly.text === 'call the accountant', true);
const rDaily = parseReminderInput('remind me daily at 9am to drink water');
eq('reminder parse: daily shape', rDaily.ok === true && rDaily.type === 'daily' && rDaily.hour === 9 && rDaily.minute === 0 && rDaily.text === 'drink water', true);
const rInterval = parseReminderInput('remind me every 2 days at 8am to do pushups');
eq('reminder parse: interval with aligned first fire', rInterval.ok === true && rInterval.type === 'interval' && rInterval.everyMs === 2 * 24 * 60 * 60 * 1000 && rInterval.text === 'do pushups' && typeof rInterval.firstFireAt === 'number' && rInterval.firstFireAt > Date.now(), true);
const rTextFirst = parseReminderInput('remind me to water the plants at 8pm');
eq('reminder parse: text-first order', rTextFirst.ok === true && rTextFirst.type === 'oneshot' && rTextFirst.text === 'water the plants' && rTextFirst.fireAt > Date.now(), true);
const rNoWhen = parseReminderInput('remind me about the meeting');
eq('reminder parse: no when -> ask', rNoWhen.ok === false && /remind you about/.test(rNoWhen.reason), true);
const rPast = parseReminderInput('remind me yesterday at 9am to fix it');
eq('reminder parse: explicit past -> rejected', rPast.ok === false && /past/.test(rPast.reason), true);
const rGarbage = parseReminderInput('remind me blahblah to do the thing');
eq('reminder parse: unparseable when -> named error', rGarbage.ok === false && /blahblah/.test(rGarbage.reason), true);

// --- EXPANDED CALCULATOR (Phase 6, 2026-08-12) ---------------------------------
// mathEval.js unit + percentage grammars (pure, no store interaction):
const { convertUnits, percentageQuery, evaluateArithmetic } = await import(pathToFileURL(base + 'mathEval.js').href);
const kmToMiles = convertUnits('convert 5 km to miles');
eq('calc: convert km to miles ok', kmToMiles && kmToMiles.ok === true && Math.abs(kmToMiles.value - 3.10685596118667) < 1e-9, true);
const litersToCups = convertUnits('convert 2 liters to cups');
eq('calc: convert liters to cups ok', litersToCups && litersToCups.ok === true && Math.abs(litersToCups.value - 8.45350567546) < 1e-6, true);
const fToC = convertUnits('convert 100 fahrenheit to celsius');
eq('calc: convert fahrenheit to celsius ok', fToC && fToC.ok === true && Math.abs(fToC.value - 37.77777777777778) < 1e-9, true);
const badUnits = convertUnits('convert 5 km to seconds');
eq('calc: unknown units rejected', badUnits && badUnits.ok === false, true);
const pctOf = percentageQuery('15% of 80');
eq('calc: percent of ok', pctOf && pctOf.ok === true && pctOf.kind === 'percent-of' && pctOf.value === 12, true);
const tip = percentageQuery('18% tip on 64.50');
eq('calc: tip ok', tip && tip.ok === true && tip.kind === 'tip' && Math.abs(tip.value - 11.61) < 1e-9, true);
const tax = percentageQuery('add 8.25% tax to 120');
eq('calc: tax ok', tax && tax.ok === true && tax.kind === 'tax' && Math.abs(tax.value - 129.9) < 1e-9, true);
const plain = evaluateArithmetic('what is 12 times 7');
eq('calc: plain arithmetic still ok', plain.ok === true && plain.value === 84, true);

// Handler dispatch (no store writes — pure answer):
sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.calculate', 'convert 5 km to miles', proj, {});
eq('calc leaf: convert answers with the converted value', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /3\.106/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.calculate', 'what is 15% of 80', proj, {});
eq('calc leaf: percent-of answers 12', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /12/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.calculate', 'whats 18% tip on 64.50', proj, {});
eq('calc leaf: tip answers with tip amount', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /11\.61/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.chit_chat.calculate', 'add 8.25% tax to 120', proj, {});
eq('calc leaf: tax answers total incl tax', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /129\.9/.test(ws.sent[0].data), true);

// --- NOTES (Phase 5, 2026-08-12) ----------------------------------------------
// Dispatch shapes against the C:/tmp/nowhere fixture (append fails before writing anywhere):
sent.length = 0;
await handleBuiltinIntent(ws, 'system.notes.create', 'note:', proj, {});
eq('notes leaf: create without text asks + opens panel', ws.sent.length === 1 && ws.sent[0].type === 'answer' && ws.sent[0].openPanel === 'notes' && /What should the note say/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.notes.list', 'show my notes', proj, {});
eq('notes leaf: list answers empty state', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No notes yet/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'system.notes.search', 'search my notes for wifi', proj, {});
eq('notes leaf: search answers no-hits on empty store', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No notes match/.test(ws.sent[0].data), true);

// Temp-dir smoke: append -> list round trip -> search hit -> dedupe -> cap behavior.
const notesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-notes-'));
const notesProj = {
  id: 'notes-p', name: 'NotesProj', path: notesRoot, workspaceType: 'general',
  config: { projectName: 'NotesProj', entries: [] }, contextFiles: [],
  parsedKnowledge: {}, codebaseIndex: { languages: [], keyFiles: {} },
};
const { appendNote, listNotes } = await import(pathToFileURL(base + 'notesStore.js').href);
const n1 = await appendNote(notesRoot, 'buy milk');
eq('notes store: append succeeds', n1.success === true, true);
const n2 = await appendNote(notesRoot, 'call the dentist tomorrow');
eq('notes store: second append succeeds', n2.success === true, true);
const dup = await appendNote(notesRoot, 'buy milk');
eq('notes store: exact duplicate skipped', dup.success === true && /duplicate/.test(dup.data), true);
const listed = await listNotes(notesRoot);
eq('notes store: list has both entries oldest-first', listed.length === 2 && listed[0].text === 'buy milk' && listed[1].text === 'call the dentist tomorrow', true);
const notesFile = path.join(notesRoot, '.console', 'notes.md');
eq('notes store: file written under .console/notes.md', fs.existsSync(notesFile), true);
fs.rmSync(notesRoot, { recursive: true, force: true });

// --- CSV TOOLS (Phase 7, 2026-08-12) -------------------------------------------
// Engine unit shapes + a temp-dir smoke with a real CSV (dispatch through the handlers,
// which read the project path from the project object — all read-only).
const { parseCsv, loadCsv, findColumn, cellToNumber, matchOp } = await import(pathToFileURL(base + 'csvTools.js').href);
const parsed = parseCsv('a,b,c\n1,"two, words",3\n');
eq('csv parse: quoted field preserved', parsed.length === 2 && parsed[1][1] === 'two, words', true);
const parsedCrlf = parseCsv('x,y\r\n1,2\r\n');
eq('csv parse: crlf tolerated', parsedCrlf.length === 2 && parsedCrlf[1][1] === '2', true);
eq('csv cell number: $1,234.50', cellToNumber('$1,234.50'), 1234.5);
eq('csv op: equals case-insensitive', matchOp('equals', 'Done', 'done'), true);
eq('csv op: contains', matchOp('contains', 'north-east', 'north'), true);
eq('csv op: greater than', matchOp('greater than', '60', '50'), true);

const csvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-csv-'));
fs.writeFileSync(path.join(csvRoot, 'data.csv'), 'name,amount,status\nWidget,10,ok\nGadget,25,pending\nSprocket,15,ok\n');
const csvProj = {
  id: 'csv-p', name: 'CsvProj', path: csvRoot, workspaceType: 'general',
  config: { projectName: 'CsvProj', entries: [] }, contextFiles: [],
  parsedKnowledge: {}, codebaseIndex: { languages: [], keyFiles: {} },
};
sent.length = 0;
await handleBuiltinIntent(ws, 'csv.sum', 'sum column amount in data.csv', csvProj, {});
eq('csv leaf: sum answers 50', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /50/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'csv.average', 'average column amount in data.csv', csvProj, {});
eq('csv leaf: average answers 16.67', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /16\.67/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'csv.count', 'count rows in data.csv where status equals ok', csvProj, {});
eq('csv leaf: count answers 2', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /2/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'csv.filter', 'filter data.csv where amount greater than 10', csvProj, {});
eq('csv leaf: filter answers 2 matching rows', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /2.*matching/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'csv.sum', 'sum column missing in data.csv', csvProj, {});
eq('csv leaf: unknown column named', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /not found/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'csv.sum', 'sum column amount in nowhere.csv', csvProj, {});
eq('csv leaf: missing file named', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /not found/.test(ws.sent[0].data), true);
fs.rmSync(csvRoot, { recursive: true, force: true });

// --- CLIPBOARD + SNIPPETS (Phase 8, 2026-08-12) --------------------------------
// Dispatch shapes with the default profile (clipboardHistory OFF): show/clear answer the
// off-state honestly; snippet store is redirected to a temp file via SNIPPETS_FILE so the
// harness never touches the real data/snippets.json.
sent.length = 0;
await handleBuiltinIntent(ws, 'clipboard.show', 'show clipboard history', proj, {});
eq('clipboard leaf: show answers off-state', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /off/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'clipboard.copy_item', 'copy clipboard item 2', proj, {});
eq('clipboard leaf: copy item on empty history asks which', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /Which item/.test(ws.sent[0].data), true);
sent.length = 0;
await handleBuiltinIntent(ws, 'snippet.show', 'show my snippets', proj, {});
eq('snippet leaf: show answers empty state', ws.sent.length === 1 && ws.sent[0].type === 'answer' && /No snippets yet/.test(ws.sent[0].data), true);

const snippetsTmp = path.join(os.tmpdir(), `console-snippets-${Date.now()}.json`);
process.env.SNIPPETS_FILE = snippetsTmp;
const { saveSnippet, getSnippet, deleteSnippet, listSnippets } = await import(pathToFileURL(base + 'snippetStore.js').href + `?t=${Date.now()}`);
const s1 = saveSnippet('greeting', 'hello world');
eq('snippet store: save ok', s1.ok === true, true);
const s2 = saveSnippet('greeting', 'updated text');
eq('snippet store: re-save same name overwrites', s2.ok === true && getSnippet('greeting').text === 'updated text', true);
eq('snippet store: list has 1', listSnippets().length === 1, true);
eq('snippet store: delete ok', deleteSnippet('greeting').name === 'greeting' && listSnippets().length === 0, true);
eq('snippet store: delete missing -> null', deleteSnippet('nope'), null);
delete process.env.SNIPPETS_FILE;
try { fs.unlinkSync(snippetsTmp); } catch {}

// --- BACKUP (Phase 9, 2026-08-12) ---------------------------------------------
// Temp-dir smoke: create a zip of a scratch folder, assert the file exists, list it. The
// handler writes to data/backups (console-owned, gitignored) — the zip is created then
// removed so the harness never leaves artifacts.
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-backup-'));
fs.writeFileSync(path.join(backupRoot, 'a.txt'), 'hello');
fs.writeFileSync(path.join(backupRoot, 'b.txt'), 'world');
const backupProj = {
  id: 'backup-p', name: 'BackupProj', folderName: 'backup-p', path: backupRoot, workspaceType: 'general',
  config: { projectName: 'BackupProj', entries: [] }, contextFiles: [],
  parsedKnowledge: {}, codebaseIndex: { languages: [], keyFiles: {} },
};
const { createBackup, listBackups } = await import(pathToFileURL(base + 'backupStore.js').href);
const bk = await createBackup(backupProj, null);
eq('backup store: zip created ok', bk.ok === true && bk.file.endsWith('.zip') && fs.existsSync(bk.file), true);
eq('backup store: list finds it', listBackups(backupProj).length === 1, true);
const bkSub = await createBackup(backupProj, 'nope');
eq('backup store: missing subfolder refused', bkSub.ok === false, true);
if (bk.ok) { try { fs.unlinkSync(bk.file); } catch {} }
fs.rmSync(backupRoot, { recursive: true, force: true });

console.log(`check-handlers: ${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
