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
      stats.set(intent, { matches: 0, confidences: [], falsePositives: 0, stages: {} });
    }
    const s = stats.get(intent);
    s.matches++;
    s.confidences.push(entry.finalConfidence || 0);
    if (entry.winner) {
      s.stages[entry.winner] = (s.stages[entry.winner] || 0) + 1;
    }
    if (entry.falsePositive === true) s.falsePositives++;
  }

  for (const [, s] of stats) {
    s.avgConfidence = s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length;
    s.minConfidence = Math.min(...s.confidences);
    s.maxConfidence = Math.max(...s.confidences);
    s.falsePositiveRate = s.matches > 0 ? s.falsePositives / s.matches : 0;
  }

  return stats;
}
