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
import { readTelemetry, appendTelemetry, updateTelemetryEntry as updateTelemetryEntryOnDisk, clearTelemetry, listTelemetryProjectIds } from './telemetryFile.js';
import { learnedFloor, getModelInfo, familyOf } from './confidenceModel.js';
import { getEffectiveThreshold, setThresholdOverride } from './telemetryThresholds.js';
import { getIntentStats } from './telemetryStats.js';
import { PURE_CHITCHAT_INTENTS } from './intentTrust.js';

// Safety clamp (2026-08-05, approved directly after a confirmed-live check-matcher failure):
// canned zero-argument chit-chat replies must never have their semantic floor lowered below
// this. See suggestThresholds() for the full story — keyboard-mash input scored 0.386 against
// status's cluster, so the model's 0.35 recommendation dispatched it to a confident canned
// reply instead of falling through.
export const CHITCHAT_FLOOR_MIN = 0.5;

export {
  getEffectiveThreshold, getThresholdOverrides, setThresholdOverride, removeThresholdOverride,
} from './telemetryThresholds.js';
export { clearTelemetry } from './telemetryFile.js';
export { getIntentStats } from './telemetryStats.js';

// Batched async write queue — debounces writes so rapid sequential logMatch calls
// (e.g. during project discovery with many intents) coalesce into a single disk write.
const writeQueue = new Map();
let flushTimer = null;

function flushTelemetryQueue() {
  flushTimer = null;
  for (const [projectId, entries] of writeQueue) {
    try {
      appendTelemetry(projectId, entries);
      // Delete only after a successful append. Deleting first dropped the whole batch on any
      // error with zero logging — and the entries' ids were already handed out to pending
      // confirmations, so a dropped entry permanently lost its falsePositive label (the
      // confidence model's training data silently shrank). On failure the batch stays queued
      // and the next flush retries it.
      writeQueue.delete(projectId);
    } catch (err) {
      console.error('Telemetry flush failed (retrying on next flush):', err.message);
    }
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

// Applies an update (typically `{ falsePositive: true/false }` from the confirm/reject flow) to
// a telemetry record by id. Records live in one of two places depending on timing: still
// in-memory in `writeQueue` if the 100ms debounced flush (scheduleFlush) hasn't fired yet, or
// already on disk if it has. The on-disk-only version of this (telemetryFile.js's
// updateTelemetryEntry) reads exclusively from disk via fs.readFileSync — if a user approves or
// rejects a gated action fast enough to beat the flush (which every auto-approved grant does,
// since there's no human click-latency in that path), the record isn't on disk yet, the disk
// read finds nothing, and the label is silently dropped with no error (confirmed live audit
// 2026-08-10 — this permanently shrinks confidenceModel.js's accept/reject training set,
// preferentially for the fast/low-friction path). Checking the in-memory queue first closes
// that gap: an update to a not-yet-flushed record is merged in place, so the eventual flush
// writes the already-updated record instead of the stale pre-update one.
export function updateTelemetryEntry(projectId, id, updates) {
  const pending = writeQueue.get(projectId);
  if (pending) {
    const record = pending.find((r) => r.id === id);
    if (record) {
      Object.assign(record, updates);
      return;
    }
  }
  updateTelemetryEntryOnDisk(projectId, id, updates);
}

export function suggestThresholds(projectId) {
  const stats = getIntentStats(projectId);
  const suggestions = [];

  for (const [intent, s] of stats) {
    if (s.matches < 5) continue;

    const currentFloor = getEffectiveThreshold(intent);
    let recommendedFloor = currentFloor;
    let reason = null;

    const semanticRatio = (s.stages['semantic'] || 0) / s.matches;
    const fuzzyRatio = (s.stages['fuzzy'] || 0) / s.matches;
    const keywordRatio = (s.stages['keyword'] || 0) / s.matches;

    // Phase 4 (audit 2026-08-10 §2.2): learned per this intent's FAMILY, not one model pooled
    // across every intent — see confidenceModel.js's familyOf()/INTENT_FAMILIES for why. Below
    // MIN_LABELED examples FOR THIS FAMILY, learnedFloor() returns null and this intent falls
    // through to exactly the original heuristic below, same zero-regression guarantee as before,
    // just scoped per family instead of globally.
    const family = familyOf(intent);
    const modelFloor = learnedFloor(family);

    if (modelFloor !== null) {
      if (Math.abs(modelFloor - currentFloor) >= 0.03) {
        recommendedFloor = modelFloor;
        reason = `learned from ${getModelInfo(family).sampleCount} real accept/reject outcomes for "${family}"-family intents (replaces the fixed heuristic)`;
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

    // Confirmed live 2026-08-05 (check-matcher GARBAGE battery): once the confidence model trained
    // (20 real accept/reject labels), the learnedFloor path above ratcheted every high-match intent
    // to the model's >=70%-accept score (0.35) — including zero-argument canned chit-chat.
    // Keyboard-mash input ("asdfghjkl") scores 0.386 against status's phrase cluster, so floor 0.35
    // dispatched it to a confident canned "console status" reply instead of falling through to the
    // fallback — the exact garbled-input class PURE_CHITCHAT_INTENTS exists to block. These
    // intents must never be reachable below CHITCHAT_FLOOR_MIN: a canned reply is never a
    // plausible match for out-of-distribution input. Non-chit-chat intents keep the fully
    // data-driven floor (that part of the Stage-1 ML design is untouched).
    if (PURE_CHITCHAT_INTENTS.has(intent)) {
      const clamped = Math.max(recommendedFloor, CHITCHAT_FLOOR_MIN);
      if (clamped !== recommendedFloor) {
        recommendedFloor = clamped;
        reason = `safety clamp: pure-chitchat intents never below ${CHITCHAT_FLOOR_MIN}`;
      }
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

// Pending telemetry must not be dropped on shutdown. appendTelemetry is synchronous
// (appendFileSync), so the flush completes inside these handlers — async I/O would not.
process.on('exit', flushTelemetryQueue);
process.on('SIGTERM', flushTelemetryQueue);
