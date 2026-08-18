// Phase 3c (2026-08-04): derived per-intent match statistics over a project's telemetry log.
// Pure read-time aggregation (no writes); lives apart from intentTelemetry.js so that module
// stays under 150 lines. Re-exported back through intentTelemetry.js so callers like
// connection.js's "telemetry review" keep importing getIntentStats from the same place.
import { readTelemetry } from './telemetryFile.js';

export function getIntentStats(projectId) {
  const entries = readTelemetry(projectId);
  const stats = new Map();

  for (const entry of entries) {
    const intent = entry.finalIntent;
    if (!intent) continue;
    if (!stats.has(intent)) {
      stats.set(intent, { matches: 0, minConfidence: Infinity, maxConfidence: -Infinity, confSum: 0, labeled: 0, falsePositives: 0, stages: {} });
    }
    const s = stats.get(intent);
    s.matches++;
    // Fold min/max into the loop instead of Math.min(...array) — a spread over an unbounded
    // telemetry file would exceed the argument-count limit on huge logs (audit 2026-08-17).
    const conf = entry.finalConfidence || 0;
    s.confSum += conf;
    if (conf < s.minConfidence) s.minConfidence = conf;
    if (conf > s.maxConfidence) s.maxConfidence = conf;
    if (entry.winner) {
      s.stages[entry.winner] = (s.stages[entry.winner] || 0) + 1;
    }
    // falsePositiveRate is computed against LABELED matches only (audit 2026-08-17): an
    // unlabeled entry (neither true nor false) never had a user outcome recorded, so
    // counting it in the denominator would understate the true rate.
    if (typeof entry.falsePositive === 'boolean') {
      s.labeled++;
      if (entry.falsePositive === true) s.falsePositives++;
    }
  }

  for (const [, s] of stats) {
    s.avgConfidence = s.confSum / s.matches;
    s.minConfidence = s.matches > 0 ? s.minConfidence : 0;
    s.maxConfidence = s.matches > 0 ? s.maxConfidence : 0;
    s.falsePositiveRate = s.labeled > 0 ? s.falsePositives / s.labeled : 0;
  }

  return stats;
}
