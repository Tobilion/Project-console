#!/usr/bin/env node
/**
 * buildContrastivePairs.js — Step 3 (SetFit prep): assemble contrastive training pairs from
 * LOCAL data only. No model, no API, runs in seconds. Deterministic under --seed.
 *
 * Pair types:
 *   positive      — two distinct examples of the SAME intent (sampled, capped per intent).
 *   user-positive — a user-accepted near-miss input (data/near-misses/*.jsonl, accepted=true)
 *                   paired with an example of its mapped intent. Gold: real-user phrasing.
 *   negative      — cross-intent example pairs (random, count-matched to positives).
 *   hard-negative — a near-miss input (accepted or not: it confused the matcher either way)
 *                   paired with an example of a DIFFERENT intent. Boundary by construction.
 *
 * Every string passes through the held-out eval filter (server/evalGuard.js): frozen
 * real-user eval messages are NEVER training data, even when they appear in near-miss logs.
 *
 * Output: logs/contrastive-pairs.json { version, seed, counts, pairs: [{a, b, label}] }
 *   label 1 = same-intent (pull together), 0 = different-intent (push apart).
 *
 * Run: node --import tsx server/scripts/buildContrastivePairs.js [--seed 42] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const SEED = parseInt(getArg('--seed', '42'), 10);
const JSON_OUT = args.includes('--json');

// Deterministic RNG (mulberry32) so pair sets are reproducible across runs/machines.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { INTENTS } = await import('../intentsData.js');
const { filterHeldOut } = await import('../evalGuard.js');
const { mapNearMissToIntent } = await import('../nearMissIntentMap.js');

const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const POS_PER_INTENT = 12; // sampled same-intent pairs per intent (bounds output on 115-ex intents)
const intentNames = Object.keys(INTENTS).filter(k => (INTENTS[k].examples || []).length >= 2);

const pairs = [];
const stats = { positive: 0, userPositive: 0, negative: 0, hardNegative: 0, heldOutBlockedOccurrences: 0 };
const pushPair = (a, b, label, kind) => {
  const { kept, blocked } = filterHeldOut([a, b]);
  if (blocked > 0) { stats.heldOutSkipped += blocked; return; }
  void kept;
  pairs.push({ a, b, label });
  stats[kind]++;
};

// 1. same-intent positives (sampled pairs of distinct examples).
for (const name of intentNames) {
  const ex = INTENTS[name].examples;
  for (let i = 0; i < POS_PER_INTENT; i++) {
    const x = Math.floor(rand() * ex.length);
    let y = Math.floor(rand() * ex.length);
    if (y === x) y = (y + 1) % ex.length;
    pushPair(ex[x], ex[y], 1, 'positive');
  }
}

// 2/4. near-miss log pairs (gold user positives + boundary hard negatives).
const nmDir = path.join(rootDir, 'data', 'near-misses');
let nmInputs = 0;
try {
  for (const f of fs.readdirSync(nmDir).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(nmDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e.input || !e.resolvedCommand) continue;
      const mapped = mapNearMissToIntent(e.resolvedCommand, e.description);
      if (!mapped || !INTENTS[mapped] || !(INTENTS[mapped].examples || []).length) continue;
      nmInputs++;
      if (e.accepted === true) {
        pushPair(e.input, pick(INTENTS[mapped].examples), 1, 'userPositive');
      }
      // Hard negative: the confusing input vs a DIFFERENT intent's example.
      const others = intentNames.filter(n => n !== mapped);
      pushPair(e.input, pick(INTENTS[pick(others)].examples), 0, 'hardNegative');
    }
  }
} catch { /* no near-miss logs — positives/negatives below still stand */ }

// 3. random cross-intent negatives, count-matched to total positives.
const nPos = stats.positive + stats.userPositive;
for (let i = 0; i < nPos; i++) {
  const a = pick(intentNames);
  let b = pick(intentNames);
  if (b === a) b = intentNames[(intentNames.indexOf(a) + 1) % intentNames.length];
  pushPair(pick(INTENTS[a].examples), pick(INTENTS[b].examples), 0, 'negative');
}

const out = {
  version: 1,
  seed: SEED,
  generatedAt: new Date().toISOString(),
  intents: intentNames.length,
  nearMissInputs: nmInputs,
  counts: { ...stats, total: pairs.length },
  pairs,
};
fs.mkdirSync(path.join(rootDir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(rootDir, 'logs', 'contrastive-pairs.json'), JSON.stringify(out));

if (JSON_OUT) console.log(JSON.stringify({ ...out, pairs: `[${pairs.length} pairs]` }, null, 2));
else {
  console.log(`contrastive pairs (seed ${SEED}): total=${pairs.length} positive=${stats.positive} userPositive=${stats.userPositive} negative=${stats.negative} hardNegative=${stats.hardNegative} heldOutSkipped=${stats.heldOutSkipped} nearMissInputs=${nmInputs}`);
  console.log('wrote logs/contrastive-pairs.json (gitignored)');
}
