/**
 * Dispatch registry for matcher.js (Phase 7 split, 2026-08-04 — extracted from matcher.js,
 * logic unchanged). Everything here is data/constants that gate what matchInput() may
 * dispatch, plus the human-readable intent label helper. BUILTIN_INTENTS is re-exported by
 * matcher.js so localRouter.js's import keeps working unchanged.
 */
import { INTENTS } from './intentsData.js';

// Human-readable label for an intent, used only to phrase a "did you mean X or Y?" disambiguation
// prompt (see BUILTIN_INTENTS' collision handling in matcher.js) — just the intent's own first
// example phrase, since every intent already has several natural-language examples and there's
// no separate display-name field to maintain in sync.
export function describeIntent(intent) {
  return INTENTS[intent]?.examples?.[0] || intent;
}

// Much smaller than ollamaContext.js's system-prompt cap (6000 chars) — the router is a single
// bounded classification call on CPU-only hardware (hard
// constraints), not a full conversation, so it only gets enough of the repo map to disambiguate
// a loose file reference, not the whole project.
export const ROUTER_REPO_MAP_CHARS = 1200;

// Phase-3 floor (2026-08-03, NetPulse transcript): a project's own hand-authored
// console.config.json `command` entry is preferred over the generic run_project / npm_run
// builtins when its best trigger phrase clears this embedding floor — project-specific run
// instructions should win over the builtin cluster's wildcard phrasing ("run the site" should
// reach NetPulse's own "run locally" -> `python main.py serve`, and "watch at interval of 5
// minutes" should reach its `watch --interval {interval}` entry). Chosen from measured cosine
// scores of real NetPulse inputs against its own triggers (see CLAUDE.md): 0.5 was unsafe —
// "run this project" scores 0.517 against the "test project" trigger and would have silently
// auto-run pytest; 0.55 clears that while still auto-running the true positives ("run the site
// and watch at interval of 5 minutes" 0.565 -> watch, "run the network speed" 0.721 -> watch,
// "run the tests" 0.825 -> pytest). Sub-floor run-family inputs ("run the site" 0.410, "run the
// server" 0.499) fall through to the builtin handler, where projectTypeSuggestions() surfaces
// the config entry as a suggestion chip instead (see CONFIG_SUGGESTION_FLOOR in
// builtinIntents.js). Lower than the builtin semantic floor by design, since only exact
// project-authored entries are ever eligible and they are per-project, not global.
export const CONFIG_RUN_ENTRY_FLOOR = 0.55;

// Confirmed via the Phase-3 harness (2026-08-03): bare "open the project" is a run_project seed
// phrase (miscIntents.js) that can score ≥ CONFIG_RUN_ENTRY_FLOOR against a project's own config
// entry (0.590 vs the harness "test project" trigger) and get silently diverted into running that
// specific command (pytest) instead of the generic open-the-dev-server run path — a surprising
// side effect, and exactly the kind of "it did something I didn't ask for" a shipping console
// shouldn't do. "open the project"/"open this project"/"launch the project" are unambiguous
// project-level phrases, not command requests, so they're exempted from the stage-1b config-entry
// redirect and always dispatch through generic run_project. Keep this narrow — the verified
// redirect cases ("run the site and watch at interval of 5 minutes" 0.565, "run the network speed"
// 0.721) all start with a run verb, never "open/launch ... project". Phase 9 (2026-08-11):
// "run/start the project" hit the same trap (0.564 vs the same "test project" trigger after the
// run-project override began routing it into the semantic stage) — run/start + the project noun
// are equally unambiguous project-level phrases, so they're exempt the same way; the run-verb
// redirect cases above all target site/speed nouns, which still redirect.
export const OPEN_PROJECT_RE = /^(?:open|launch|run|start)\s+(?:the\s+|this\s+)?project$/i;

// NOTE: file_append, file_read, and git_remote_add were previously missing from this set even
// though builtinIntents.js has real handlers for all three, and git_remote_add's whole reason
// for existing was a PRE_SEMANTIC_OVERRIDES literal-keyword hit in semanticMatcher.js (source:
// 'keyword', confidence 0.9) — but that override's result still had to pass this Set's gate at
// step 1b in matcher.js to actually dispatch, so it silently died there and fell through to the
// generic fallback every time despite CLAUDE.md documenting it as "fixed". Found while wiring the
// local-router tier (which also reads this Set as its allowed-intent list) — added all three so
// both the existing fast path and the new router tier can actually reach them.
export const BUILTIN_INTENTS = new Set([
  'system.chit_chat.greeting', 'system.chit_chat.status', 'system.chit_chat.gratitude',
  'system.chit_chat.clear', 'system.chit_chat.help', 'system.chit_chat.git_status',
  'system.chit_chat.explain_followup', 'system.chit_chat.undo', 'system.chit_chat.deploy',
  'system.chit_chat.yes_no', 'system.chit_chat.farewell', 'system.chit_chat.identity',
  'system.chit_chat.needs_ai_mode', 'system.chit_chat.ack', 'system.chit_chat.joke',
  'project.knowledge.overview', 'project.knowledge.stack', 'project.knowledge.commands',
  'project.knowledge.gotchas', 'project.knowledge.architecture',
  'project.context.structure', 'project.context.languages', 'project.context.file_count',
  'project.context.entry_point', 'project.context.tech_preview',
  'project.context.tests', 'project.context.dependencies', 'project.context.config',
  'project.context.routes', 'project.context.file_relations', 'project.context.monorepo',
  'project.context.todos', 'project.context.biggest_files', 'project.context.dev_server_status',
  'project.context.recent_activity', 'project.context.running_processes',
  'project.context.session_info', 'project.context.scan_servers',
  'run_project', 'project.knowledge.how_to_run', 'run_tests', 'project.workflow.checkpoint',
  'git_push', 'git_commit', 'git_commit_push', 'git_add',
  'git_init', 'git_ignore_add', 'git_rm_cached', 'npm_install',
  'npm_build', 'npm_run', 'file_create', 'file_delete', 'file_append', 'file_read', 'file_find',
  'git_remote_add', 'git_remote_info', 'project_scan', 'project_list',
  'git_log', 'git_branch', 'git_checkout', 'git_pull',
  'git_fetch', 'git_ahead_behind', 'git_tag',
  'git_diff', 'git_stash', 'git_stash_pop', 'git_stash_list', 'git_branch_create',
  'project.action.open_in_vscode', 'project.action.open_in_explorer',
  'project.action.open_site', 'project.action.copy_path',
  'project.action.open_in_terminal', 'project.action.open_github_page',
  'project.action.open_in_cursor', 'project.action.open_file',
  'system.monitoring.metrics', 'system.chit_chat.port',
  // Phase 0 (2026-08-10): utility intents (time/date/calculate) — zero-argument, canned-shape
  // answers computed from Date.now()/mathEval.js, same family as status/port.
  'system.chit_chat.time', 'system.chit_chat.date', 'system.chit_chat.calculate',
  // Phase 1 (2026-08-10): "how do i ..." guidance intent — answers from the
  // consoleCommandDocs.js catalog. Same gate rationale as the NOTE above: a registered intent
  // that never made it into this Set silently died at dispatch.
  'system.chit_chat.how_do_i',
  // Phase 5 intent taxonomy expansion (audit report 2026-08-10): 4 git-family + 5 diagnostics.
  'git_branch_cleanup', 'git_stash_summary', 'git_diff_summary', 'git_pr_ready_check',
  'project.diagnostics.dead_code', 'project.diagnostics.circular_imports',
  'project.diagnostics.type_check', 'project.diagnostics.env_check',
  'project.diagnostics.log_errors', 'system.knowledge.cross_project_search',
  // Phase 8 (2026-08-11): coverage + bundle-size artifact analyzers (builtinDiagnostics.js).
  'project.diagnostics.test_coverage_report', 'project.diagnostics.bundle_size_analysis',
  // Phase 7 (2026-08-11): semantic code search over the persisted code-content index
  // (codeIndexSearch.js) — read-only retrieval with file:line citations.
  'project.code.search',
  // Phase 2 (UPGRADE-ROADMAP.md, 2026-08-11): general-mode file tools (builtinGeneralFiles.js).
  // Not in WORKSPACE_DEV_ONLY_INTENTS — they're usable from every workspace type, per the
  // roadmap's "tag general but don't hard-gate" rule.
  'general.files.find', 'general.files.tidy', 'general.files.duplicates', 'general.files.duplicates_delete',
  // Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): chat openers for the shared interactive tool
  // panels (builtinTools.js). Their INTENTS data carries the `opensPanel` wire-contract tag;
  // the handler echoes it back as an `openPanel` field on the answer payload. Also not dev-only
  // — the Tools surface is reachable from the General tab by design.
  'system.tools.open_calculator', 'system.tools.open_pdf_tools',
  // Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): the PDF toolkit trigger intents
  // (builtinPdfTools.js). Each carries the same `opensPanel: 'pdf-tools'` tag; handlers open
  // the panel only when the input lacks parameters, and full commands execute in chat (writes
  // confirm-gated, journaled through actionHistory). Also not dev-only — general-workspace
  // capability by design, usable from 'dev' projects too (never hard-gated).
  'pdf.merge', 'pdf.split', 'pdf.extract_text', 'pdf.extract_pages', 'pdf.watermark',
]);

// Phase 1 workspaceType filtering (UPGRADE-ROADMAP.md, 2026-08-11): builtin intents that make
// no sense in a 'general' (non-code) workspace. Per the roadmap this is a SUGGESTION-ONLY
// signal — `intentWorkspaceEligible()` gates help text, did-you-mean, the command palette, and
// fallback suggestion chips, never `matchInput()` dispatch itself. A dev command typed in a
// mis-classified 'general' project must still run exactly as before, so this set is deliberately
// narrow: everything git-shaped (the deploy intent is checkpoint + git push, so it counts),
// the npm install/build/run family, test running, diagnostics, and semantic code search. File
// CRUD, open_* actions, and project.context.* stay eligible everywhere — a notes folder can
// still want "find file X" or "what's in this project". Derivation is kept explicit rather than
// regex-driven so an intent added later never gets silently filtered (or silently unfiltered).
// Exported so the committed harness (checkHandlerCoverage.js) can assert the tag list never
// names an intent that left BUILTIN_INTENTS — a stale tag would silently stop filtering.
export const WORKSPACE_DEV_ONLY_INTENTS = new Set([
  'git_push', 'git_commit', 'git_commit_push', 'git_add', 'git_init', 'git_ignore_add',
  'git_rm_cached', 'git_remote_add', 'git_remote_info', 'git_log', 'git_branch',
  'git_checkout', 'git_pull', 'git_fetch', 'git_ahead_behind', 'git_tag', 'git_diff',
  'git_stash', 'git_stash_pop', 'git_stash_list', 'git_branch_create', 'git_branch_cleanup',
  'git_stash_summary', 'git_diff_summary', 'git_pr_ready_check', 'system.chit_chat.git_status',
  'system.chit_chat.deploy', 'run_project', 'run_tests', 'project.knowledge.how_to_run',
  'project.workflow.checkpoint', 'npm_install', 'npm_build', 'npm_run', 'project.code.search',
  'project.diagnostics.dead_code', 'project.diagnostics.circular_imports',
  'project.diagnostics.type_check', 'project.diagnostics.env_check',
  'project.diagnostics.log_errors', 'project.diagnostics.test_coverage_report',
  'project.diagnostics.bundle_size_analysis',
]);

export function isDevOnlyIntent(intent) {
  return WORKSPACE_DEV_ONLY_INTENTS.has(intent);
}

/**
 * Whether a builtin intent may be SUGGESTED for a project of the given workspaceType.
 * 'general' hides dev-only intents; 'dev' and any other value show everything (the fallback
 * keeps behavior identical for callers that don't pass a workspaceType at all).
 */
export function intentWorkspaceEligible(intent, workspaceType) {
  if (workspaceType === 'general') return !isDevOnlyIntent(intent);
  return true;
}

// Exported via matcher.js so localRouter.js's allowed-intent list is always drawn from exactly
// the same set that gates dispatch — a router result naming an intent outside this set could
// never be executed, so there's no reason for the two lists to risk drifting apart.
