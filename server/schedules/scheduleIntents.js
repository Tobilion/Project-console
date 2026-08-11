// Read-only intent allowlist for Phase 1 scheduled triggers. A schedule runs UNSUPERVISED —
// there is no human at the other end to answer a confirm prompt — so only intents that can
// never mutate anything or write a file may be scheduled. Note: project.diagnostics.* is
// allowed by prefix and its type_check intent spawns a bounded, read-only `tsc --noEmit`
// (capped by taskQueue's concurrency limit) — so "no spawned process at all" is not the
// guarantee here; "no mutation, no file writes, no confirm-gated actions" is. Anything
// confirm-gated or mutating (git push/commit, file writes, any command execution, deploy,
// etc.) is rejected at schedule-creation time with a clear error, and re-checked at fire
// time as a drift guard (see scheduleFire.js).

// The git family is a mix: log/diff/stash-list/branch-list are read-only introspection,
// while push/commit/add/init/ignore/rm/tag/stash-pop/branch-create mutate and are
// deliberately absent here. Project knowledge/context/diagnostics intents are all reads
// (overview, stack, routes, todos, type-check, env-check, run-command discovery, ...) so
// their whole namespaces are allowed by prefix rather than one-by-one. Explicit entries
// exist only for intents outside those namespaces.
const READ_ONLY_INTENTS = new Set([
  // canned zero-risk chit-chat — a schedule like "daily at 09:00 what time is it" is harmless
  'system.chit_chat.status', 'system.chit_chat.time', 'system.chit_chat.date',
  'system.chit_chat.port', 'system.chit_chat.git_status',
  // read-only git introspection
  'git_diff', 'git_diff_summary', 'git_log', 'git_ahead_behind',
  'git_stash_list', 'git_stash_summary', 'git_branch', 'git_pr_ready_check', 'git_remote_info',
  // monitoring/session info
  'system.monitoring.metrics', 'project.context.session_info',
  // cross-project memory search — a read, no mutations
  'system.knowledge.cross_project_search',
]);

const READ_ONLY_PREFIXES = ['project.knowledge.', 'project.context.', 'project.diagnostics.'];

/** True if an intent id may run unattended on a schedule. */
export function isReadOnlyIntent(intentId) {
  if (!intentId) return false;
  if (READ_ONLY_INTENTS.has(intentId)) return true;
  return READ_ONLY_PREFIXES.some((p) => intentId.startsWith(p));
}

/** Human-readable summary used in schedule-rejection and help answers. */
export function readOnlySummary() {
  return 'read-only intents only: git status/diff/log, diagnostics, dev-server status, project knowledge/context, and time/date/status';
}