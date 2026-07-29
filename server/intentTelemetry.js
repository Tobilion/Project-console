import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { learnedFloor, getModelInfo } from './confidenceModel.js';

const TELEMETRY_DIR = path.join(process.cwd(), 'data', 'telemetry');
const THRESHOLDS_FILE = path.join(TELEMETRY_DIR, 'thresholds.json');

const DEFAULT_FLOOR = 0.6;

let thresholdOverrides = {};

function ensureDir() {
  if (!fs.existsSync(TELEMETRY_DIR)) {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  }
}

function filePath(projectId) {
  return path.join(TELEMETRY_DIR, `${projectId}.jsonl`);
}

function loadThresholdOverrides() {
  try {
    if (fs.existsSync(THRESHOLDS_FILE)) {
      return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveThresholdOverrides() {
  ensureDir();
  fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(thresholdOverrides, null, 2));
}

thresholdOverrides = loadThresholdOverrides();

// Batched async write queue — debounces writes so rapid sequential logMatch calls
// (e.g. during project discovery with many intents) coalesce into a single disk write.
const writeQueue = new Map();
let flushTimer = null;

function flushTelemetryQueue() {
  flushTimer = null;
  for (const [projectId, entries] of writeQueue) {
    writeQueue.delete(projectId);
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    const fp = filePath(projectId);
    ensureDir();
    try {
      fs.appendFileSync(fp, lines);
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

export function readTelemetry(projectId) {
  const fp = filePath(projectId);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

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

export function suggestThresholds(projectId) {
  const stats = getIntentStats(projectId);
  const suggestions = [];

  // Stage 1 ML work (2026-07-29, requested directly): once enough real accept/reject outcomes
  // have accumulated (see confidenceModel.js), prefer its learned floor over the hardcoded
  // if/else bump rules below for every intent — a single data-driven number instead of guessed
  // ±0.03/±0.05 nudges. Below MIN_LABELED examples this returns null and every intent falls
  // through to exactly the original heuristic, so a fresh install behaves identically to before.
  const modelFloor = learnedFloor();

  for (const [intent, s] of stats) {
    if (s.matches < 5) continue;

    const currentFloor = thresholdOverrides[intent] ?? DEFAULT_FLOOR;
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

export function updateTelemetryEntry(projectId, id, updates) {
  const fp = filePath(projectId);
  if (!fs.existsSync(fp)) return;
  const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim());
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      const record = JSON.parse(lines[i]);
      if (record.id === id) {
        Object.assign(record, updates);
        lines[i] = JSON.stringify(record);
        changed = true;
        break;
      }
    } catch {}
  }
  if (changed) fs.writeFileSync(fp, lines.join('\n') + '\n');
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
  ensureDir();
  const results = [];
  try {
    const files = fs.readdirSync(TELEMETRY_DIR);
    for (const f of files) {
      if (f.endsWith('.jsonl') && f !== 'thresholds.json') {
        const projectId = f.replace('.jsonl', '');
        const result = autoApplyThresholds(projectId);
        if (result.applied > 0) {
          results.push({ projectId, ...result });
        }
      }
    }
  } catch {}
  return results;
}

export function clearTelemetry(projectId) {
  const fp = filePath(projectId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}
