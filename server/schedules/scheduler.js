// Phase 1 scheduler orchestrator. A 15s setInterval tick checks every time-based schedule
// (interval / daily) against Date.now(); event-based schedules (file-save / git-commit) are
// driven by fileWatcher.js's watchProjectChanges watchers, which are started/stopped here to
// match however many event schedules exist per project. Every tick body is try/caught so one
// broken schedule can never kill the loop; cadence is lastFiredAt-based, so a restart mid-
// interval never double-fires and a freshly created schedule waits a full period.

import { loadSchedules, getSchedules, markFired } from './scheduleStore.js';
import { fireSchedule } from './scheduleFire.js';
import { watchProjectChanges } from '../fileWatcher.js';
import { state } from '../state.js';

const TICK_MS = 15 * 1000;
// Throttle for event-driven fires: a chokidar burst (dev server writing dozens of files a
// second) would otherwise fire "on file save" schedules dozens of times. One fire per
// schedule per minute is the sane ceiling for unattended checks.
const EVENT_THROTTLE_MS = 60 * 1000;

// projectId -> chokidar watcher instance created by watchProjectChanges (lazily, only for
// projects that actually have event-type schedules)
const projectWatchers = new Map();

function dailyAtMs(schedule) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedule.hour, schedule.minute, 0, 0);
  return d.getTime();
}

function isDue(schedule, now) {
  if (schedule.type === 'interval') {
    return now - (schedule.lastFiredAt || schedule.createdAt) >= schedule.everyMs;
  }
  if (schedule.type === 'daily') {
    // Fire once the local 24h time for today has been reached AND the last fire predates
    // today's occurrence — a schedule created after today's HH:MM waits for tomorrow.
    return now >= dailyAtMs(schedule) && (schedule.lastFiredAt || 0) < dailyAtMs(schedule);
  }
  return false; // file-save / git-commit are event-driven, see handleProjectFsEvent
}

function tick() {
  const now = Date.now();
  for (const schedule of getSchedules()) {
    try {
      if (isDue(schedule, now)) fireSchedule(schedule);
    } catch (err) {
      console.error(`[scheduler] fire failed for schedule ${schedule.id}:`, err.message);
    }
  }
}

/** Event handler installed per project watcher (file-save / git-commit triggers). */
function handleProjectFsEvent(project, schedule, eventType) {
  try {
    const nowMs = Date.now();
    const last = schedule.lastFiredAt || 0;
    if (nowMs - last < EVENT_THROTTLE_MS) return;
    markFired(schedule.id);
    fireSchedule(schedule);
  } catch (err) {
    console.error(`[scheduler] event fire failed for schedule ${schedule.id}:`, err.message);
  }
}

function startProjectWatcher(projectId) {
  if (projectWatchers.has(projectId)) return;
  const project = state.activeProjectsCache.find((p) => p.id === projectId);
  if (!project) return;
  const watcher = watchProjectChanges(project, (eventType) => {
    for (const schedule of getSchedules().filter((s) => s.projectId === projectId)) {
      if (schedule.type === eventType) handleProjectFsEvent(project, schedule, eventType);
    }
  });
  if (watcher) projectWatchers.set(projectId, watcher);
}

/** Match watcher lifecycle to the current event-schedule set (called on init and after
 *  every schedule create/remove). Watchers stop when their project's last event schedule
 *  goes away so an idle machine isn't watching every project tree forever. */
export function syncEventTriggerWatchers() {
  const eventProjects = new Set(
    getSchedules()
      .filter((s) => s.type === 'file-save' || s.type === 'git-commit')
      .map((s) => s.projectId),
  );
  for (const projectId of eventProjects) startProjectWatcher(projectId);
  for (const [projectId, watcher] of projectWatchers) {
    if (!eventProjects.has(projectId)) {
      watcher.close().catch(() => {});
      projectWatchers.delete(projectId);
    }
  }
}

/** Start the scheduler: load persisted schedules, spin the tick, sync event watchers.
 *  Called once from server/index.js after project discovery. */
export function initScheduler() {
  loadSchedules();
  syncEventTriggerWatchers();
  setInterval(tick, TICK_MS).unref();
}