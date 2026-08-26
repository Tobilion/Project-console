// Rolling match-quality telemetry (2026-08-26): one NDJSON line per trigger-mode user
// message, appended at match time, consumed by the `review match quality` admin command
// (connectionMatchStats.js). This is a SLOW-MOVING DIAGNOSTIC accumulator, deliberately
// separate from intentTelemetry (the confidence model's training data) — nothing here feeds
// a model or a threshold; it exists so matcher drift (an intent's mean confidence sliding
// down as the corpus grows) becomes visible before it misfires.
//
// Data path: gitignored data/match-stats.jsonl, env-overridable MATCH_STATS_FILE for the
// harness. Appends are sync but trivial (one small line); a byte-size threshold triggers a
// rewrite keeping the most recent MAX_LINES. Never throws — the match path must not depend
// on telemetry.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultFile = path.join(path.resolve(__dirname, '..'), 'data', 'match-stats.jsonl');

const MAX_LINES = 10000;
const TRIM_BYTES = 2 * 1024 * 1024; // ~10k lines × ~200B — trim pass at this size
let linesSinceTrim = 0;

function statsFile() {
  return process.env.MATCH_STATS_FILE || defaultFile;
}

/** Appends one match record. Never throws; a failure only costs the diagnostic line. */
export function recordMatchStat(info, input) {
  try {
    if (!info || typeof info !== 'object') return;
    const line = {
      ts: Date.now(),
      stage: info.stage ?? null,
      intent: info.intent ?? null,
      confidence: typeof info.confidence === 'number' ? info.confidence : null,
      margin: typeof info.margin === 'number' ? info.margin : null,
      inputLen: typeof input === 'string' ? input.length : null,
    };
    const file = statsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
    linesSinceTrim++;
    if (linesSinceTrim >= 5000 && fs.existsSync(file) && fs.statSync(file).size > TRIM_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8');
      linesSinceTrim = 0;
    }
  } catch {
    // Telemetry must never break the match path.
  }
}

/** Parses the log into records, newest last. Empty array on absence/corruption (per-line). */
export function readMatchStats() {
  try {
    const file = statsFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // A corrupt line is dropped, never fatal.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Aggregates the recent windows for the report: per-intent mean/min over the last
 * `window` records, the drift vs the `prevWindow`-old block (recentMean - prevMean),
 * and the stage distribution. Intents with < minCount recent records are not flagged
 * (too little signal to call drift).
 */
export function aggregateMatchStats({ window = 100, prevWindow = 200, minCount = 5 } = {}) {
  const records = readMatchStats();
  if (records.length === 0) return { records: 0, intents: [], stages: {} };

  const recent = records.slice(-window);
  const previous = records.slice(-prevWindow, -window);

  const stats = new Map();
  const push = (map, intent, confidence) => {
    if (!intent) return;
    const s = map.get(intent) ?? { intent, count: 0, sum: 0, min: Infinity, values: [] };
    s.count++;
    if (typeof confidence === 'number') {
      s.sum += confidence;
      s.min = Math.min(s.min, confidence);
      s.values.push(confidence);
    }
    map.set(intent, s);
  };
  const recentMap = new Map();
  const prevMap = new Map();
  for (const r of recent) push(recentMap, r.intent, r.confidence);
  for (const r of previous) push(prevMap, r.intent, r.confidence);

  const stages = {};
  for (const r of records) stages[r.stage ?? 'unknown'] = (stages[r.stage ?? 'unknown'] ?? 0) + 1;

  const intents = [];
  for (const s of recentMap.values()) {
    const prev = prevMap.get(s.intent);
    const mean = s.count > 0 ? s.sum / s.count : null;
    const prevMean = prev && prev.count > 0 ? prev.sum / prev.count : null;
    intents.push({
      intent: s.intent,
      count: s.count,
      mean: mean === null ? null : Number(mean.toFixed(3)),
      min: s.min === Infinity ? null : Number(s.min.toFixed(3)),
      drift: mean !== null && prevMean !== null ? Number((mean - prevMean).toFixed(3)) : null,
      flagged: s.count >= minCount && mean !== null && prevMean !== null && mean - prevMean < -0.1,
    });
  }
  intents.sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0) || (b.count - a.count));

  return { records: records.length, intents, stages };
}