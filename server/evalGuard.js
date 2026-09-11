// evalGuard.js — single gate between real-user eval data and every training/promotion path.
//
// The frozen held-out set at server/scripts/eval/heldOutEval.json contains verbatim real user
// messages. Nothing in the repo may train on them: not learningEngine promotions, not
// learned-intents persistence, not locale merges, not direct script edits. Every site that
// writes to intent.examples (or feeds addLearnedExamples/addLearnedPhrase) must filter through
// filterHeldOut() first. Imports only node builtins so any module (incl. intentsData.js at
// startup) can use it with zero cycle risk.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELD_OUT_PATH = path.join(__dirname, 'scripts', 'eval', 'heldOutEval.json');

let heldOutSet = null;

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadHeldOut() {
  if (heldOutSet) return heldOutSet;
  heldOutSet = new Set();
  try {
    if (fs.existsSync(HELD_OUT_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HELD_OUT_PATH, 'utf8'));
      const msgs = Array.isArray(raw) ? raw : raw.messages || [];
      for (const m of msgs) {
        const n = normalize(typeof m === 'string' ? m : m.input || m.text || '');
        if (n) heldOutSet.add(n);
      }
    }
  } catch {
    // Empty set on any failure — the caller still runs, just without held-out filtering.
    // Promotion paths log the blocked count, so a missing file is visible, never silent.
  }
  return heldOutSet;
}

/** True when the phrase is a verbatim held-out eval message (normalized comparison). */
export function isHeldOut(phrase) {
  const set = loadHeldOut();
  if (set.size === 0) return false;
  return set.has(normalize(phrase));
}

/**
 * Split candidate phrases into { kept, blocked }. Promotion callers keep `kept` and must
 * drop `blocked` (held-out eval data). Pure + sync so it can sit inside any writer.
 */
export function filterHeldOut(phrases) {
  const kept = [];
  let blocked = 0;
  for (const p of phrases || []) {
    if (isHeldOut(typeof p === 'string' ? p : p.phrase || '')) blocked++;
    else kept.push(p);
  }
  return { kept, blocked };
}

/** Path + size for diagnostics (eval runner, doctor-style checks). */
export function heldOutInfo() {
  const set = loadHeldOut();
  return { path: HELD_OUT_PATH, size: set.size };
}
