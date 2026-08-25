// CLI constants, colors and scripted-mode flags (2026-08-24, split out of cli-client.js).
// Everything here is pure config: nothing reads stdin or connects to the server, so the
// interactive path and the scripted path share one view of the options.

// Mirrors server/index.js's own PORT..PORT+9 fallback range — if something else already had
// BASE_PORT (a stale console instance, another dev server, anything), the real server may have
// landed anywhere in this range, and this client used to have no way to find it.
export const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
export const HOST = process.env.HOST || 'localhost';
export const MAX_PORT_ATTEMPTS = 10;
// Bumped again 2026-07-30 (40s → 90s) based on a real measured cold boot of ~41s — right at the
// old timeout's edge, meaning some boots were likely already failing silently before this. The
// 2026-07-30 intent-expansion batch also grew intentsData.js by roughly a third (more phrases for
// semanticMatcher.js to embed, more training data for nlpEngine.js), which pushes real startup
// time up further, not down. 90s gives real headroom above the one measured data point rather
// than guessing a new number outright — re-measure and adjust again if a real boot ever gets
// close to this new ceiling. (Previous bump: 20s → 40s, same underlying cause.)
export const CONNECT_TIMEOUT_MS = 90000;
export const RETRY_INTERVAL_MS = 750;

// Mirrors the web UI's reserved '__general__' pseudo-workspace (src/types.ts): the server resolves
// this projectId to a synthetic "no project" session so a user can chat before picking a project.
export const GENERAL_PROJECT_ID = '__general__';

export function generalPseudoProject() {
  return {
    id: GENERAL_PROJECT_ID,
    name: 'General workspace',
    path: '(no project selected)',
    folderName: 'general',
    workspaceType: 'general',
  };
}

export const C = {
  reset: '\x1b[0m', green: '\x1b[32m', blue: '\x1b[34m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m',
  bgBlue: '\x1b[44m',
};

// @clack/prompts requires an interactive TTY (raw-mode input) and throws on piped/redirected
// stdin, so every clack call below is gated on this and falls back to the plain readline
// implementations the CLI had before — those still work in non-interactive shells.
export const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

// Scripted / terminal-agent flags (2026-08-24). --resume <id>/--last continue an existing
// session (conversation memory survives a relaunch), --json emits every server message as one
// JSON line (jq-friendly, scriptable), --query runs a single message then exits with a real
// status code (1 if the turn errored), --export dumps a session's full record to stdout. All
// parsed once at module scope so main() and the SIGINT handler share the same view.
const ARGS = process.argv.slice(2);
function flagVal(name, short) {
  const i = ARGS.indexOf(name);
  if (i !== -1 && ARGS[i + 1] !== undefined) return ARGS[i + 1];
  const j = short ? ARGS.indexOf(short) : -1;
  return j !== -1 && ARGS[j + 1] !== undefined ? ARGS[j + 1] : null;
}
export const RESUME_ID = flagVal('--resume', '-r');
export const WANT_LAST = ARGS.includes('--last') || ARGS.includes('-l');
export const JSON_MODE = ARGS.includes('--json');
export const QUERY_INPUT = flagVal('--query', '-q');
// Dry-run / explain (2026-08-24, differentiation item): --dry-run and --explain are the
// same no-execute request — the server resolves what WOULD happen (stage/intent/command)
// and reports it. Additive payload flag on the normal execute message; nothing executes.
export const DRY_RUN_INPUT = flagVal('--dry-run') || flagVal('--explain');
export const EXPORT_ID = flagVal('--export');
const fmtIdx = ARGS.indexOf('--format');
export const EXPORT_FORMAT = fmtIdx !== -1 && ARGS[fmtIdx + 1] === 'json' ? 'json' : 'md';
export const SCRIPTED = JSON_MODE || !!QUERY_INPUT || !!EXPORT_ID || !!DRY_RUN_INPUT;
export { ARGS };