// Adaptive thresholds for the project-memory nudge engine. Split out of projectMemory.js
// (Phase 2 modularization) as pure data + the shared scaling helper. projectMemory.js imports
// these and keeps the I/O (loadMemory/saveMemory/track*/checkThresholds) in place.
//
// QUESTION_THRESHOLD/COMMAND_THRESHOLD/FILE_EDIT_THRESHOLD were fixed constants applied
// identically to every project regardless of how active it is. adaptiveThreshold() scales them
// down for quiet/new projects (surface patterns sooner) and up for heavily used ones (raise
// the bar so routine high-volume activity doesn't spam a nudge) — mirrors the same
// "adjust based on observed usage" idea intentTelemetry.js applies to semantic-match floors.

export const QUESTION_THRESHOLD = 3;
export const COMMAND_THRESHOLD = 20;
export const FILE_EDIT_THRESHOLD = 10;

/**
 * Scale a base threshold against a project's actual activity volume instead of the same fixed
 * number everywhere. <15 total events → surface sooner (base-1, floor 2); >150 → raise the bar
 * (base + 50% rounded up); otherwise base unchanged.
 */
export function adaptiveThreshold(base, totalActivity) {
  if (totalActivity < 15) return Math.max(2, base - 1);
  if (totalActivity > 150) return base + Math.ceil(base * 0.5);
  return base;
}
