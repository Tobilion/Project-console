// Phase 7 (2026-08-11): per-project auto-start. A user who opts in ("enable auto-start for
// this project") gets their project's dev server started automatically every time the console
// boots — no need to re-type the run command after every restart.
//
// Persistence: data/auto-start.json (gitignored — machine-local convenience, same treatment
// as schedules/notifications). The in-memory map is the source of truth; this module only
// mirrors it to disk, debounced.
//
// Boot runner (initAutoStart, called from server/index.js after semanticMatcher is ready):
//   - only projects still present in activeProjectsCache are considered;
//   - the project's candidate dev URLs (package.json port hints / common dev ports) are
//     probed FIRST — when one already answers, the site is up (the user's own manual instance
//     or a leftover one), and auto-start skips it instead of double-serving;
//   - the stored phrase is re-matched through the same pipeline a typed message would use,
//     and the resolved intent must be launch-shaped (run_project / npm_run / run_tests) or a
//     configured command entry — this is the drift guard: if the embedding later resolves
//     "run the site" to something that isn't a launch (e.g. git push), nothing runs, the
//     skip is logged, and the answer explains why;
//   - runs are staggered (AUTO_START_STAGGER_MS apart) and go through taskQueue's per-project
//     FIFO, so several opted-in projects boot one after another without saturating the machine
//     or blocking a chat turn; taskQueue completion hooks fire 'task-done' notifications.
//
// Delivery: same pattern as scheduleFire — the first live session of that project receives
// the collected output (renders AND persists like a normal answer), else it lands in
// data/auto-start-log.md. Confirm prompts that need a human (risky config entries) are
// collected into the log and expire harmlessly via the pending-confirmation TTL — a
// boot-time auto-start never auto-approves anything.

import fs from 'fs';
import path from 'path';
import { state, connectionRegistry } from './state.js';
import { enqueueTask } from './taskQueue.js';
import { matchInput } from './matcher.js';
import { handleBuiltinIntent } from './wsHandlers/builtinIntents.js';
import { handleMatchedEntry } from './wsHandlers/matchedEntry.js';
import { candidateDevUrls, probeUrl } from './livenessProbe.js';
import { writeFileAtomicSync } from './atomicWrite.js';

const AUTO_START_FILE = path.join(process.cwd(), 'data', 'auto-start.json');
const AUTO_START_LOG_FILE = path.join(process.cwd(), 'data', 'auto-start-log.md');
const AUTO_START_LOG_CAP_LINES = 200;
const AUTO_START_STAGGER_MS = 20 * 1000;
const AUTO_START_PROBE_TIMEOUT_MS = 1500;
const SAVE_DEBOUNCE_MS = 500;

// Only launch-shaped builtins may run unattended at boot. Anything else that the stored
// phrase might drift onto (deploy, git_push, chit-chat...) is skipped and logged.
const LAUNCH_INTENTS = new Set(['run_project', 'npm_run', 'run_tests']);

let autoStart = { projects: {} };
let saveTimer = null;

function persist() {
  try {
    fs.mkdirSync(path.dirname(AUTO_START_FILE), { recursive: true });
    writeFileAtomicSync(AUTO_START_FILE, JSON.stringify(autoStart, null, 2));
  } catch {
    // best-effort — a failed persist means the config survives until the next restart
  }
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, SAVE_DEBOUNCE_MS);
}

/** Load persisted auto-start config. Called once at startup before any connection arrives. */
export function loadAutoStart() {
  try {
    if (!fs.existsSync(AUTO_START_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(AUTO_START_FILE, 'utf8'));
    if (parsed && typeof parsed.projects === 'object') {
      autoStart = {
        projects: Object.fromEntries(
          Object.entries(parsed.projects).filter(([, v]) => v && typeof v.projectName === 'string' && typeof v.command === 'string'),
        ),
      };
    }
  } catch {
    // corrupt file — fresh start
  }
}

/** All configured auto-start entries, keyed by project id. */
export function getAutoStart() {
  return { ...autoStart.projects };
}

/** Opt a project in. `command` is the chat phrase the boot runner re-matches. */
export function setAutoStart(projectId, projectName, command) {
  autoStart.projects[projectId] = { projectName, command, addedAt: Date.now() };
  schedulePersist();
}

/** Opt a project out. Returns the removed entry or null. */
export function removeAutoStart(projectId) {
  if (!autoStart.projects[projectId]) return null;
  const removed = autoStart.projects[projectId];
  delete autoStart.projects[projectId];
  schedulePersist();
  return removed;
}

/** Append a line to data/auto-start-log.md, trimming to the last ~200 lines. */
export function appendAutoStartLog(line) {
  try {
    fs.mkdirSync(path.dirname(AUTO_START_LOG_FILE), { recursive: true });
    const existing = fs.existsSync(AUTO_START_LOG_FILE) ? fs.readFileSync(AUTO_START_LOG_FILE, 'utf8') : '';
    const lines = existing.split('\n').filter(Boolean);
    lines.push(`- **${new Date().toLocaleString()}** ${line}`);
    fs.writeFileSync(AUTO_START_LOG_FILE, lines.slice(-AUTO_START_LOG_CAP_LINES).join('\n') + '\n');
  } catch {
    // best-effort — a failed log write must never take a boot run down with it
  }
}

/** Last N lines of the auto-start log, for `review auto-start`. */
export function readAutoStartLog(n = 20) {
  try {
    if (!fs.existsSync(AUTO_START_LOG_FILE)) return '(empty — nothing has auto-started yet)';
    const lines = fs.readFileSync(AUTO_START_LOG_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).join('\n') || '(empty)';
  } catch {
    return '(could not read the auto-start log)';
  }
}

/**
 * Deliver a boot-run result: the first live session of the project wins (renders + persists
 * like a normal answer), otherwise the log file.
 */
function deliverResult(project, text) {
  for (const [ws, ctx] of connectionRegistry) {
    if (ctx.activeProjectId === project.id && ws.readyState === 1) {
      // toast: true — boot-time auto-start results are out-of-band (the user may not be in
      // the chat); the web client surfaces them as a toast in addition to the bubble.
      ws.send(JSON.stringify({ type: 'answer', data: text, toast: true }));
      return 'connected session';
    }
  }
  appendAutoStartLog(`${project.name}: ${text}`);
  return 'auto-start log';
}

/**
 * Run one auto-start now (the boot runner and the `run auto-start now` command share this).
 * Probes first (a site that is already up is skipped — never double-serve over the user's
 * own instance), then re-matches the stored phrase and dispatches it through the same
 * builtin/entry handlers a typed message would hit, with a fake ws collecting output.
 */
export async function runAutoStart(project, entry) {
  for (const url of candidateDevUrls(project)) {
    const probe = await probeUrl(url, AUTO_START_PROBE_TIMEOUT_MS);
    if (probe.alive) {
      deliverResult(project, `auto-start skipped — **${url}** is already responding, so the site is up (no double-serve).`);
      return;
    }
  }

  const idx = state.activeProjectsCache.findIndex((p) => p.id === project.id);
  let matchResult;
  try {
    matchResult = await matchInput(entry.command, project, idx, { model: null });
  } catch (err) {
    deliverResult(project, `auto-start failed — match error: ${err.message}`);
    return;
  }

  let output = '';
  const fakeWs = {
    readyState: 1,
    send: (data) => {
      try {
        const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
        if (parsed.type === 'confirm_prompt') return; // needs a human — expires via the TTL
        if ((parsed.type === 'answer' || parsed.type === 'error_output' || parsed.type === 'warning') && parsed.data) {
          const text = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);
          output += output ? `\n\n${text}` : text;
        }
      } catch {
        // unparseable — nothing to collect
      }
    },
  };
  const context = {
    activeProjectId: project.id,
    currentSessionId: null,
    workspaceProjectIds: [],
    aiEnabled: false,
    aiModel: null,
    aiMode: 'default',
    conversationHistory: [],
    aiAbortController: null,
    executeInFlight: false,
    toolGrants: new Set(),
  };

  try {
    if (matchResult.builtin) {
      if (!LAUNCH_INTENTS.has(matchResult.builtin)) {
        deliverResult(project, `auto-start skipped — "${entry.command}" now resolves to \`${matchResult.builtin}\`, which is not a launch command. Re-run \`enable auto-start\` for this project if the phrase drifted.`);
        return;
      }
      await handleBuiltinIntent(fakeWs, matchResult.builtin, entry.command, project, context);
    } else if (matchResult.match) {
      await handleMatchedEntry(fakeWs, matchResult.match, entry.command, matchResult.trigger || entry.command, project, context);
    } else {
      deliverResult(project, `auto-start failed — "${entry.command}" matched nothing. Re-enable auto-start with a clearer phrase (e.g. \`auto-start this project with "npm run dev"\`).`);
      return;
    }
  } catch (err) {
    deliverResult(project, `auto-start failed — ${err.message}`);
    return;
  }

  if (output) {
    deliverResult(project, `Auto-started "${entry.command}":\n\n${output}`);
  } else {
    deliverResult(project, `Auto-start ran "${entry.command}" (no output collected yet — the dev server may still be booting).`);
  }
}

/**
 * Boot-time entry point. Called from server/index.js once the semantic matcher is ready
 * (matchInput needs the embeddings). Staggers per-project runs so several opted-in projects
 * boot one after another instead of all at once.
 */
export function initAutoStart() {
  const projects = Object.entries(autoStart.projects);
  if (projects.length === 0) return;
  let delay = 0;
  for (const [projectId, entry] of projects) {
    const project = state.activeProjectsCache.find((p) => p.id === projectId);
    if (!project) {
      appendAutoStartLog(`${entry.projectName}: skipped — project no longer scanned. Disable with \`disable auto-start\` inside that project's chat.`);
      continue;
    }
    const snapshot = project;
    setTimeout(() => {
      enqueueTask(projectId, 'auto-start', () => runAutoStart(snapshot, entry));
    }, delay);
    delay += AUTO_START_STAGGER_MS;
  }
}
