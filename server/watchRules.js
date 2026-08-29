// Phase 15 (2026-08-12): persisted file-watch notification rules. Deliberately a SEPARATE
// store from scheduleStore.js: schedule event-schedules run COMMANDS through the read-only
// allowlist, while watch rules are notification-only ("when <event> in <folder>, notify me").
// Mixing them would let a file-watch rule become a backdoor to running arbitrary commands on
// file change — exactly what scheduleIntents.js's allowlist exists to prevent. Rules persist
// to gitignored data/watch-rules.json (debounced, atomic, same pattern as scheduleStore).
import fs from 'fs';
import path from 'path';
import { resolveData } from './dataPath.js';
import { writeFileAtomicSync } from './atomicWrite.js';

const RULES_FILE = process.env.WATCH_RULES_FILE || resolveData('watch-rules.json');
const SAVE_DEBOUNCE_MS = 500;

let rules = [];
let saveTimer = null;

function persist() {
  try {
    fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
    writeFileAtomicSync(RULES_FILE, JSON.stringify({ rules }, null, 2));
  } catch {
    // best-effort — rules survive until next restart if the write fails
  }
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, SAVE_DEBOUNCE_MS);
}

/** Load persisted rules. Call once at startup, before any connection can create rules. */
export function loadWatchRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    if (parsed && Array.isArray(parsed.rules)) {
      rules = parsed.rules.filter((r) => r && typeof r.id === 'string' && typeof r.folder === 'string' && (r.event === 'file-changed' || r.event === 'file-added' || r.event === 'folder-stale'));
    }
  } catch {
    // corrupt file — fresh start
  }
}

export function getWatchRules() {
  return [...rules];
}

/** Add a watch rule. id is `w<counter>`-shaped. Returns the created rule. Rules default to
 *  enabled; the panel's per-rule toggle flips it via setWatchRuleEnabled. */
export function addWatchRule({ folder, event, days = null, projectId = null, projectName = null }) {
  const rule = {
    id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    folder,
    event,
    days,
    projectId,
    projectName,
    createdAt: Date.now(),
    enabled: true,
  };
  rules.push(rule);
  schedulePersist();
  return rule;
}

export function removeWatchRule(id) {
  const idx = rules.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = rules.splice(idx, 1);
  schedulePersist();
  return removed;
}

/** Flip a rule's enabled flag (audit 2026-08-17: per-rule enable toggle in the Notifications
 *  panel). A disabled rule stays in the list but never fires. */
export function setWatchRuleEnabled(id, enabled) {
  const rule = rules.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = !!enabled;
  schedulePersist();
  return rule;
}

export function getWatchRule(id) {
  return rules.find((r) => r.id === id) || null;
}
