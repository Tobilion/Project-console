// Intent-matching telemetry: records what each match stage returned and whether the user
// accepted the result (via the confirm flow in connection.js). Drives the per-intent threshold
// suggestions (suggestThresholds / autoApplyThresholds*) and feeds confidenceModel.js's learned
// confidence floor.
//
// Phase 3 split note: file I/O lives in telemetryFile.js (leaf) and the persistable threshold
// overrides live in telemetryThresholds.js. This module owns only the in-memory write queue +
// the suggestion/aggregation logic, and re-exports the file/threshold ops below so existing
// callers (matcher.js, semanticMatcher.js, connection.js, index.js) keep importing from here.
import crypto from 'crypto';
import { readTelemetry, appendTelemetry, updateTelemetryEntry, clearTelemetry, listTelemetryProjectIds } from './telemetryFile.js';
import { learnedFloor, getModelInfo } from './confidenceModel.js';
import { getEffectiveThreshold, setThresholdOverride } from './telemetryThresholds.js';
import { getIntentStats } from './telemetryStats.js';

export {
  getEffectiveThreshold, getThresholdOverrides, setThresholdOverride, removeThresholdOverride,
} from './telemetryThresholds.js';
export { clearTelemetry, updateTelemetryEntry } from './telemetryFile.js';
export { getIntentStats } from './telemetryStats.js';

// Batched async write queue — debounces writes so rapid sequential logMatch calls
// (e.g. during project discovery with many intents) coalesce into a single disk write.
const writeQueue = new Map();
let flushTimer = null;

function flushTelemetryQueue() {
  flushTimer = null;
  for (const [projectId, entries] of writeQueue) {
    writeQueue.delete(projectId);
    try {
      appendTelemetry(projectId, entries);
    } catch {}
  }
}

function scheduleFlush() {
  if (!flushTimer) {
    flushTimer = setTimeout(flushTelemetryQueue, 100);
  }
}

export function logMatch(projectId, entry) {
  const record = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    projectId,
    ...entry,
  };
  if (!writeQueue.has(projectId)) writeQueue.set(projectId, []);
  writeQueue.get(projectId).push(record);
  scheduleFlush();
  return record.id;
}

export function suggestThresholds(projectId) {
  const stats = getIntentStats(projectId);
  const suggestions = [];

  // Stage 1 ML work (2026-07-29, requested directly): once enough real accept/reject outcomes
  // have accumulated (see confidenceModel.js), prefer its learned floor over the hardcoded
  // if/else bump rules below for every intent. Below MIN_LABELED examples this returns null and
  // every intent falls through to exactly the original heuristic, so a fresh install behaves
  // identically to before.
  const modelFloor = learnedFloor();

  for (const [intent, s] of stats) {
    if (s.matches < 5) continue;

    const currentFloor = getEffectiveThreshold(intent);
    let recommendedFloor = currentFloor;
    let reason = null;

    const semanticRatio = (s.stages['semantic'] || 0) / s.matches;
    const fuzzyRatio = (s.stages['fuzzy'] || 0) / s.matches;
    const keywordRatio = (s.stages['keyword'] || 0) / s.matches;

    if (modelFloor !== null) {
      if (Math.abs(modelFloor - currentFloor) >= 0.03) {
        recommendedFloor = modelFloor;
        reason = `learned from ${getModelInfo().sampleCount} real accept/reject outcomes (replaces the fixed heuristic)`;
      }
    } else if (semanticRatio < 0.3 && fuzzyRatio > 0.4 && s.avgConfidence < currentFloor) {
      recommendedFloor = Math.max(0.35, currentFloor - 0.05);
      reason = `low semantic ratio (${(semanticRatio * 100).toFixed(0)}%), relies on fuzzy (${(fuzzyRatio * 100).toFixed(0)}%)`;
    } else if (s.falsePositiveRate > 0.3 && semanticRatio > 0.6) {
      recommendedFloor = Math.min(0.95, currentFloor + 0.05);
      reason = `high false positive rate (${(s.falsePositiveRate * 100).toFixed(0)}%) despite strong semantic ratio`;
    } else if (s.avgConfidence > 0.85 && s.falsePositiveRate < 0.05 && currentFloor > 0.5) {
      recommendedFloor = Math.max(0.35, currentFloor - 0.03);
      reason = `consistently high confidence (avg ${s.avgConfidence.toFixed(2)}) with low false positives`;
    }

    if (reason && Math.abs(recommendedFloor - currentFloor) >= 0.03) {
      suggestions.push({
        intent,
        currentFloor,
        recommendedFloor,
        reason,
        matchCount: s.matches,
        avgConfidence: parseFloat(s.avgConfidence.toFixed(3)),
        semanticRatio: parseFloat(semanticRatio.toFixed(2)),
        fuzzyRatio: parseFloat(fuzzyRatio.toFixed(2)),
        keywordRatio: parseFloat(keywordRatio.toFixed(2)),
        falsePositiveRate: parseFloat(s.falsePositiveRate.toFixed(3)),
      });
    }
  }

  suggestions.sort((a, b) => b.matchCount - a.matchCount);
  return suggestions;
}

export function autoApplyThresholds(projectId) {
  const suggestions = suggestThresholds(projectId);
  let applied = 0;
  for (const s of suggestions) {
    if (s.matchCount >= 10 && Math.abs(s.recommendedFloor - s.currentFloor) >= 0.03) {
      setThresholdOverride(s.intent, s.recommendedFloor);
      applied++;
    }
  }
  return { applied, total: suggestions.length };
}

export function autoApplyThresholdsForAll() {
  const results = [];
  try {
    for (const projectId of listTelemetryProjectIds()) {
      const result = autoApplyThresholds(projectId);
      if (result.applied > 0) {
        results.push({ projectId, ...result });
      }
    }
  } catch {}
  return results;
}
