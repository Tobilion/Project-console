// Lightweight in-memory async task queue (infrastructure expansion, 2026-08-10 — first piece of
// broadening the console beyond the matcher/handler pipeline itself). Lets slow, non-interactive
// work run off the chat turn instead of blocking the WS connection for tens of seconds — the
// motivating case is project.diagnostics.type_check (spawns `tsc --noEmit`, up to 60s per
// verifyHarness.js's HARNESS_TIMEOUT_MS), but this is generic: any handler can enqueue a task
// instead of awaiting it directly.
//
// Deliberately NOT a persistent job system — in-memory only, cleared on server restart, one
// task running at a time per project (a second enqueue while one is active just waits its turn)
// so a diagnostics scan and, say, a future test-runner intent on the same project don't compete
// for the same CPU/output. Cross-project tasks run fully in parallel — there's no global cap.
const queues = new Map(); // projectId -> array of { id, label, run }
const active = new Map(); // projectId -> label of the currently-running task

let counter = 0;

/**
 * Queues `run` (an async function, no args) for `projectId` under a human-readable `label`.
 * Returns a task id immediately — the caller does not wait for `run` to finish. Errors thrown by
 * `run` are swallowed here (never crash the queue pump); a handler that needs to report failure
 * back to the user should catch its own errors inside `run` and send a WS message itself.
 */
export function enqueueTask(projectId, label, run) {
  const id = `t${++counter}`;
  if (!queues.has(projectId)) queues.set(projectId, []);
  queues.get(projectId).push({ id, label, run });
  pump(projectId);
  return id;
}

function pump(projectId) {
  if (active.has(projectId)) return; // one task at a time per project
  const q = queues.get(projectId);
  if (!q || q.length === 0) return;
  const task = q.shift();
  active.set(projectId, task.label);
  Promise.resolve()
    .then(task.run)
    .catch((err) => console.error(`[taskQueue] "${task.label}" failed for project ${projectId}:`, err.message))
    .finally(() => {
      active.delete(projectId);
      pump(projectId);
    });
}

/** True if a task is running or queued for this project — callers use this to decide whether to
 *  tell the user "running now" vs. "queued behind an existing task". */
export function hasActiveTask(projectId) {
  return active.has(projectId) || (queues.get(projectId)?.length || 0) > 0;
}

/** Label of the currently-running task for this project, or null if idle. */
export function activeTaskLabel(projectId) {
  return active.get(projectId) || null;
}
