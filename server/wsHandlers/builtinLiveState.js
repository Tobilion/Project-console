import { execFile } from 'child_process';
import { promisify } from 'util';
import { runningProcesses } from '../executor.js';
import { state, withPortCollisionWarning } from '../state.js';
import { formatMemoryForPrompt } from '../memoryStore.js';

// projectPath -> { at, count } — memoizes the uncommitted-change count for ~30s so the chit-chat
// live-state line never spawns a `git status` on every greeting/status reply.
const uncommittedCache = new Map();
const UNCOMMITTED_CACHE_TTL_MS = 30_000;

/** Cheap cached `git status --short` line count for a project; null when not a git repo or git
 *  unavailable. Cached per project for 30s so repeated greetings don't each spawn a git process. */
export async function cachedUncommittedCount(projectPath) {
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
export async function buildLiveStateLine(project) {
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
export async function buildMemoryBlock(project) {
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
