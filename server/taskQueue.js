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
// for the same CPU/output. Phase 8 (2026-08-11): a GLOBAL cap on top of that — with Phase 1
// schedules able to fire unattended across many projects, "one per project, unlimited across
// projects" could saturate the machine with simultaneous tsc/git runs; the pump now starts at
// most MAX_TASK_CONCURRENCY tasks in total, and the rest wait in their per-project queues.
const queues = new Map(); // projectId -> array of { id, label, run }
const active = new Map(); // projectId -> label of the currently-running task

export const MAX_TASK_CONCURRENCY = 3;

let runningCount = 0;
let counter = 0;
let completionListener = null;

/**
 * Optional single completion hook (Phase 2 notifications). Called once per finished task with
 * { projectId, label, failed } — the listener decides what, if anything, to do with it; a
 * throwing listener must never take the pump down, so it is wrapped. Pass null to clear.
 */
export function setTaskCompletionListener(fn) {
  completionListener = fn;
}

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
  pump();
  return id;
}

// Starts as many runnable tasks as both the per-project single-flight rule and the global cap
// allow. A task that can't start (its project is busy, or the cap is hit) simply stays queued —
// every completion re-pumps, so nothing waits on a timer.
function pump() {
  if (runningCount >= MAX_TASK_CONCURRENCY) return;
  for (const [projectId, q] of queues) {
    if (runningCount >= MAX_TASK_CONCURRENCY) break;
    if (active.has(projectId) || q.length === 0) continue;
    const task = q.shift();
    active.set(projectId, task.label);
    runningCount++;
    let failed = false;
    Promise.resolve()
      .then(task.run)
      .catch((err) => {
        failed = true;
        console.error(`[taskQueue] "${task.label}" failed for project ${projectId}:`, err.message);
      })
      .finally(() => {
        active.delete(projectId);
        runningCount--;
        if (completionListener) {
          try {
            completionListener({ projectId, label: task.label, failed });
          } catch (err) {
            console.error('[taskQueue] completion listener failed:', err.message);
          }
        }
        pump();
      });
  }
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
