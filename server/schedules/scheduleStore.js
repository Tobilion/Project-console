// Schedule persistence (Phase 1). Schedules are per-project and must survive a server
// restart, so they live in data/schedules.json — the same gitignored, debounced,
// best-effort treatment data/dev-urls.json gets. The in-memory array is the source of
// truth while running; this module only mirrors it to disk (500ms debounce), so the
// schedule command handler never pays a synchronous fs write per keystroke.

import fs from 'fs';
import path from 'path';
import { resolveData } from '../dataPath.js';
import { writeFileAtomicSync } from '../atomicWrite.js';

const SCHEDULES_FILE = process.env.SCHEDULES_FILE || resolveData('schedules.json');

let schedules = [];
let saveTimer = null;
let idCounter = 0;

function persist() {
  try {
    fs.mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true });
    writeFileAtomicSync(SCHEDULES_FILE, JSON.stringify({ schedules }, null, 2));
  } catch {
    // best-effort only — a failed persist means schedules survive until next restart
  }
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 500);
}

/** Persist immediately, bypassing the 500ms debounce. Used by markFired and one-shot
 *  removal: a crash inside the debounce window would regress lastFiredAt (or resurrect an
 *  expired reminder) and re-fire after restart. */
function persistNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persist();
}

/** Load persisted schedules into memory. Call once at server startup (never replaces
 *  a live addSchedule that raced the load — invoked before any connection arrives). */
export function loadSchedules() {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.schedules)) {
      // Phase 4: reminder-kind entries carry `text` instead of `command` — accept both
      // so an old file (command-only) and a new one (mixed) both load cleanly.
      schedules = parsed.schedules.filter((s) => s && typeof s.id === 'string' && (s.kind === 'reminder' ? typeof s.text === 'string' : typeof s.command === 'string'));
      idCounter = schedules.reduce((max, s) => Math.max(max, parseInt(s.id.replace(/^s/, ''), 10) || 0), 0);
    }
  } catch {
    // corrupt file — fresh start
  }
}

/** All schedules, optionally filtered to one project. */
export function getSchedules(projectId) {
  return projectId ? schedules.filter((s) => s.projectId === projectId) : schedules.slice();
}

/**
 * Create a schedule. `spec` comes from scheduleParser's {ok:true} result (or
 * reminderParser's for Phase 4 reminders); `command` is the trigger phrase for command
 * schedules; `kind` defaults to 'command' and 'reminder' entries carry `text` instead.
 * Reminder-only extras: `fireAt` (oneshot instant), `weekday` (weekly), and `firstFireAt`
 * (interval alignment, see reminderParser) — lastFiredAt is set so the first fire lands
 * exactly on firstFireAt for aligned intervals, else on the creation time so interval
 * schedules wait a full period and daily/weekly schedules fire at the NEXT occurrence.
 */
export function addSchedule({ projectId, projectName, spec, command, text, kind = 'command', fireAt = null, weekday = null, firstFireAt = null, intentId = null, createdAt = Date.now(), createdBy = 'local' }) {
  const id = `s${++idCounter}`;
  const schedule = {
    id,
    projectId,
    projectName,
    kind,
    type: spec.type,
    everyMs: spec.everyMs ?? null,
    hour: spec.hour ?? null,
    minute: spec.minute ?? null,
    fireAt: fireAt ?? spec.fireAt ?? null,
    weekday: weekday ?? spec.weekday ?? null,
    label: spec.label,
    command,
    text: text ?? null,
    intentId,
    createdAt,
    // Phase 19: attribution label ("local" default — single-user schedules unchanged).
    createdBy,
    lastFiredAt: firstFireAt ? firstFireAt - spec.everyMs : createdAt,
  };
  schedules.push(schedule);
  schedulePersist();
  return schedule;
}

/** Remove a schedule by id, scoped to one project (a chat in project A can't remove
 *  schedules it doesn't own). Returns the removed schedule or null. */
export function removeSchedule(projectId, id) {
  const idx = schedules.findIndex((s) => s.id === id && s.projectId === projectId);
  if (idx === -1) return null;
  const [removed] = schedules.splice(idx, 1);
  schedulePersist();
  return removed;
}

/** Record a fire time (scheduler calls this immediately when a schedule fires, before the
 *  async run, so a slow or queued task can never cause a double-fire on the next tick). */
export function markFired(id, at = Date.now()) {
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) return;
  schedule.lastFiredAt = at;
  // Immediate write — see persistNow's doc comment (crash-safety of the fire cadence).
  persistNow();
}

/** Record fire times for several schedules in ONE immediate write (audit 2026-08-17): a
 *  tick that fires N schedules used to trigger N synchronous atomic writes — the store's
 *  debounce made that harmless correctness-wise, but it is pure I/O churn. Same
 *  crash-safety contract as markFired: the tick marks everything due BEFORE any fire work,
 *  so a crash mid-loop can't regress the cadence. */
export function markFiredBatch(ids, at = Date.now()) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  let changed = false;
  for (const id of ids) {
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) continue;
    schedule.lastFiredAt = at;
    changed = true;
  }
  if (changed) persistNow();
}

/** Remove a schedule by id regardless of project. Used only by the scheduler for expired
 *  oneshot reminders (a reminder is personal, not a project asset — cancel in chat goes
 *  through removeSchedule for command schedules, and the reminder-specific cancel path in
 *  builtinReminders.js also uses this, per the Phase 4 decision documented in CLAUDE.md). */
export function removeScheduleById(id) {
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const [removed] = schedules.splice(idx, 1);
  // Immediate write — see persistNow's doc comment (an expired one-shot reminder whose
  // removal was lost to a crash would fire again after restart).
  persistNow();
  return removed;
}

export function getScheduleById(id) {
  return schedules.find((s) => s.id === id) || null;
}