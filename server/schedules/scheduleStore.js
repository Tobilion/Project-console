// Schedule persistence (Phase 1). Schedules are per-project and must survive a server
// restart, so they live in data/schedules.json — the same gitignored, debounced,
// best-effort treatment data/dev-urls.json gets. The in-memory array is the source of
// truth while running; this module only mirrors it to disk (500ms debounce), so the
// schedule command handler never pays a synchronous fs write per keystroke.

import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../atomicWrite.js';

const SCHEDULES_FILE = path.join(process.cwd(), 'data', 'schedules.json');

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

/** Load persisted schedules into memory. Call once at server startup (never replaces
 *  a live addSchedule that raced the load — invoked before any connection arrives). */
export function loadSchedules() {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.schedules)) {
      schedules = parsed.schedules.filter((s) => s && typeof s.id === 'string' && typeof s.command === 'string');
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
 * Create a schedule. `spec` comes from scheduleParser's {ok:true} result; `command` is the
 * trigger phrase; `intentId` is the read-only intent it resolved to at creation time.
 * lastFiredAt starts at the creation time so interval schedules wait a full period before
 * their first fire and daily schedules fire at the NEXT occurrence, not immediately.
 */
export function addSchedule({ projectId, projectName, spec, command, intentId, createdAt = Date.now() }) {
  const id = `s${++idCounter}`;
  const schedule = {
    id,
    projectId,
    projectName,
    type: spec.type,
    everyMs: spec.everyMs ?? null,
    hour: spec.hour ?? null,
    minute: spec.minute ?? null,
    label: spec.label,
    command,
    intentId,
    createdAt,
    lastFiredAt: createdAt,
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
  schedulePersist();
}

export function getScheduleById(id) {
  return schedules.find((s) => s.id === id) || null;
}