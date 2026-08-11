import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from './atomicWrite.js';

// Phase 8 (2026-08-11): runtime-overridable tuning constants. The named exports in the
// consumer modules (FUSE_THRESHOLD, DEBOUNCE_MS, ...) remain the documented DEFAULTS — this
// module shadows them at use time with values persisted in data/tuning.json (gitignored, same
// treatment as data/dev-urls.json). Each consumer reads via getTuning(name, itsOwnDefault),
// so a knob the user has not touched resolves to the exported default with zero behavior
// change. Deliberately plain numbers only — no booleans/lists/objects: these are fine-grained
// power-user knobs, and number-only keeps validation and the UI trivially safe.
const TUNING_FILE = path.resolve('data/tuning.json');

export const TUNING_DEFAULTS = {
  // semanticMatcher: fuzzy-match floor / min length / init poll / suggestion count / collision
  FUSE_THRESHOLD: 0.55,
  FUSE_MIN_MATCH_CHAR_LENGTH: 2,
  INIT_WAIT_POLL_MS: 200,
  SUGGESTION_DEFAULT_LIMIT: 5,
  COLLISION_DEFAULT_THRESHOLD: 0.9,
  // executor: dev-URL detach grace / force-detach timers / output caps
  DEV_URL_DETACH_GRACE_MS: 500,
  DEV_SERVER_FORCE_DETACH_MS: 10000,
  LONG_RUNNING_FORCE_DETACH_MS: 20000,
  STDOUT_SUMMARY_CAP: 4000,
  STDERR_SUMMARY_CAP: 2000,
  // verifyHarness: background type-check debounce
  DEBOUNCE_MS: 2000,
};

// Per-key numeric bounds; anything outside [min, max] (or non-finite) is rejected rather than
// clamped, so a typo can't silently ship a wild value. Fuse thresholds are cosine scores in
// [0, 1]; delays/caps are millisecond/byte counts.
const BOUNDS = {
  FUSE_THRESHOLD: { min: 0, max: 1 },
  FUSE_MIN_MATCH_CHAR_LENGTH: { min: 1, max: 50 },
  INIT_WAIT_POLL_MS: { min: 25, max: 5000 },
  SUGGESTION_DEFAULT_LIMIT: { min: 1, max: 50 },
  COLLISION_DEFAULT_THRESHOLD: { min: 0, max: 1 },
  DEV_URL_DETACH_GRACE_MS: { min: 100, max: 10000 },
  DEV_SERVER_FORCE_DETACH_MS: { min: 1000, max: 120000 },
  LONG_RUNNING_FORCE_DETACH_MS: { min: 1000, max: 120000 },
  STDOUT_SUMMARY_CAP: { min: 200, max: 100000 },
  STDERR_SUMMARY_CAP: { min: 200, max: 100000 },
  DEBOUNCE_MS: { min: 100, max: 60000 },
};

let overrides = {};

function sanitize(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [key, value] of Object.entries(raw)) {
    const bounds = BOUNDS[key];
    if (!bounds) continue; // unknown knob — reject silently
    const num = Number(value);
    if (!Number.isFinite(num) || num < bounds.min || num > bounds.max) continue;
    clean[key] = num;
  }
  return clean;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(TUNING_FILE), { recursive: true });
    writeFileAtomicSync(TUNING_FILE, JSON.stringify(overrides, null, 2));
  } catch {
    // best-effort only — same convention as devUrlStore.js
  }
}

/** Sync-override loading. Call once at server startup, before any consumer reads a knob. */
export function loadTuning() {
  try {
    if (!fs.existsSync(TUNING_FILE)) return;
    overrides = sanitize(JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8')));
  } catch {
    // corrupt file — start with factory defaults
    overrides = {};
  }
}

/** Effective value for a knob: the user's override when one exists, else the caller's default. */
export function getTuning(name, fallback) {
  const v = overrides[name];
  return typeof v === 'number' ? v : fallback;
}

/**
 * Applies + persists a partial override set (unknown keys and out-of-bounds values are
 * dropped, matching sanitize()). Returns the applied subset so callers can echo it back.
 */
export function setTuning(raw) {
  const applied = sanitize(raw);
  overrides = { ...overrides, ...applied };
  persist();
  return applied;
}

/** Clears every override and persists the reset. */
export function resetTuning() {
  overrides = {};
  persist();
}

/** { defaults, overrides } — the shape GET /api/tuning and the settings UI expect. */
export function getTuningState() {
  return { defaults: { ...TUNING_DEFAULTS }, overrides: { ...overrides } };
}