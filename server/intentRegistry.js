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
// 0.721) all start with a run verb, never "open/launch ... project".
export const OPEN_PROJECT_RE = /^(?:open|launch)\s+(?:the\s+|this\s+)?project$/i;

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
]);

// Exported via matcher.js so localRouter.js's allowed-intent list is always drawn from exactly
// the same set that gates dispatch — a router result naming an intent outside this set could
// never be executed, so there's no reason for the two lists to risk drifting apart.
