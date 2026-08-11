// Phase 3b (2026-08-04): persistable threshold overrides.
// Extracted from intentTelemetry.js so intentTelemetry only owns the *logic* that consumes
// thresholds (suggestThresholds / autoApplyThresholds); this module owns the threshold
// state + the file that persists it. Re-exported through intentTelemetry so existing callers
// (matcher.js, semanticMatcher.js, connection.js via '../intentTelemetry.js') are unchanged.
import fs from 'fs';
import path from 'path';
import { TELEMETRY_DIR, ensureDir } from './telemetryFile.js';
import { writeFileAtomicSync } from './atomicWrite.js';

export const DEFAULT_FLOOR = 0.6;

const THRESHOLDS_FILE = path.join(TELEMETRY_DIR, 'thresholds.json');

let thresholdOverrides = {};

function loadThresholdOverrides() {
  try {
    if (fs.existsSync(THRESHOLDS_FILE)) {
      return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf-8'));
    }
  } catch {
    return {};
  }
  return {};
}

function saveThresholdOverrides() {
  ensureDir();
  writeFileAtomicSync(THRESHOLDS_FILE, JSON.stringify(thresholdOverrides, null, 2));
}

thresholdOverrides = loadThresholdOverrides();

export function setThresholdOverride(intent, floor) {
  thresholdOverrides[intent] = Math.max(0, Math.min(1, floor));
  saveThresholdOverrides();
}

export function removeThresholdOverride(intent) {
  delete thresholdOverrides[intent];
  saveThresholdOverrides();
}

export function getEffectiveThreshold(intent) {
  return thresholdOverrides[intent] ?? DEFAULT_FLOOR;
}

export function getThresholdOverrides() {
  return { ...thresholdOverrides };
}

// Wholesale replace (Phase 6 workspace import): drop every current override and adopt the
// given floors, clamped to [0, 1]. Non-numeric entries are dropped rather than fatal.
export function replaceThresholdOverrides(floors) {
  const clean = {};
  if (floors && typeof floors === 'object') {
    for (const [intent, floor] of Object.entries(floors)) {
      if (typeof floor === 'number' && Number.isFinite(floor)) {
        clean[intent] = Math.max(0, Math.min(1, floor));
      }
    }
  }
  thresholdOverrides = clean;
  saveThresholdOverrides();
  return clean;
}
