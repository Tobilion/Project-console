import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { injectContext } from '../contextInjector.js';
import { formatMemoryForPrompt } from '../memoryStore.js';
import { executeCommand, runningProcesses } from '../executor.js';
import { performUndo, isGitRepo, createCheckpoint } from '../gitSafety.js';
import { pendingConfirmations, state, withPortCollisionWarning } from '../state.js';
import { createProjectTools, findTestCommand } from '../tools.js';
import { findDocumentedRunCommands } from '../readmeRunParser.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { formatApiRoutes, findTodos, findBiggestFiles, findRecentActivity } from '../codebaseIndexer.js';
import { isSafeParamValue } from '../paramCommand.js';
import { chatOnce } from '../ollama.js';

/**
 * Pulls a filename and (optionally) quoted content out of a natural-language trigger-mode
 * request, e.g. "add file Tobijagz to folder with text 'I am the goat'" or "create a file
 * called notes.md with the text 'Hello World'". Deliberately conservative — if either piece
 * can't be found with reasonable confidence, the caller asks the user instead of guessing,
 * same policy this app already follows for ambiguous file targets on the AI path.
 */
function parseFileNameAndContent(input) {
  const fileName = parseFileNameOnly(input);

  // Content: prefer an explicit "with/containing/saying (the) text/content/message ... '...'"
  // clause; fall back to the first quoted string anywhere in the input.
  const withClause = input.match(/\b(?:with|containing|saying)\b\s*(?:the\s+)?(?:text|content|message)?\s*[:]?\s*["']([^"']+)["']/i);
  const anyQuoted = input.match(/["']([^"']{1,2000})["']/);
  const content = (withClause?.[1] ?? anyQuoted?.[1])?.trim() || null;

  return { fileName, content };
}

/**
 * Just the filename half of parseFileNameAndContent, for read-only requests. Tries an explicit
 * filename with an extension first ("notes.md", "src/utils/helpers.js" — the reliable case,
 * doesn't require the word "file" to appear at all), then falls back to whatever follows the
 * literal word "file" for extensionless names like "add file Tobijagz to folder...".
 *
 * Phase 1 (2026-08-03): also handles the "the <name> file" shape ("find the config file",
 * "where is the readme file") where the name comes BEFORE the word "file" — file_read and the
 * new file_find both previously asked "which file?" for these. Deliberately requires a
 * determiner ("the/a/my/...") before the name so a bare action like "read file" or "open file"
 * still asks instead of treating the verb as a filename.
 */
function parseFileNameOnly(input) {
  const withExt = input.match(/\b([\w.\-/\\]+\.[a-zA-Z0-9]{1,10})\b/);
  if (withExt) return withExt[1];
  const afterFileWord = input.match(/\bfile\b\s+(?:called\s+|named\s+)?["'`]?([^\s"'`]+?)["'`]?(?=\s+(?:to|in|with|containing|saying|that|and|$)|$)/i);
  if (afterFileWord) return afterFileWord[1];
  const beforeFileWord = input.match(/\b(?:the|a|an|my|your|this|that)\s+([\w.-]{2,})\s+file\b/i);
  return beforeFileWord?.[1] || null;
}

/**
 * Extracts a commit/push comment from phrasing like `with the comment "..."` / `message: '...'`.
 * Tries a fully-quoted match first — captures everything between matching quote characters (via
 * a backreference) so the message can safely contain the word "and" without being cut short.
 * Falls back to the old "stop at the first ' and' or end of string" heuristic only for an
 * UNQUOTED message, where "and" plausibly does start a separate trailing clause ("message: fix
 * the bug and push").
 *
 * Confirmed live 2026-07-29 (real exported chat transcript): `push this code to github with
 * comment "Massive Memory and Learning improvements"` silently committed as just "Massive
 * Memory" — the previous regex (duplicated across git_push/git_commit/git_commit_push/deploy)
 * stopped at the FIRST " and" it found anywhere in the tail, regardless of whether it was inside
 * the quotes, because it was written to catch an unquoted trailing clause like "message: fix the
 * bug and push it" and never accounted for "and" being a perfectly normal word inside a real
 * quoted commit message. All four call sites now share this one fixed implementation instead of
 * each carrying their own copy of the same bug.
 */
function extractCommentMessage(input) {
  const quoted = input.match(/(?:with (?:the )?)?(?:comment|message):?\s*(["'])([\s\S]+?)\1/i);
  if (quoted) return quoted[2].trim();
  const unquoted = input.match(/(?:with (?:the )?)?(?:comment|message):?\s*(.+?)(?:\s*$|\s+and\s)/i);
  return unquoted ? unquoted[1].trim() : null;
}

/**
 * Queues a direct file-tool call (writeFile/appendToFile/etc.) behind the same
 * confirm-before-execute flow risky shell commands already use, instead of routing it through
 * executeCommand — there's no shell command to run here, just a sandboxed tools.js function.
 * See handleConfirmResponse's `pending.fileOp` branch in connection.js for the execution side.
 */
function queueFileOpConfirmation(ws, project, input, { tool, args, summary }) {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    projectId: project.id,
    fileOp: { tool, args },
    command: summary, // so the generic "Cancelled: ..." path (keyed off pending.command) still works
    trigger: input,
    createdAt: Date.now(),
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: summary,
    trigger: tool,
  }));
}

/** Picks one entry at random — used to give repeated chit-chat intents (greeting, thanks, status)
 *  varied replies instead of the exact same string every time, without needing any model call.
 *  Requested directly (2026-07-30): "richer canned chit-chat... still fully deterministic". */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns the project's configured reply pool for a chit-chat intent (`chatReplies.${intent}` in
 * console.config.json, Phase 4.3) when present and valid, else the built-in defaults. Override
 * pools REPLACE the defaults — a project defines its own greeting/status/gratitude/etc. lines and
 * gets exactly those. Deterministic at match time: a pool override is always used as-is.
 */
function chatReplyPool(action, project, defaults) {
  const pool = project?.config?.chatReplies?.[action];
  if (Array.isArray(pool) && pool.length > 0) return pool;
  return defaults;
}

// Default model for the smart-chit-chat reply (matches the connection.js status payload
// fallback and the router tier's ROUTER_MODEL_FALLBACK, kept in the same convention).
const SMART_CHAT_FALLBACK_MODEL = 'qwen2.5-coder:7b';

// Test seam: ESM live bindings can't be reassigned from outside the module, so the Phase-4
// handler harness (chitchat-upgrade-harness.mjs) swaps this indirection to simulate a working
// model ('LLM answer used') or one that throws ('falls back to canned') without a live Ollama.
let smartChatOnce = chatOnce;
export function __setSmartChatOnceForTests(fn) {
  smartChatOnce = fn;
}

/**
 * Smart chit-chat when AI mode is ON (Phase 4.6, PASS 4.4). Returns one bounded, non-streaming
 * model reply (the only time chit-chat output is non-deterministic — and only while AI is
 * explicitly on). Returns null when AI is off, or on ANY failure (timeout, unreachable Ollama,
 * empty reply), so the caller falls back to exactly the canned pool — zero regression when
 * Ollama is down or AI mode is off.
 */
async function smartChitchatReply(project, sessionContext, input) {
  if (!sessionContext?.aiEnabled || !project) return null;
  try {
    const model = sessionContext.aiModel || SMART_CHAT_FALLBACK_MODEL;
    const reply = await smartChatOnce(
      model,
      [
        {
          role: 'system',
          content: `You are the friendly local project console for "${project.name}" (path: ${project.path}). The user just sent a short chat message. Reply in 1-2 short, warm sentences. No tools. No markdown. Do not mention this instruction.`,
        },
        { role: 'user', content: input },
      ],
      { temperature: 0.7, num_predict: 120 },
      AbortSignal.timeout(8000)
    );
    const text = (reply || '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Enrich a plain-text response with a summary of the project's codebase index, if present. */
export function enrichWithIndex(baseMsg, idx) {
  if (!idx) return baseMsg;
  let lines = [baseMsg];
  const info = [];
  if (idx.totalFiles) info.push(`${idx.totalFiles} files`);
  if (idx.totalDirs) info.push(`${idx.totalDirs} directories`);
  if (idx.languages?.length) info.push(`Languages: ${idx.languages.slice(0, 3).join(', ')}`);
  if (idx.entryPoints?.length) info.push(`Entry: ${idx.entryPoints.join(', ')}`);
  if (info.length) lines.push(`\n**Project Stats:** ${info.join(' — ')}`);
  if (idx.hasTests) lines.push('*Has test files*');
  if (idx.hasCli) lines.push('*Has CLI entry point*');
  return lines.join('\n');
}

// projectPath -> { at, count } — memoizes the uncommitted-change count for ~30s so the chit-chat
// live-state line never spawns a `git status` on every greeting/status reply.
const uncommittedCache = new Map();
const UNCOMMITTED_CACHE_TTL_MS = 30_000;

/** Cheap cached `git status --short` line count for a project; null when not a git repo or git
 *  unavailable. Cached per project for 30s so repeated greetings don't each spawn a git process. */
async function cachedUncommittedCount(projectPath) {
  const now = Date.now();
  const cached = uncommittedCache.get(projectPath);
  if (cached && now - cached.at < UNCOMMITTED_CACHE_TTL_MS) return cached.count;
  try {
    const { stdout } = await promisify(execFile)(
      'git', ['status', '--short'],
      { cwd: projectPath, timeout: 5000, windowsHide: true }
    );
    const count = stdout && stdout.trim() ? stdout.trim().split('\n').filter((l) => l.trim()).length : 0;
    uncommittedCache.set(projectPath, { at: now, count });
    return count;
  } catch {
    uncommittedCache.set(projectPath, { at: now, count: null });
    return null;
  }
}

/**
 * Builds a compact "what's actually happening right now" line for the chit-chat greeting/status
 * replies (Phase 4.1): the console's own port, how many projects are indexed, this project's
 * running dev-server command + URL (with the port-collision warning when the dev URL matches the
 * console's own port), and a cached uncommitted-change count. Every clause is independently
 * guarded — if any piece throws, that clause is silently omitted; the reply must never break.
 */
async function buildLiveStateLine(project) {
  const parts = [];
  let devUrl = null;
  try {
    if (state.serverPort) parts.push(`Console on port ${state.serverPort}`);
    const n = state.activeProjectsCache?.length || 0;
    parts.push(`${n} project${n === 1 ? '' : 's'} indexed`);
  } catch {}
  try {
    const proc = runningProcesses.get(project.id);
    devUrl = state.lastDevUrls.get(project.id);
    if (proc || devUrl) {
      let line = 'Running:';
      if (proc) line += ` \`${proc.command}\``;
      if (devUrl) line += ` @ ${devUrl}`;
      parts.push(line);
    }
  } catch {}
  try {
    const count = await cachedUncommittedCount(project.path);
    if (count !== null) parts.push(count === 0 ? 'Git clean' : `${count} uncommitted change${count === 1 ? '' : 's'}`);
  } catch {}
  if (!parts.length) return '';
  let text = parts.join(' · ');
  if (devUrl) text = withPortCollisionWarning(text, devUrl);
  return `\n\n**Live state:** ${text}`;
}

/**
 * Returns a short "what the console remembers about this project" block for the chit-chat
 * greeting (Phase 4.2). The memory file is already capped at MAX_PROMPT_CHARS (memoryStore.js),
 * so this only needs to take a small first slice to keep the greeting compact — no unbounded
 * reads. Returns '' when there's nothing saved (never appends an empty block).
 */
async function buildMemoryBlock(project) {
  try {
    const memory = await formatMemoryForPrompt(project.path);
    if (!memory) return '';
    const firstLines = memory.split('\n').filter((l) => l.trim()).slice(0, 2).join('\n');
    if (!firstLines) return '';
    // Take a compact slice; memory batches already cap at 200 entries / 4000 chars upstream.
    const slice = firstLines.length > 300 ? firstLines.slice(0, 300) : firstLines;
    return `\n\n**What the console remembers about [${project.name}]:**\n${slice}`;
  } catch {
    return '';
  }
}

/**
 * Builds the "help" response: a categorized prompt library. Ground truth was scattered across
 * NLP training phrases, semantic-matcher examples, and per-project config before this — this is
 * the single place a real, copy-pasteable example lives for every capability the console has,
 * so "help" is actually useful instead of just listing raw trigger strings.
 */
function buildHelpMessage(project, sessionContext) {
  const lines = [`### What you can ask in [${project.name}]`];

  lines.push(
    `\n**Trigger mode (works with AI off — instant, no model needed):**`,
    `  - "overview" / "describe" — what this project is`,
    `  - "tech stack" — languages & frameworks in use`,
    `  - "project structure" / "show me the folders" — directory tree`,
    `  - "what are the commands" — how to run this project`,
    `  - "known issues" / "gotchas" — parsed from your CLAUDE.md`,
    `  - "architecture" — how it's built`,
    `  - "entry point" — where the app starts`,
    `  - "how many files" — project size stats`,
    `  - "run tests" — test file detection`,
    `  - "show dependencies" / "show config" — package.json, .env, etc.`,
    `  - "git status" — uncommitted changes`,
    `  - "deploy" / "push live" — commits everything and pushes (asks to confirm first)`,
    `  - "attach the github link <url>" — sets/updates the git remote origin`,
    `  - "create a file called X with the text '...'" — creates a file (asks to confirm first)`,
    `  - "append to X the text '...'" — adds to the end of a file (asks to confirm first)`,
    `  - "read file X" / "what's in X" — shows a file's contents`,
    `  - "run the site" / "run the project" — detects project type, shows runnable suggestions`,
    `  - "where is the link" / "link?" / "url?" — shows dev server URL if running`,
    `  - "stop server" / "kill server" — stops a running dev server`,
    `  - "npx serve ." / "python -m http.server" — direct shell commands (skips matching)`,
    `  - "explain more" — deeper detail on whatever you just asked about`,
    `  - "undo" — reverts the last risky command via git`,
    `  - "clear" — wipes this chat window`,
  );

  const commands = [];
  const answers = [];
  (project.config?.entries || []).forEach((e) => {
    const primaryTrigger = e.triggers?.[0] || 'unknown';
    if (e.type === 'command') {
      commands.push(`  - "${primaryTrigger}" -> \`${e.action}\`${e.risky ? ' (Risky)' : ''}${e.auto ? ' (auto: package.json)' : ''}`);
    } else if (e.type === 'answer') {
      answers.push(`  - "${primaryTrigger}"`);
    }
  });
  if (commands.length > 0) lines.push(`\n**This project's configured commands:**`, ...commands);
  if (answers.length > 0) lines.push(`\n**This project's configured Q&A topics:**`, ...answers);

  // System commands — always shown
  lines.push(
    `\n**Monitoring & metrics:**`,
    `  - "monitoring" / "show metrics" / "health check" — latency, counters, recent events`,
    `\n**Learning & telemetry commands:**`,
    `  - "review learning" / "check learning" — see near-miss suggestions for new trigger phrases`,
    `  - "approve suggestions" — add suggested phrases to intent matching`,
    `  - "telemetry review" / "telemetry stats" — intent match statistics`,
    `  - "telemetry suggest" — get threshold tuning recommendations`,
    `  - "threshold set <intent> <floor>" — override confidence floor for an intent`,
    `  - "threshold reset <intent>" — restore default threshold`,
    `  - "telemetry auto-apply" — auto-apply threshold suggestions for this project`,
    `  - "check collisions" — check which intents overlap in embedding space`,
    `  - "review distillations" — see AI-derived trigger suggestions from past AI sessions`,
    `  - "apply distillation <n>" — add a suggested command/answer to console.config.json`,
    `  - "review memory" / "project memory" — usage patterns (frequent commands, files, questions)`,
    `  - "telemetry clear" — reset telemetry data for this project`,
  );

  if (sessionContext?.aiEnabled) {
    lines.push(
      `\n**AI is ON — natural language works too, e.g.:**`,
      `  - "Write a file CHANGELOG.md and add a line about the new deploy feature"`,
      `  - "Add a line to CLAUDE.md under Known gotchas about X"`,
      `  - "Find where the login handler is defined"`,
      `  - "Read package.json and tell me what scripts are available"`,
      `  - "Fix the bug where X happens when Y"`,
      `  - "Remove node_modules from git tracking"`,
      `  - Writes/edits and risky commands still ask you to approve before running.`,
    );
  } else {
    lines.push(
      `\n**Want free-form requests (file edits, "fix this bug", multi-step tasks)?**`,
      `  Turn AI ON (top-right toggle) — it hands the request to your local Ollama model with`,
      `  read/write/search tools scoped to this project's folder. Trigger mode above only`,
      `  matches the exact phrasings listed — it can't improvise.`,
    );
  }

  return lines.join('\n');
}

/**
 * Confirmed live 2026-07-30 (Matchday Exchange transcript): "run its server" and "run .bat" both
 * ran the generic `npm run dev` (spawning a second, then third, redundant Vite instance on
 * 3002/3003) instead of the project's actual `npm run server` wallet/settlement backend script —
 * even though a differently-phrased "Is its server running?" correctly found and ran that exact
 * script. Root cause: `run_project`'s handler always defaulted straight to scripts.dev/start/serve
 * without ever looking at what the user's own input said, unlike `npm_run`'s handler (which tries,
 * but only when a script name immediately follows "run"/"execute" — "run its server" fails that
 * too, since "its" is what immediately follows "run"). This checks every real script name in the
 * project's own package.json against the input as a whole word, so "its server", "is the server
 * running", "start the server process" etc. all find `server` regardless of exactly where the
 * word falls in the sentence — a looser, more forgiving match than npm_run's strict regex,
 * intentionally, since this is meant to catch cases that regex misses. Returns null (defer to the
 * normal dev/start/serve default) when no other script name appears at all.
 */
function findMentionedScript(input, scripts) {
  const lower = input.toLowerCase();
  const names = Object.keys(scripts || {});
  // Longest name first so e.g. "test:e2e" wins over a bare "test" also being a substring match.
  names.sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) return name;
  }
  return null;
}

// Phase 3 (2026-08-03, NetPulse transcript): suggestion-chip bar for a project's own
// console.config.json `command` entries when a run-family builtin (run_project / npm_run) won
// the match but its input fell below matcher.js's CONFIG_RUN_ENTRY_FLOOR auto-run bar. Measured
// from real NetPulse inputs against its own triggers: the genuine cases this must catch score
// 0.41-0.50 ("run the site" -> 0.410 serve, "run the server" -> 0.499 serve), while inputs that
// merely contain "run" but are about something else ("run the numbers", "run the calculation")
// never reach this helper at all — they resolve to other intents (project.knowledge.commands)
// or the no-match fallback. A wrong suggestion chip is harmless (nothing runs until clicked),
// which is exactly why this bar is lower than the auto-run floor; 0.40 is the top of the
// measured no-man's-land below the true positives.
const CONFIG_SUGGESTION_FLOOR = 0.4;

// Requested directly (2026-07-30): findDocumentedRunCommands() returns every run command a doc
// documents, in doc order — and the FIRST one is often NOT the web server (NetPulse's "## Run"
// block lists `once` first, `serve` third). For a site-flavored ("run the site" / "start the
// web server") or server-flavored ("run the server" / "start the api") ask, prefer whichever
// documented command actually SERVES the web app (serve/flask / uvicorn/vite/npm dev shape) over
// the raw first match, so neither "run the site" nor "run the server" lands on a one-shot command
// documented first. Non-site asks and single-command docs keep the first-match behavior exactly
// as before. Widened 2026-08-03 to include server/api/backend demand-side shapes — the earlier
// site-only list let a README-only (no console.config.json) project's "run the server" fall back
// to the first documented command (e.g. `once`) instead of the actual `serve`.
const SITE_FLAVORED_INPUT_RE = /\b(site|website|web ?(app|site|server)|dashboard|frontend|page|server|api|backend)\b/i;
const SERVER_SHAPED_COMMAND_RE = /\b(serve\b|server|flask\s+run|uvicorn|gunicorn|vite(\s|$)|php\s+artisan\s+serve|dev\b|npm\s+run\s+(dev|start|serve)|dotnet\s+run|\bhttp\.server)/i;

function pickDocumentedRunCommand(documents, input) {
  if (!documents || documents.length === 0) return null;
  if (SITE_FLAVORED_INPUT_RE.test(input) && documents.length > 1) {
    const serving = documents.find((d) => SERVER_SHAPED_COMMAND_RE.test(d.command));
    if (serving) return serving;
  }
  return documents[0];
}

/**
 * Shared helper: detect project type and emit suggestion chips with runnable commands.
 * Used by both `npm_run` and `run_project` when no matching script is found.
 *
 * Phase 3 (2026-08-03, NetPulse transcript): the suggestion fallback this helper produces used
 * to guess from README/language markers alone — a generic "run the site" on NetPulse suggested
 * `python main.py once` (the first line of its README's Run block) instead of the project's own
 * hand-authored `python main.py serve` entry. A project's own console.config.json `command`
 * entries are strictly more trustworthy than any parsed README guess — same priority order as
 * the matcher's execution-side preference (CONFIG_RUN_ENTRY_FLOOR, stage 1b) — so prefer the
 * best-scoring entry here too, as a suggestion chip (NOT an auto-run: only matcher.js auto-runs,
 * above its own higher floor). Entries with `{param}` placeholders are skipped — a bare chip
 * can't answer the param ask (handleMatchedEntry's pendingParam flow only runs on the
 * entry-dispatch path, which this fallback isn't).
 */
async function projectTypeSuggestions(ws, project, input, scripts) {
  const idx = project.codebaseIndex;
  const langs = idx?.languages || [];
  const entries = idx?.entryPoints || [];
  const fileSample = idx?.fileSample || [];
  const hasIndexHtml = entries.some(e => e.endsWith('index.html'));
  // Confirmed live 2026-07-29 (survey of every sibling project under Projects/): several small
  // Python/static projects ship a "Play <Name>.bat" launcher instead of a plain python/npm
  // entrypoint, and the launcher is frequently interactive (e.g. DuplicateFileAnalyzer's
  // `set /p TARGET=` folder prompt) or spawns a second detached window (StudyFlash's API server)
  // — neither of which `executeCommand`'s single non-interactive child process can reproduce.
  // Detect this pattern first and point the user at the launcher instead of guessing a command
  // that's likely wrong or would hang forever waiting on stdin nobody can answer. Hand-authored
  // console.config.json entries still take priority over this — it only fires when nothing
  // matched there first.
  // Requested directly (2026-07-30): before guessing a command from language detection alone,
  // check whether the project's own README/CLAUDE.md already documents the real run command
  // (Install/Usage/Getting Started/Run section, or any fenced code block with a recognizable
  // command shape — see readmeRunParser.js). This is real author-written instructions, strictly
  // more trustworthy than a language-based guess, and it's how trigger mode (no AI/Ollama
  // involved at all) can still "read the README" the same way a human skimming it would.
  //
  // Confirmed live 2026-08-03 (NetPulse, reported directly): this used to run AFTER the bat-
  // launcher check below, so a generic "run the site" on NetPulse always hit the bat-launcher
  // fallback and told the user to double-click Play NetPulse.bat — even though NetPulse's own
  // README documents a real, safe, non-interactive command (`python main.py serve`) and the bat
  // launcher was never actually necessary for it. The bat-launcher check exists for projects
  // where the launcher is the ONLY way to reproduce an interactive/multi-process startup — it
  // isn't a reason to ignore a documented single-command entry point when one exists. Swapped
  // order: a documented command now wins even when a Play *.bat file is also present.
  // Phase 3 (2026-08-03, NetPulse transcript): a project's own hand-authored command entries
  // win the *suggestion* race the same way matcher.js stage 1b makes them win the *execution*
  // race above CONFIG_RUN_ENTRY_FLOOR — before trusting a README-parse guess, check whether one
  // of the project's own entries scores above CONFIG_SUGGESTION_FLOOR. Runs before the
  // documented-command branch below for the same reason that branch runs before the bat-launcher
  // check: a config entry is authored for this exact console, so it's the most trustworthy
  // source of all. Deliberately suggestion-only — auto-execution stays in matcher.js where the
  // floor is higher and the safety checks (confirm flow, params) are the normal entry path.
  // Confirmed live 2026-07-29 (NetPulse, a real Flask/Python project): this used `langs.includes(
  // 'Python')` but codebaseIndexer.js's detectLanguages() always formats each entry as
  // "Python (4 files)" — never a bare name — so `.includes('Python')` (an exact-match array
  // check) could never be true for ANY project. Same bug for 'JavaScript'/'TypeScript'. This
  // silently broke the Python and JS branches below for every project, always falling through to
  // the generic "entry point" suggestion instead of "python main.py" / npm script suggestions.
  const isPython = langs.some((l) => l.startsWith('Python'));
  const isJs = langs.some((l) => l.startsWith('JavaScript') || l.startsWith('TypeScript'));
  const cfgEntries = (project.config || project)?.entries || [];
  if (cfgEntries.some((e) => e.type === 'command')) {
    const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === project.id);
    const best = await semanticMatcher.bestProjectCommandEntry(input, projectIndex);
    const bestEntry = best ? cfgEntries[best.entryIndex] : null;
    if (bestEntry && bestEntry.type === 'command' && !bestEntry.params && best.score >= CONFIG_SUGGESTION_FLOOR) {
      ws.send(JSON.stringify({ type: 'answer', data: `Found a run command in **[${project.name}]**'s own config:` }));
      ws.send(JSON.stringify({ type: 'suggestions', data: [bestEntry.action] }));
      return;
    }
  }
  const scriptNames = Object.keys(scripts);
  // Requested directly (2026-08-03): package.json's scripts are the more CURRENT source of truth
  // than a README/CLAUDE.md that may document an older command — a repo's package file gets
  // updated on every dependency/script change while the docs often lag behind. So when the project
  // has real npm scripts (and no matching config entry — config still wins, it's authored for this
  // exact console), prefer listing the actual scripts over trusting a documented command that may
  // be stale. If it turns out the doc has a command the scripts don't cover, the doc still shows
  // up lower in the pipeline — the scripts list is strictly the higher-trust source here. Order:
  // config entries > package.json scripts > documented README/CLAUDE.md command > bat launcher >
  // language guess.
  if (scriptNames.length > 0) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Available Scripts\n\nClick one to run it:` }));
    ws.send(JSON.stringify({ type: 'suggestions', data: scriptNames.map((s) => `npm run ${s}`) }));
    return;
  }
  const documented = pickDocumentedRunCommand(findDocumentedRunCommands(project), input);
  if (documented) {
    const sourceNote = documented.header
      ? `Found in **${documented.doc}** under "${documented.header}":`
      : `Found in **${documented.doc}**:`;
    ws.send(JSON.stringify({ type: 'answer', data: `${sourceNote}` }));
    ws.send(JSON.stringify({ type: 'suggestions', data: [documented.command] }));
    return;
  }
  const batLauncher = fileSample.find((f) => /^Play .+\.bat$/i.test(f));
  if (batLauncher) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `This project ships its own launcher: **${batLauncher}**. It may prompt for input or start more than one process, so double-click it in File Explorer (or run it from a terminal) instead of through this console.`,
    }));
    return;
  }
  // Widened 2026-07-30 (raised directly, alongside the codebase indexer's own language coverage
  // widening) — these five used to have no trigger-mode run-command support at all and fell into
  // the generic `entries.length > 0` branch below, which just does `start <entrypoint>` — wrong
  // for anything compiled (e.g. `start main.go` opens the file in its default editor instead of
  // running it). Each checks a real project marker (not just language file count) before
  // suggesting anything, same "don't guess if we can't tell" spirit as the Python branch above.
  const isGo = !!idx?.keyFiles?.['go.mod'];
  const isRust = !!idx?.keyFiles?.['cargo.toml'];
  const isJava = !!(idx?.keyFiles?.['pom.xml'] || idx?.keyFiles?.['build.gradle'] || idx?.keyFiles?.['build.gradle.kts']);
  const isRuby = !!idx?.keyFiles?.['Gemfile'];
  const isPhp = !!idx?.keyFiles?.['composer.json'];
  const isCSharp = entries.some((e) => e.endsWith('Program.cs')) || langs.some((l) => l.startsWith('C#'));
  const suggestions = [];

  if (isPython) {
    // Confirmed live 2026-07-29 (survey of every sibling project under Projects/): blindly
    // suggesting "python main.py" / "python app.py" is wrong more often than not — some projects
    // have neither file at their root (DuplicateFileAnalyzer's real entry is a package module,
    // `backend/main.py`, invoked as `-m backend.main`), and some have a real main.py that isn't
    // the right file to suggest first (NetPulse's main.py is a CLI dispatcher — `python main.py`
    // alone just prints usage; the actual server command is `python main.py serve`). Prefer
    // whichever common entry filename actually exists at the project root before falling back to
    // a guess, so the suggestion chip is at least a file that's really there.
    const rootPyFiles = fileSample.filter((f) => f.endsWith('.py') && !f.includes('/') && !f.includes('\\'));
    const commonNames = ['main.py', 'app.py', 'run.py', 'server.py', 'dashboard.py'];
    const found = commonNames.filter((n) => rootPyFiles.includes(n));
    ws.send(JSON.stringify({ type: 'answer', data: `This appears to be a **Python** project. Click a suggestion to run it:` }));
    if (found.length > 0) {
      found.forEach((n) => suggestions.push(`python ${n}`));
    } else {
      suggestions.push('python main.py', 'python app.py');
    }
  } else if (hasIndexHtml && !scriptNames.length) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **static site** (no build step). Click a suggestion to serve it locally:` }));
    suggestions.push('npx serve .', 'python -m http.server 8080');
  } else if (isJs) {
    ws.send(JSON.stringify({ type: 'answer', data: `JavaScript project with no npm scripts. Try:` }));
    suggestions.push('npx serve .', 'npx vite', 'npm install');
  } else if (isRust) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Rust** project (Cargo.toml found). Click a suggestion to run it:` }));
    suggestions.push('cargo run', 'cargo build');
  } else if (isGo) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Go** project (go.mod found). Click a suggestion to run it:` }));
    suggestions.push('go run .', 'go build ./...');
  } else if (isJava) {
    const isGradle = !!(idx?.keyFiles?.['build.gradle'] || idx?.keyFiles?.['build.gradle.kts']);
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Java** project (${isGradle ? 'Gradle' : 'Maven'} found)${idx?.frameworks?.includes('Spring Boot') ? ' using **Spring Boot**' : ''}. Click a suggestion to run it:` }));
    if (isGradle) suggestions.push('./gradlew bootRun', './gradlew run');
    else suggestions.push('mvn spring-boot:run', 'mvn compile exec:java');
  } else if (isRuby) {
    const looksLikeRails = fileSample.includes('config.ru') || fileSample.some((f) => f.startsWith('config/environment.rb'));
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Ruby** project (Gemfile found)${looksLikeRails ? ', likely Rails/Rack' : ''}. Click a suggestion to run it:` }));
    if (looksLikeRails) suggestions.push('bundle exec rails server', 'bundle exec rackup');
    else suggestions.push('bundle install', 'bundle exec ruby app.rb');
  } else if (isPhp) {
    const isLaravel = idx?.frameworks?.includes('Laravel') || fileSample.includes('artisan');
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **PHP** project (composer.json found)${isLaravel ? ', looks like Laravel' : ''}. Click a suggestion to run it:` }));
    if (isLaravel) suggestions.push('php artisan serve');
    else suggestions.push('php -S localhost:8000', 'composer install');
  } else if (isCSharp) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **C#/.NET** project. Click a suggestion to run it:` }));
    suggestions.push('dotnet run', 'dotnet build');
  } else if (entries.length > 0) {
    ws.send(JSON.stringify({ type: 'answer', data: `**Entry point:** \`${entries[0]}\`. Try:` }));
    suggestions.push(`start ${entries[0]}`);
  } else {
    ws.send(JSON.stringify({ type: 'answer', data: `Could not detect project type. Try "help" for available commands or turn AI mode ON.` }));
  }
  if (suggestions.length > 0) {
    ws.send(JSON.stringify({ type: 'suggestions', data: suggestions }));
  }
}

/** Handles all built-in (non-project-config, non-AI) conversational intents. Returns false if the action wasn't recognized. */
export async function handleBuiltinIntent(ws, action, input, project, sessionContext) {
  if (action === 'system.chit_chat.undo' || action === 'undo') {
    const undoResult = await performUndo(project.path);
    if (undoResult.success) {
      ws.send(JSON.stringify({ type: 'answer', data: undoResult.message }));
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: undoResult.message + '\n' }));
    }
  } else if (action === 'system.chit_chat.greeting') {
    const ctx = injectContext(input, action, project.codebaseIndex);
    const hour = new Date().getHours();
    const timeOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const opener = pickRandom(chatReplyPool('greeting', project, [
      `Good ${timeOfDay}! Local Console is active for [${project.name}].`,
      `Hey there — [${project.name}] is loaded and ready.`,
      `Hi! Ready to help with [${project.name}].`,
      `Hey! [${project.name}] is up. What are we working on?`,
      `Good to see you — [${project.name}] is live.`,
      `Welcome back to [${project.name}] — ${timeOfDay} edition.`,
      `${timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1)}! [${project.name}] is standing by.`,
      `Hi again — [${project.name}] is still here.`,
    ]));
    let responseText = `${opener}\n\n` +
      `• Location: ${project.path}\n` +
      `• Type "help" to list all commands & topics.\n` +
      `• Type "overview" for architecture overview.\n` +
      `• Type "explain more" for deep details.`;
    responseText += await buildMemoryBlock(project);
    responseText += await buildLiveStateLine(project);
    if (ctx) responseText += `\n\n${ctx}`;
    const smartGreeting = await smartChitchatReply(project, sessionContext, input);
    ws.send(JSON.stringify({ type: 'answer', data: smartGreeting || responseText }));
  } else if (action === 'system.chit_chat.status') {
    const ctx = injectContext(input, action, project.codebaseIndex);
    const opener = pickRandom(chatReplyPool('status', project, [
      `I'm running and ready on **[${project.name}]**. What do you need?`,
      `All good here — standing by on **[${project.name}]**.`,
      `Still here, still watching **[${project.name}]**. What's next?`,
      `Running smoothly on **[${project.name}]** — what can I do?`,
      `Yep, I'm listening — **[${project.name}]** is active.`,
    ]));
    let statusMsg = enrichWithIndex(opener, project.codebaseIndex);
    statusMsg += await buildLiveStateLine(project);
    if (ctx) statusMsg += `\n\n${ctx}`;
    const smartStatus = await smartChitchatReply(project, sessionContext, input);
    ws.send(JSON.stringify({ type: 'answer', data: smartStatus || statusMsg }));
  } else if (action === 'system.chit_chat.gratitude') {
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom(chatReplyPool('gratitude', project, [
        `You're welcome! Ready for your next command on [${project.name}].`,
        `Anytime! What's next for [${project.name}]?`,
        `Happy to help — let me know what's next on [${project.name}].`,
        `No problem at all. What else can I do on [${project.name}]?`,
        `Glad that helped. Ready when you are.`,
      ])),
    }));
  } else if (action === 'system.chit_chat.farewell') {
    // New intent (2026-07-30, requested directly — "richer canned chit-chat"): the chit-chat set
    // had no goodbye at all before, so "bye"/"see you later" either fell through to a no-match
    // fallback or got misclassified onto something else entirely.
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom(chatReplyPool('farewell', project, [
        `See you later! [${project.name}] will be here when you're back.`,
        `Bye for now — come back anytime.`,
        `Catch you later. [${project.name}] stays as you left it.`,
        `Goodbye! Nothing lost — just say hi when you're back.`,
        `Take care! I'll be right here on [${project.name}].`,
      ])),
    }));
  } else if (action === 'system.chit_chat.identity') {
    // New intent (2026-07-30, requested directly): "who are you"/"what are you" previously had no
    // real answer — either misclassified onto system.chit_chat.help or fell to a generic fallback.
    // Distinct from "help" (which lists commands) — this answers what this thing *is*.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `I'm the local command console for **[${project.name}]** — a project-aware dispatcher that runs entirely on your machine. With AI mode off, I match what you type against a fixed set of known project actions (git, npm/build commands, file reads, project Q&A) using a local embedding model — no data leaves this machine, no cloud model involved. With AI mode on, I hand things off to your local Ollama model with read/write tools scoped to this project's folder. Type "help" for the full list of what I can do here.`,
    }));
  } else if (action === 'system.chit_chat.needs_ai_mode') {
    // New intent (2026-08-03, Phase 3 of the intent-expansion spec): open-ended requests typed
    // while AI mode is off previously scattered onto identity/structure/commands or the generic
    // fallback. The AI toggle is a frontend-only control, so this can only answer with guidance —
    // it must NOT try to flip the toggle itself (no such server-side path exists by design).
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom([
        `That one needs AI mode — flip the AI toggle at the top of this chat (next to the model picker) and ask again. AI mode gives me read/write tools scoped to [${project.name}], so I can handle open-ended requests.`,
        `This is trigger mode, which only handles the fixed built-in actions. Use the AI toggle in the header of this chat to switch AI mode on for requests like that, then re-ask.`,
        `AI mode isn't on right now. Flip the AI switch in the chat header, then ask me again — with AI on I can work with files in [${project.name}] and answer open-ended questions.`,
      ]),
    }));
  } else if (action === 'system.chit_chat.ack') {
    // New intent (2026-08-03, Phase 2.1): brief acknowledgment replies — "nice", "cool", etc.
    // Confirm-prompt responses go through handleConfirmResponse, NOT the matcher — so these
    // can never approve a pending command.
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom(chatReplyPool('ack', project, [
        `Glad it worked! What's next on [${project.name}]?`,
        `Nice — anything else on [${project.name}]?`,
        `Good stuff. Ready for the next one.`,
        `Awesome. What are we doing next?`,
        `Cool. Let me know what you need.`,
      ])),
    }));
  } else if (action === 'system.chit_chat.joke') {
    // New intent (2026-08-03, Phase 2.3): programmer jokes — deterministic, no network, no AI.
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom([
        `Why do programmers prefer dark mode? Because light attracts bugs.`,
        `There are 10 types of people in the world: those who understand binary and those who don't.`,
        `A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"`,
        `Why did the developer go broke? Because he used up all his cache.`,
        `Hardware: the part of a computer that you can kick. Software: the part you can only curse at.`,
        `Debugging: removing the needles from the haystack.`,
        `It works on my machine — the classic production deployment strategy.`,
        `Why do Java developers wear glasses? Because they don't C#.`,
      ]),
    }));
  } else if (action === 'system.chit_chat.clear') {
    ws.send(JSON.stringify({ type: 'clear_console' }));
  } else if (action === 'system.chit_chat.help') {
    ws.send(JSON.stringify({ type: 'answer', data: buildHelpMessage(project, sessionContext) }));
  } else if (action === 'project.knowledge.overview') {
    const descEntry = project.config.entries?.find((e) => e.type === 'answer' && e.triggers?.some((t) => t.includes('describe') || t.includes('overview') || t.includes('what')));
    let responseText = `### ${project.name}\n\n**Path:** \`${project.path}\`\n**Config Entries:** ${project.config.entries?.length || 0} actions/answers.`;
    if (descEntry) {
      responseText = descEntry.response;
    } else if (project.contextFiles && project.contextFiles.length > 0) {
      const mainDoc = project.contextFiles[0];
      const snippet = mainDoc.content.substring(0, 500) + '...';
      responseText = `### Overview from ${mainDoc.filename}\n\n${snippet}`;
    }
    responseText = enrichWithIndex(responseText, project.codebaseIndex);
    const ctx = injectContext(input, action, project.codebaseIndex);
    if (ctx) responseText += `\n\n${ctx}`;
    responseText += '\n\n*Type "explain more" for deeper details.*';
    ws.send(JSON.stringify({ type: 'answer', data: responseText }));
  } else if (action === 'project.knowledge.stack') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Tech Stack\n\n${project.parsedKnowledge?.stack || 'No stack information parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.commands') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Commands\n\n${project.parsedKnowledge?.commands || 'No commands parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.gotchas') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Gotchas / Known Issues\n\n${project.parsedKnowledge?.gotchas || 'No known issues parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.architecture') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Architecture\n\n${project.parsedKnowledge?.architecture || 'No architecture information parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.how_to_run') {
    // Requested directly (2026-07-30): a purely informational "how do I run/install/set this up"
    // answer — distinct from `run_project`, which actually executes a command. This is meant to
    // answer "how much can trigger mode (no AI) understand from the README" specifically: it
    // never guesses silently, it always says where the answer came from (a documented command
    // vs. a language-based inference vs. "nothing found, turn on AI mode").
    const documented = findDocumentedRunCommands(project);
    const idx = project.codebaseIndex;
    let msg;
    if (documented.length) {
      const single = documented.length === 1;
      const lines = documented.map((d, i) => {
        const srcLabel = d.header
          ? `Documented in **${d.doc}** under "${d.header}"`
          : `Found this command in **${d.doc}**`;
        const code = `\`\`\`\n${d.command}\n\`\`\``;
        return single ? `${srcLabel}:\n\n${code}` : `${i + 1}. ${srcLabel}:\n\n${code}`;
      });
      msg = lines.join('\n\n');
    } else if (idx?.frameworks?.length || idx?.languages?.length) {
      const parts = [];
      if (idx.languages?.length) parts.push(`**Languages:** ${idx.languages.slice(0, 4).join(', ')}`);
      if (idx.frameworks?.length) parts.push(`**Detected stack:** ${idx.frameworks.join(', ')}`);
      if (idx.entryPoints?.length) parts.push(`**Entry point(s):** ${idx.entryPoints.join(', ')}`);
      msg = `No documented run command found in this project's README/CLAUDE.md, but here's what was detected from the code itself:\n\n${parts.join('\n')}\n\nSay "run project" and I'll suggest a command based on this, or turn AI mode on for it to work it out from the source directly.`;
    }
    // 2026-08-03 (requested directly): always also list every exact command this project has
    // configured (console.config.json entries), so "how do I run/do X" gets the full precise
    // command list even when the README documents nothing — and without duplicating an entry
    // already shown as the documented command above.
    const documentedCmds = new Set(documented.map((d) => d.command));
    const configured = (project.config?.entries || []).filter((e) => e.type === 'command' && e.action && !documentedCmds.has(e.action));
    if (configured.length) {
      const list = configured
        .map((e) => `- \`${e.action}\`${e.params?.length ? ` (asks for: ${e.params.map((p) => p.name).join(', ')})` : ''}`)
        .join('\n');
      msg = msg ? `${msg}\n\n**Configured commands (exact):**\n${list}` : `**Configured commands (exact):**\n${list}`;
    }
    if (!msg) {
      msg = `Nothing documented or detected about how to run this project. Try "run project" for a best-effort guess, or turn AI mode on.`;
    }
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  } else if (action === 'system.chit_chat.explain_followup') {
    if (sessionContext.lastTriggeredEntry) {
      const last = sessionContext.lastTriggeredEntry;
      const detailText = last.response || last.details || `Last triggered action was "${last.triggers?.[0] || 'command'}" (\`${last.action || 'answer'}\`).`;
      const ctx = injectContext(input, action, project.codebaseIndex);
      let msg = `### Detailed Follow-up regarding "${last.triggers?.[0]}":\n\n${detailText}`;
      if (ctx) msg += `\n\n${ctx}`;
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    } else {
      const detailEntry = project.config.entries?.find((e) => e.type === 'answer' && e.triggers?.some((t) => t.includes('explain') || t.includes('detail') || t.includes('architecture')));
      let detailText = `### Deep Dive [${project.name}]\n\n**Location:** \`${project.path}\``;
      if (detailEntry) {
        detailText = detailEntry.response;
      } else if (project.contextFiles && project.contextFiles.length > 0) {
        const mainDoc = project.contextFiles[0];
        detailText = `### Deep Dive from ${mainDoc.filename}\n\n${mainDoc.content.substring(0, 1500)}...`;
      }
      const idx = project.codebaseIndex;
      if (idx?.directoryTree?.length) {
        const treeLines = idx.directoryTree.slice(0, 20).map((d) => `  📁 ${d}`).join('\n');
        detailText += `\n\n**Directory Structure:**\n${treeLines}`;
        if (idx.directoryTree.length > 20) detailText += `\n  ... and ${idx.directoryTree.length - 20} more`;
      }
      if (idx?.fileSample?.length) {
        const sample = idx.fileSample.slice(0, 10).map((f) => `  📄 ${f}`).join('\n');
        detailText += `\n\n**Key Files:**\n${sample}`;
      }
      const ctx = injectContext(input, action, project.codebaseIndex);
      if (ctx) detailText += `\n\n${ctx}`;
      ws.send(JSON.stringify({ type: 'answer', data: detailText }));
    }
  } else if (action === 'system.chit_chat.yes_no') {
    // Inline yes/no handled at the confirmation prompt level — this is a fallback
    // in case someone types "yes" or "no" when no confirmation is pending.
    ws.send(JSON.stringify({ type: 'answer', data: 'No pending confirmation to respond to. Type "help" for available commands.' }));
  } else if (action === 'git_push') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then add a remote origin.` }));
    } else {
      // "push the site with the comment 'bug fixes'" can match this plain git_push intent
      // instead of system.chit_chat.deploy (their example phrases overlap heavily — both are
      // full of "push ..." variants), and this branch used to always push bare, silently
      // dropping any comment the user typed. Parse it the same way deploy does so the comment
      // isn't lost regardless of which of the two intents wins the match.
      const commitMsg = extractCommentMessage(input);
      const token = crypto.randomUUID();
      const command = commitMsg
        ? `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`
        : 'git push';
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: commitMsg
          ? `git add -A && git commit -m "${commitMsg}" && git push  (commits with your comment, then pushes)`
          : 'git push (pushes local commits to the remote repository)',
        trigger: 'git_push'
      }));
    }
  } else if (action === 'git_remote_add') {
    // "Can I attach the github link" had nowhere to go before — no intent existed for setting
    // up a remote at all, so it fell through to an unrelated generic help response. Parse a
    // URL out of the input; if there isn't one, ask for it instead of guessing.
    const urlMatch = input.match(/(https?:\/\/\S+|git@[\w.-]+:\S+)/i);
    if (!urlMatch) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Paste the GitHub repository URL (e.g. \`https://github.com/you/repo.git\`) and I'll set it as the remote.`
      }));
    } else if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then I can add the remote.` }));
    } else {
      const url = urlMatch[1].replace(/["').,]+$/, '');
      const token = crypto.randomUUID();
      // Works whether "origin" already exists or not, without needing an extra round trip to check.
      const command = `git remote add origin ${url} || git remote set-url origin ${url}`;
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `${command}  (sets "origin" to ${url})`,
        trigger: 'git_remote_add'
      }));
    }
  } else if (action === 'git_commit') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first.` }));
    } else {
      // Extract a commit message from the user's input if possible
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `git add -A && git commit -m "${commitMsg}" (stages all and commits)`,
        trigger: 'git_commit'
      }));
    }
  } else if (action === 'git_commit_push') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then add a remote origin.` }));
    } else {
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `git add -A && git commit -m "${commitMsg}" && git push (stages all, commits, and pushes)`,
        trigger: 'git_commit_push'
      }));
    }
  } else if (action === 'git_add') {
    executeCommand('git add -A', project.path, ws, project.id);
    return true;
  } else if (action === 'git_init') {
    // Confirmed live 2026-07-29: "set up git for this folder" was tried twice in one session —
    // every other git-setup intent here already checks isGitRepo() before acting (git_push/
    // git_commit/deploy all tell the user to run git init first if there's *no* repo yet), but
    // this was the one path that didn't check the other direction. `git init` on an already-
    // initialized repo is technically harmless (git just reinitializes in place, same .git
    // folder, no data loss), but there's no reason to even offer a confirm prompt for a no-op —
    // short-circuit with a clear "already set up" message instead.
    if (await isGitRepo(project.path)) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** is already a git repository — nothing to set up. Try "git status" to see its current state.`
      }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id,
        command: 'git init',
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: 'git init (creates a new git repository here)',
        trigger: 'git_init'
      }));
    }
  } else if (action === 'git_ignore_add') {
    // Extract what to ignore from input, default to node_modules
    const ignoreMatch = input.match(/(?:add|ignore)\s+(.+?)\s+(?:to\s+)?gi?ignore/i);
    const toIgnore = ignoreMatch ? ignoreMatch[1].trim() : 'node_modules';
    // Use windows-compatible echo to append
    executeCommand(`echo "${toIgnore}" >> .gitignore`, project.path, ws, project.id);
    return true;
  } else if (action === 'git_rm_cached') {
    const rmMatch = input.match(/(?:remove|untrack|rm)\s+(.+?)\s+(?:from\s+)?(?:git|tracking)/i);
    const toRemove = rmMatch ? rmMatch[1].trim() : 'node_modules';
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      projectId: project.id,
      command: `git rm --cached -r "${toRemove}"`,
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: `git rm --cached -r "${toRemove}" (removes from tracking, keeps on disk)`,
      trigger: 'git_rm_cached'
    }));
  } else if (action === 'npm_install') {
    executeCommand('npm install', project.path, ws, project.id);
    return true;
  } else if (action === 'npm_build') {
    executeCommand('npm run build', project.path, ws, project.id);
    return true;
  } else if (action === 'npm_run') {
    // Load scripts from codebase index
    let scripts = {};
    try { scripts = JSON.parse(project.codebaseIndex?.keyFiles?.['package.json'] || '{}').scripts || {}; } catch {}
    // Try to extract a script name from "run dev" / "run the dev script" patterns
    const runMatch = input.match(/(?:run|execute)\s+(?:the\s+)?["']?(\w+(?:-\w+)*)["']?/i);
    if (runMatch) {
      const scriptName = runMatch[1];
      if (scripts[scriptName]) {
        // Same duplicate-dev-server guard as run_project — see that handler's comment for the
        // real transcript this fixes. Only applies to dev-server-shaped script names; anything
        // else (test, build, lint, the project's own custom scripts) always re-runs freely.
        const tracked = ['dev', 'start', 'serve'].includes(scriptName) ? runningProcesses.get(project.id) : null;
        if (tracked) {
          const url = state.lastDevUrls.get(project.id);
          ws.send(JSON.stringify({
            type: 'answer',
            data: `**[${project.name}]** already has \`${tracked.command}\` running${url ? ` at ${url}` : ''} — say "stop server" first if you want to restart it.\n`
          }));
          return true;
        }
        executeCommand(`npm run ${scriptName}`, project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No script called **\`${scriptName}\`** found in \`package.json\`.` }));
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // "npm serve" / "npm start" shortcut — no "run" keyword
    const serveMatch = input.match(/\bnpm\s+serve\b/i);
    if (serveMatch && scripts.serve) {
      executeCommand('npm run serve', project.path, ws, project.id);
      return true;
    }
    const startDirect = input.match(/\bnpm\s+start\b/i);
    if (startDirect && scripts.start) {
      executeCommand('npm start', project.path, ws, project.id);
      return true;
    }
    // Try "start the dev server" / "start a live server" patterns
    const startMatch = input.match(/start\s+(?:the\s+|a\s+)?(?:live\s+)?(?:dev\s+)?(?:server|site|app)\b/i);
    if (startMatch) {
      if (scripts.dev) {
        executeCommand('npm run dev', project.path, ws, project.id);
      } else if (scripts.start) {
        executeCommand('npm start', project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No \`dev\` or \`start\` script found in \`package.json\`.` }));
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // Try "start developing" / "start dev mode"
    if (/\bstart\s+developing\b|\bstart\s+dev\s+mode\b/i.test(input)) {
      if (scripts.dev) {
        executeCommand('npm run dev', project.path, ws, project.id);
      } else if (scripts.start) {
        executeCommand('npm start', project.path, ws, project.id);
      } else {
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // Fallback: show available scripts or project type suggestions
    await projectTypeSuggestions(ws, project, input, scripts);
    return true;
  } else if (action === 'file_create') {
    // Trigger mode never had a route to actually create a file — "add a file" always bounced
    // to "turn on AI mode", which meant the whole feature was blocked on having Ollama running.
    // Reading/writing/appending a file for an unambiguous, explicitly-named request doesn't need
    // an LLM's judgment at all — it's the same deterministic sandboxed tools.js functions the AI
    // path already uses, just invoked directly from a regex-parsed request instead of a model's
    // tool call. Still gated behind the same confirm-before-write flow as every other mutation.
    const parsed = parseFileNameAndContent(input);
    if (!parsed.fileName) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `What should I name the file, and what should it contain? Try: "create a file called notes.md with the text 'Hello World'".`
      }));
    } else if (!parsed.content) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `What should **${parsed.fileName}** contain? Try: "create a file called ${parsed.fileName} with the text '...'" — or turn AI mode ON for open-ended content.`
      }));
    } else {
      // Confirmed live 2026-07-29, in the same spirit as the git_init fix above: writeFile
      // overwrites unconditionally with no existence check, and the confirm prompt used to say
      // the same generic "Write X (N chars)" whether the file was brand new or about to replace
      // something already there. Check first so an existing file gets an explicit overwrite
      // warning instead of a silently identical-looking prompt.
      const tools = await createProjectTools(project);
      const existing = await tools.readFile({ path: parsed.fileName });
      const summary = existing.success
        ? `⚠️ Overwrite existing "${parsed.fileName}" (${existing.data.length} chars) with new content (${parsed.content.length} chars)`
        : `Write "${parsed.fileName}" (${parsed.content.length} chars)`;
      queueFileOpConfirmation(ws, project, input, {
        tool: 'writeFile',
        args: { path: parsed.fileName, content: parsed.content },
        summary,
      });
    }
  } else if (action === 'file_append') {
    const parsed = parseFileNameAndContent(input);
    if (!parsed.fileName || !parsed.content) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Tell me the file and the text to add, e.g. "append to notes.md the text 'remember to test this'".`
      }));
    } else {
      queueFileOpConfirmation(ws, project, input, {
        tool: 'appendToFile',
        args: { path: parsed.fileName, content: parsed.content },
        summary: `Append to "${parsed.fileName}" (${parsed.content.length} chars)`,
      });
    }
  } else if (action === 'run_tests') {
    // Intent expansion (Phase 1, 2026-08-03): "run the tests" previously only answered ABOUT
    // tests (project.context.tests, informational). This executes the project's real test command
    // by marker detection — same style as run_project's marker checks below. Tests re-run
    // freely (no dev-server duplicate guard, no confirm) per the existing npm_run rule.
    // Detection shares runTests's single source of truth (tools.js findTestCommand) so the two
    // paths can never drift — see Phase 5 PASS 5.3.
    const testCommand = findTestCommand(project);
    if (testCommand) {
      executeCommand(testCommand, project.path, ws, project.id);
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `No test setup detected for **[${project.name}]** (no package.json test script, Cargo.toml, go.mod, or Python test marker). Say "tell me about the tests" to see what's here.` }));
    }
    return true;
  } else if (action === 'file_read') {
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file would you like me to read?` }));
    } else {
      const tools = await createProjectTools(project);
      const result = await tools.readFile({ path: fileName });
      if (result.success) {
        const body = result.data.length > 3000 ? result.data.slice(0, 3000) + '\n… (truncated)' : result.data;
        ws.send(JSON.stringify({ type: 'answer', data: `**${fileName}**\n\`\`\`\n${body}\n\`\`\`` }));
      } else {
        // Ambiguous or missing file — suggest real matches instead of just failing, same
        // convention the AI path already follows (findFiles before guessing at the wrong file).
        const matches = await tools.findFiles({ pattern: fileName });
        if (matches.success && matches.data.length > 0) {
          const list = matches.data.slice(0, 8).map(f => `  - ${f}`).join('\n');
          ws.send(JSON.stringify({ type: 'answer', data: `Couldn't find "${fileName}" exactly. Did you mean one of these?\n${list}` }));
        } else {
          ws.send(JSON.stringify({ type: 'answer', data: result.error }));
        }
      }
    }
  } else if (action === 'file_find') {
    // Intent expansion (Phase 1, 2026-08-03): the dedicated "where is the file X" / "find the
    // config file" path — parses the name loosely (same parseFileNameOnly as file_read) and
    // runs the same sandboxed findFiles() the AI path uses. Read-only, immediate; "no matches"
    // is stated plainly instead of a generic failure.
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file are you looking for? Try "where is main.py" or "find the config file".` }));
    } else {
      const tools = await createProjectTools(project);
      const matches = await tools.findFiles({ pattern: fileName });
      if (matches.success && matches.data.length > 0) {
        const capped = matches.data.slice(0, 15);
        const list = capped.map((f) => `  - \`${f}\``).join('\n');
        let msg = `Found ${matches.data.length} match${matches.data.length === 1 ? '' : 'es'} for **${fileName}** in **[${project.name}]**:\n${list}`;
        if (matches.data.length > capped.length) msg += `\n  … and ${matches.data.length - capped.length} more`;
        ws.send(JSON.stringify({ type: 'answer', data: msg }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No files match **"${fileName}"** in **[${project.name}]**. Try a different name, or "show me the project structure" to see what's here.` }));
      }
    }
  } else if (action === 'file_delete') {
    ws.send(JSON.stringify({ type: 'answer', data: `To delete files, turn **AI mode** ON and say "delete the file X" or "remove file Y" — I'll ask for confirmation before making destructive changes.` }));
  } else if (action === 'project_scan') {
    ws.send(JSON.stringify({ type: 'answer', data: `To reindex this project, select it again in the project list (web UI) or type "projects" (CLI chat) — either one triggers a fresh index.` }));
  } else if (action === 'project_list') {
    // Confirmed live 2026-07-29: this used to fall through to project_scan's reindex answer and
    // tell people to "restart the console" — wrong on both counts (nothing here is about
    // reindexing, and switching projects never required a restart). Real fix: a dedicated intent
    // that lists what's actually available and points at the real switch mechanism for whichever
    // interface the user is in — a project card click in the web UI, or the CLI's own "projects"
    // command (added alongside this).
    const projects = state.activeProjectsCache || [];
    const list = projects.length > 0
      ? projects.map((p) => `  - ${p.name}`).join('\n')
      : '  (none found — is the scan directory set correctly?)';
    ws.send(JSON.stringify({
      type: 'answer',
      data: `**Available projects:**\n${list}\n\nIn the web UI, click a different project card in the sidebar to switch — no restart needed. In CLI chat, type "projects" to rescan and pick a different one.`,
    }));
  } else if (action === 'system.chit_chat.port') {
    // See intentsData.js's 'system.chit_chat.port' comment — this used to have no real intent
    // and fell through to a generic status reply that never actually named a port.
    ws.send(JSON.stringify({
      type: 'answer',
      data: state.serverPort
        ? `This console itself is running on port **${state.serverPort}** (http://127.0.0.1:${state.serverPort}). If you meant this project's own dev server, ask "what is the link" instead.`
        : `I don't have a confirmed server port yet — try refreshing the page, or check the terminal that launched "npm run dev".`,
    }));
  } else if (action === 'git_log') {
    executeCommand('git log --oneline -10', project.path, ws, project.id);
    return true;
  } else if (action === 'git_branch') {
    executeCommand('git branch', project.path, ws, project.id);
    return true;
  } else if (action === 'git_checkout') {
    ws.send(JSON.stringify({ type: 'answer', data: `To switch branches, use AI mode or run \`git checkout <branch-name>\` directly. You can also tell me the branch name and I'll set up the command for confirmation.` }));
  } else if (action === 'git_diff') {
    // Safe/read-only, same treatment as git_log/git_branch — no confirmation needed.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      executeCommand('git diff', project.path, ws, project.id);
      return true;
    }
  } else if (action === 'git_stash') {
    // New (2026-07-30, requested directly). Confirm-gated even though `git stash` is technically
    // reversible via `git stash pop` — it can look like uncommitted work "disappeared" from the
    // working tree, which is exactly the kind of surprising-but-recoverable action this app's
    // existing safety model (see CLAUDE.md) already requires a confirm step for.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { projectId: project.id, command: 'git stash', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash (shelves uncommitted changes — restore later with "git stash pop")', trigger: 'git_stash' }));
    }
  } else if (action === 'git_stash_list') {
    // New (2026-08-03, Phase 3 of the intent-expansion spec). Read-only listing, same immediate
    // treatment as git_log/git_branch — never touches the stash itself.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      executeCommand('git stash list', project.path, ws, project.id);
      return true;
    }
  } else if (action === 'git_stash_pop') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { projectId: project.id, command: 'git stash pop', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash pop (restores the most recently stashed changes — can conflict with current changes)', trigger: 'git_stash_pop' }));
    }
  } else if (action === 'git_branch_create') {
    // New (2026-07-30, requested directly). Same injection-safety check paramCommand.js's
    // parameterized commands already use for user-supplied values substituted into a command
    // string — a branch name is exactly that kind of value.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const branchMatch = input.match(/(?:branch|create a branch|new branch|make a branch)(?:\s+called|\s+named)?\s+["'`]?([\w./-]+)["'`]?/i);
      const branchName = branchMatch?.[1];
      if (!branchName || !isSafeParamValue(branchName)) {
        ws.send(JSON.stringify({ type: 'answer', data: `What should the new branch be called? Try "create a branch called feature-x".` }));
      } else {
        const token = crypto.randomUUID();
        const command = `git checkout -b ${branchName}`;
        pendingConfirmations.set(token, { projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates and switches to a new branch)`, trigger: 'git_branch_create' }));
      }
    }
  } else if (action === 'git_pull') {
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      projectId: project.id,
      command: 'git pull',
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: 'git pull (fetches and merges remote changes)',
      trigger: 'git_pull'
    }));
  } else if (action === 'git_fetch') {
    // Intent expansion (Phase 2, 2026-08-03): read-only — updates remote-tracking refs, never
    // touches the working tree. Same immediate treatment as git_log/git_branch.
    executeCommand('git fetch', project.path, ws, project.id);
    return true;
  } else if (action === 'git_ahead_behind') {
    // Intent expansion (Phase 2, 2026-08-03): "am I behind origin" — git status -sb prints the
    // "[origin/main: ahead 2, behind 1]" line directly; no parsing needed. Read-only, immediate.
    executeCommand('git status -sb', project.path, ws, project.id);
    return true;
  } else if (action === 'git_tag') {
    // Intent expansion (Phase 2, 2026-08-03): no tag name -> list (read-only, immediate, same
    // as git_log); a tag name -> confirm-gated `git tag <name>`. The name is validated with
    // isSafeParamValue BEFORE the confirm prompt, exactly like git_branch_create, since it
    // substitutes straight into the command string.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const tagName = (input.match(/(?:called|named)\s+([A-Za-z0-9._/-]+)/i) ||
                       input.match(/\btag(?: this)?(?: as)?\s+([A-Za-z0-9._/-]+)/i))?.[1] || null;
      if (!tagName) {
        executeCommand('git tag', project.path, ws, project.id);
      } else if (!isSafeParamValue(tagName)) {
        ws.send(JSON.stringify({ type: 'answer', data: `Tag name **${tagName}** contains characters that aren't allowed. Use letters, numbers, dots, underscores, slashes, and hyphens.` }));
      } else {
        const token = crypto.randomUUID();
        const command = `git tag ${tagName}`;
        pendingConfirmations.set(token, { projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates a tag on the current commit)`, trigger: 'git_tag' }));
      }
    }
  } else if (action === 'project.workflow.checkpoint') {
    // Intent expansion (Phase 2, 2026-08-03, requested directly): an explicit user-asked
    // checkpoint commit — same createCheckpoint the auto-checkpoint-before-risky-commands flow
    // uses. A normal, recoverable commit, so no confirm; non-git projects get createCheckpoint's
    // own message surfaced as-is.
    const result = await createCheckpoint(project.path, input);
    if (result.success) {
      ws.send(JSON.stringify({ type: 'answer', data: result.message }));
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: (result.message || result.error || 'Checkpoint failed.') + '\n' }));
    }
    return true;
  } else if (action === 'run_project') {
    // Try to detect the project type and run appropriately
    const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
    let scripts = {};
    if (pkgJson) {
      try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {}
    }

    // Prefer a script the user actually named ("run its server", "is the server running") over
    // the generic dev/start/serve default — see findMentionedScript's own comment for the real
    // transcript this fixes. dev/start/serve fall through to the normal path below unchanged.
    const mentioned = findMentionedScript(input, scripts);
    if (mentioned && !['dev', 'start', 'serve'].includes(mentioned)) {
      executeCommand(`npm run ${mentioned}`, project.path, ws, project.id);
      return true;
    }

    // Confirmed live 2026-07-30: nothing here ever checked whether a dev server was already
    // running for this project before spawning another one — three separate "run ..." messages
    // in one session ("run dev", "run its server", "run .bat") each blindly launched a fresh
    // `npm run dev`, leaving three redundant Vite instances on 3001/3002/3003 all serving the
    // same project. `runningProcesses` (executor.js) is the same map "stop server" already reads.
    const tracked = runningProcesses.get(project.id);
    if (tracked && (scripts.dev || scripts.start || scripts.serve)) {
      const url = state.lastDevUrls.get(project.id);
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** already has \`${tracked.command}\` running${url ? ` at ${url}` : ''} — say "stop server" first if you want to restart it.\n`
      }));
      return true;
    }

    // Check for known dev/start scripts first
    if (scripts.dev) {
      executeCommand('npm run dev', project.path, ws, project.id);
    } else if (scripts.start) {
      executeCommand('npm start', project.path, ws, project.id);
    } else if (scripts.serve) {
      executeCommand('npm run serve', project.path, ws, project.id);
    } else {
      await projectTypeSuggestions(ws, project, input, scripts);
    }
    return true;
  } else if (action === 'system.chit_chat.git_status') {
    executeCommand('git status --short', project.path, ws, project.id);
    return true;
  } else if (action === 'system.chit_chat.deploy') {
    // "Deploy" for Tobi's Vercel-connected projects is just "get my changes to GitHub" —
    // Vercel auto-deploys on push. If the user gave a custom comment ("push the site with
    // the comment 'bug fixes'"), commit with that message explicitly instead of relying on
    // the generic "console-checkpoint: before ..." auto-checkpoint — otherwise the comment
    // the user typed is silently discarded and never ends up in git history at all.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** isn't a git repository yet, so there's nothing to push. Run \`git init\`, add a remote, and push once manually — after that "deploy" will work here.`
      }));
    } else {
      const commitMsg = extractCommentMessage(input);
      const token = crypto.randomUUID();
      const command = commitMsg
        ? `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`
        : 'git push';
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt',
        token,
        command: commitMsg
          ? `git add -A && git commit -m "${commitMsg}" && git push  (commits with your comment, then pushes — Vercel deploys on push)`
          : 'git push  (commits all changes first, then pushes — Vercel deploys on push)',
        trigger: 'deploy'
      }));
    }
  } else if (action === 'project.context.structure') {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No indexed structure available for **[${project.name}]**. Run a re-index first.` }));
    } else {
      let msg = `### Directory Structure [${project.name}]\n\n**${idx.totalDirs} directories, ${idx.totalFiles} files**\n`;
      if (idx.directoryTree.length) {
        msg += '\n```\n' + idx.directoryTree.join('\n') + '\n```';
      }
      if (idx.fileSample.length) {
        msg += `\n\n**Sample files (${idx.fileSample.length} shown):**\n` + idx.fileSample.map((f) => `- ${f}`).join('\n');
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  } else if (action === 'project.context.languages') {
    const idx = project.codebaseIndex;
    if (!idx?.languages?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No language data indexed for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Languages in [${project.name}]\n\n${idx.languages.map((l) => `- ${l}`).join('\n')}` }));
    }
  } else if (action === 'project.context.file_count') {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No index data for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Project Size [${project.name}]\n\n- **Total files:** ${idx.totalFiles}\n- **Total directories:** ${idx.totalDirs}\n- **Languages:** ${(idx.languages || []).slice(0, 5).join(', ') || 'N/A'}` }));
    }
  } else if (action === 'project.context.entry_point') {
    const idx = project.codebaseIndex;
    if (!idx?.entryPoints?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No entry point detected for **[${project.name}]**. Try "show me the project structure" to explore.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Entry Points [${project.name}]\n\n${idx.entryPoints.map((e) => `- \`${e}\``).join('\n')}` }));
    }
  } else if (action === 'project.context.tech_preview') {
    const idx = project.codebaseIndex;
    let msg = `### Tech Preview [${project.name}]\n\n`;
    if (idx) {
      msg += `**${idx.totalFiles} files** across **${idx.totalDirs} directories**.\n\n`;
      if (idx.languages?.length) msg += `**Languages:** ${idx.languages.slice(0, 4).join(', ')}\n`;
      if (idx.entryPoints?.length) msg += `**Entry points:** ${idx.entryPoints.join(', ')}\n`;
      if (idx.hasTests) msg += '**Has tests**\n';
      if (idx.hasCli) msg += '**Has CLI**\n';
      if (idx.hasConfig) msg += '**Has config**\n';
      if (idx.directoryTree?.length) {
        msg += `\n**Top-level dirs:** ${idx.directoryTree.filter((d) => !d.includes('\\')).join(', ')}\n`;
      }
    } else {
      msg += 'No codebase index available. Use a tool to scan the project first.';
    }
    const ctxTp = injectContext(input, action, project.codebaseIndex);
    if (ctxTp) msg += `\n\n${ctxTp}`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  } else if (action === 'project.context.tests') {
    const idx = project.codebaseIndex;
    if (!idx || !idx.hasTests) {
      ws.send(JSON.stringify({ type: 'answer', data: `No tests detected for **[${project.name}]**.` }));
    } else {
      let msg = `### Tests [${project.name}]\n\n✅ Test files detected.\n`;
      if (idx.fileSample) {
        const testFiles = idx.fileSample.filter((f) =>
          f.includes('test') || f.includes('spec') || f.includes('.test.')
        );
        if (testFiles.length > 0) {
          msg += `\n**Test files found:**\n${testFiles.map((f) => `- \`${f}\``).join('\n')}`;
        }
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  } else if (action === 'project.context.dependencies') {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dependency information for **[${project.name}]**.` }));
    } else {
      const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'go.mod'];
      let found = false;
      let msg = `### Dependencies [${project.name}]\n\n`;
      for (const name of depFiles) {
        if (idx.keyFiles[name]) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
          found = true;
        }
      }
      if (!found) msg += 'No standard dependency files detected.';
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  } else if (action === 'project.context.config') {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No config information for **[${project.name}]**.` }));
    } else {
      const configFiles = Object.keys(idx.keyFiles).filter(
        (name) => name.includes('.env') || name.includes('config') || name.endsWith('.json')
      );
      if (configFiles.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: `No config files detected for **[${project.name}]**.` }));
      } else {
        let msg = `### Configuration [${project.name}]\n\n`;
        for (const name of configFiles.slice(0, 3)) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
        }
        ws.send(JSON.stringify({ type: 'answer', data: msg }));
      }
    }
  } else if (action === 'project.context.routes') {
    // New (2026-07-30, requested directly): surfaces idx.apiRoutes (Express/Flask/FastAPI/Django
    // route declarations — see codebaseIndexer.js's extractRoutes()) that was already being
    // collected for the AI system prompt but had no trigger-mode-visible way to ask for it.
    const idx = project.codebaseIndex;
    const routesText = formatApiRoutes(idx?.apiRoutes, 3000);
    if (!routesText) {
      ws.send(JSON.stringify({ type: 'answer', data: `No API routes detected for **[${project.name}]** (only Express/Flask/FastAPI/Django route declarations are recognized).` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Detected API routes [${project.name}]\n\n\`\`\`\n${routesText}\n\`\`\`` }));
    }
  } else if (action === 'project.context.file_relations') {
    // New (2026-07-30, requested directly): "which files import X" / "who uses this file" —
    // leverages the reverse-import index already attached to each repoMap entry
    // (buildReverseImportIndex() in codebaseIndexer.js) instead of scanning anything fresh.
    const idx = project.codebaseIndex;
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file? Try "which files import utils.js" or "what does state.js import".` }));
    } else {
      const entry = (idx?.repoMap || []).find((e) => e.path === fileName || e.path.endsWith('/' + fileName) || e.path.endsWith('\\' + fileName));
      if (!entry) {
        ws.send(JSON.stringify({ type: 'answer', data: `Couldn't find "${fileName}" in the indexed repo map. Try "read file ${fileName}" to check the exact path, or re-scan the project.` }));
      } else {
        const parts = [`### ${entry.path}`];
        parts.push(entry.imports?.length ? `**Imports:** ${entry.imports.join(', ')}` : '**Imports:** (none detected)');
        parts.push(entry.importedBy?.length ? `**Imported by:** ${entry.importedBy.join(', ')}` : '**Imported by:** (no other indexed file imports this — or it\'s not a local import)');
        ws.send(JSON.stringify({ type: 'answer', data: parts.join('\n') }));
      }
    }
  } else if (action === 'project.context.monorepo') {
    // New (2026-07-30, requested directly): surfaces idx.subPackages/isMonorepo (see
    // codebaseIndexer.js's detectSubPackages()).
    const idx = project.codebaseIndex;
    if (!idx?.isMonorepo) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** doesn't look like a monorepo — only one manifest file (package.json/pyproject.toml/Cargo.toml/etc.) was found.` }));
    } else {
      const list = idx.subPackages.map((p) => `- \`${p.path}\` (${p.manifests.join(', ')})`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### [${project.name}] looks like a monorepo\n\n${idx.subPackages.length} sub-packages detected:\n\n${list}\n\nEach should likely be run/installed independently.` }));
    }
  } else if (action === 'project.context.todos') {
    // New (2026-07-30, requested directly): "find all todos" — a fresh on-demand scan (see
    // codebaseIndexer.js's findTodos()), not part of the cached index since it's asked for
    // rarely enough that paying the cost on-demand beats slowing down every project select.
    const todos = await findTodos(project.path);
    if (!todos.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No TODO/FIXME/HACK/XXX comments found in **[${project.name}]** (scanned up to 150 code files).` }));
    } else {
      const list = todos.map((t) => `- **${t.tag}** \`${t.file}:${t.line}\`${t.text ? ` — ${t.text}` : ''}`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### TODO/FIXME markers in [${project.name}]\n\n${list}${todos.length >= 60 ? '\n\n_(capped at 60 results)_' : ''}` }));
    }
  } else if (action === 'project.context.biggest_files') {
    // New (2026-07-30, requested directly): "what's the biggest file" — on-demand fs.stat scan
    // (see codebaseIndexer.js's findBiggestFiles()), same on-demand-only reasoning as TODOs above.
    const biggest = await findBiggestFiles(project.path, 10);
    if (!biggest.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `Couldn't determine file sizes for **[${project.name}]**.` }));
    } else {
      const list = biggest.map((f) => `- \`${f.path}\` — ${(f.bytes / 1024).toFixed(1)} KB`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Largest files in [${project.name}]\n\n${list}` }));
    }
  } else if (action === 'project.context.dev_server_status') {
    // Intent expansion (Phase 1, 2026-08-03): "is the server running" / "is the site live" /
    // "what's the URL" now has a real intent instead of depending on a config entry or the
    // "what is the link" pre-check in connection.js happening to catch the phrasing. Reads the
    // same runningProcesses + lastDevUrls the pre-check reports — read-only, immediate, and the
    // port-collision heads-up is applied the same way the pre-check applies it.
    const proc = runningProcesses.get(project.id);
    const url = state.lastDevUrls.get(project.id);
    if (proc) {
      let msg = `**[${project.name}]** has \`${proc.command}\` running right now.`;
      if (url) msg += `\n\nOpen it at **${url}** — or say "what is the link" to see it again.`;
      else msg += `\n\nThe process is tracked but no local URL was detected yet — it may still be starting up, or it doesn't expose an HTTP server.`;
      ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(msg, url) }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has no server running right now. Say "run the site" to start it, or "how do I run this" for instructions.` }));
    }
  } else if (action === 'project.context.recent_activity') {
    // Intent expansion (Phase 2, 2026-08-03): on-demand file-mtime scan via findRecentActivity
    // (same readProjectTree walk findBiggestFiles uses — IGNORE_DIRS + dotfile skipping included),
    // deliberately not part of the cached index since it's asked for rarely.
    try {
      const recent = await findRecentActivity(project.path, { limit: 10 });
      if (!recent.length) {
        ws.send(JSON.stringify({ type: 'answer', data: `No recently modified files found for **[${project.name}]**.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `### Recently modified [${project.name}]\n\n` + recent.map(f => `- \`${f.path}\` — ${new Date(f.mtime).toLocaleString()}`).join('\n') }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Could not scan recent activity: ${err.message}\n` }));
    }
    return true;
  } else if (action === 'system.monitoring.metrics') {
    const { default: fetch } = await import('node-fetch');
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/metrics`);
      const snap = await res.json();
      const counters = Object.entries(snap.counters || {}).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
      let histoLines = '';
      for (const [name, stats] of Object.entries(snap.histograms || {})) {
        if (stats) {
          histoLines += `\n**${name}** — count: ${stats.count}, avg: ${stats.avg.toFixed(0)}ms, p95: ${stats.p95}ms, p99: ${stats.p99}ms`;
        }
      }
      const recent = (snap.recentEvents || []).slice(-10).map((e) =>
        `- ${e.type} (${new Date(e.ts).toLocaleTimeString()})${e.duration ? ` ${e.duration}ms` : ''}${e.outcome ? ` → ${e.outcome}` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\n**Counters:**\n${counters || '_(none)_'}\n\n**Latency:**${histoLines || ' _(none)_'}\n\n**Recent Events:**\n${recent || ' _(none)_'}` }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\nCould not fetch metrics: ${err.message}` }));
    }
  } else if (action === 'project.action.open_in_vscode') {
    // Phase 3 (2026-08-03): open project folder in VS Code. If `code` not on PATH, answer with
    // guidance instead of the raw error.
    const { spawn } = await import('child_process');
    const child = spawn('code', [project.path], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH. Open VS Code manually and use File → Open Folder → \`${project.path}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open VS Code: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** in VS Code...` }));
  } else if (action === 'project.action.open_in_explorer') {
    // Phase 3 (2026-08-03): open project folder in OS file explorer — branch on platform.
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let cmd, args;
    if (isWindows) {
      cmd = 'explorer';
      args = [project.path];
    } else if (isMac) {
      cmd = 'open';
      args = [project.path];
    } else {
      cmd = 'xdg-open';
      args = [project.path];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open folder: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** folder in file explorer...` }));
  } else if (action === 'project.action.open_site') {
    // Phase 3 (2026-08-03): open the dev server URL in browser. Reads state.lastDevUrls.
    const url = state.lastDevUrls.get(project.id);
    if (!url) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dev server URL recorded for **[${project.name}]**. Say "run the site" to start it, or "what is the link" if you think it's already running.` }));
      return true;
    }
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
    const args = isWindows ? ['', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **${url}** in your browser...` }));
  } else if (action === 'project.action.copy_path') {
    // Phase 3 (2026-08-03): emit copy_to_clipboard WS event — frontend handles clipboard write.
    ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: project.path }));
    ws.send(JSON.stringify({ type: 'answer', data: `Copied **[${project.name}]** path to clipboard:\n\`${project.path}\`` }));
  } else if (action === 'git_remote_info') {
    // Phase 3 (2026-08-03): read-only `git remote -v` — same isGitRepo gate as git_diff.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. No remotes to show.` }));
    } else {
      executeCommand('git remote -v', project.path, ws, project.id);
    }
  } else if (action === 'project.context.running_processes') {
    // Phase 3 (2026-08-03): GLOBAL list across ALL projects from runningProcesses + lastDevUrls.
    const procs = [];
    for (const [pid, info] of runningProcesses) {
      const proj = state.activeProjectsCache.find((p) => p.id === pid);
      const url = state.lastDevUrls.get(pid);
      procs.push({ project: proj?.name || pid, command: info.command, url, runningSince: info.startedAt });
    }
    if (procs.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `Nothing running across all projects. Say "run the site" in a project to start one.` }));
    } else {
      const lines = procs.map((p) =>
        `- **[${p.project}]** \`${p.command}\`${p.url ? ` — ${p.url}` : ''}${p.runningSince ? ` (since ${new Date(p.runningSince).toLocaleTimeString()})` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Running processes\n\n${lines}` }));
    }
  } else if (action === 'project.context.session_info') {
    // Phase 3 (2026-08-03): session count + most recent 3 from conversationStore index.
    const { listSessions } = await import('../conversationStore.js');
    const sessions = await listSessions();
    if (sessions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No chat sessions found.` }));
    } else {
      const recent = sessions.slice(0, 3).map((s) =>
        `- **${s.title}** ([${s.projectName}] — ${new Date(s.updatedAt).toLocaleString()})`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Chat sessions (${sessions.length} total)\n\n${recent}${sessions.length > 3 ? `\n\n...and ${sessions.length - 3} more` : ''}` }));
    }
  } else {
    return false; // unrecognized intent
  }
  return true;
}
