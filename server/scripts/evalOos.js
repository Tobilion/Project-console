#!/usr/bin/env node
/**
 * evalOos.js — OOS false-positive measurement (Step 6).
 *
 * Routes every utterance in server/oosUtterances.js through the real matchInput pipeline:
 *   FP = an OOS input dispatching real work (builtin intent, multi with a builtin item, or a
 *        project config-entry match). Reported overall + per-intent attribution.
 *   oos-catch = OOS inputs the NLP none-of-the-above class settles (no dispatch, no router
 *        call, transcript stage 'nlp-oos'). The remainder fall through to the legacy
 *        fallback/guess path — same user-visible outcome, less signal.
 *
 * FP gate for real intents = check-matcher (any battery input newly landing on OOS fails its
 * EXPECT row loudly — the false-negative direction is harness-covered, not eyeballed here).
 *
 * Run: npm run check-oos (node --import tsx server/scripts/evalOos.js [--json])
 */

import { matchInput } from '../matcher.js';
import { project } from './batteries/matcherBatteries.js';
import { OOS_TRAIN, OOS_BOUNDARY } from '../oosUtterances.js';

const JSON_OUT = process.argv.includes('--json');
const OUT_FILE = (() => {
  const i = process.argv.indexOf('--out');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

const { semanticMatcher } = await import('../semanticMatcher.js');
await semanticMatcher.initialize();
await semanticMatcher.addProjectIntents([project]);

function classify(r) {
  if (!r) return { kind: 'none' };
  if (r.oos) return { kind: 'oos' };
  if (r.multi) {
    const builtins = r.multi.map(m => m.builtin).filter(Boolean);
    return builtins.length ? { kind: 'fp', via: 'multi', intents: builtins } : { kind: 'fallback' };
  }
  // Builtin with no semanticSource and not router-routed = NLP-stage win (fuzzy never
  // dispatches builtins — suggestions/didYouMean only).
  if (r.builtin) return { kind: 'fp', via: r.routedByModel ? 'router' : (r.semanticSource || 'nlp'), intents: [r.builtin] };
  if (r.match) return { kind: 'fp', via: 'config-entry', intents: [r.match.type || 'entry'] };
  if (r.disambiguate) return { kind: 'fallback', via: 'disambiguate' };
  return { kind: 'fallback' };
}

async function runSet(list) {
  const out = { total: list.length, fp: 0, oos: 0, fallback: 0, byIntent: {}, byVia: {}, fpExamples: [] };
  for (const input of list) {
    const c = classify(await matchInput(input, project, 0));
    if (c.kind === 'fp') {
      out.fp++;
      for (const i of c.intents) out.byIntent[i] = (out.byIntent[i] || 0) + 1;
      out.byVia[c.via] = (out.byVia[c.via] || 0) + 1;
      if (out.fpExamples.length < 40) out.fpExamples.push({ input, via: c.via, intents: c.intents });
    }
    else if (c.kind === 'oos') out.oos++;
    else out.fallback++;
  }
  out.fpRate = out.total ? Number((out.fp / out.total).toFixed(4)) : 0;
  return out;
}

const train = await runSet(OOS_TRAIN);
const boundary = await runSet(OOS_BOUNDARY);
const report = {
  train: { n: train.total, fp: train.fp, fpRate: train.fpRate, oosCaught: train.oos, fallback: train.fallback, byIntent: train.byIntent, byVia: train.byVia, fpExamples: train.fpExamples },
  boundary: { n: boundary.total, fp: boundary.fp, fpRate: boundary.fpRate, oosCaught: boundary.oos, fallback: boundary.fallback, byIntent: boundary.byIntent, byVia: boundary.byVia, fpExamples: boundary.fpExamples },
  note: 'FN direction is harness-covered: any battery input landing on OOS fails check-matcher EXPECT.',
};

if (OUT_FILE) {
  const fs = await import('fs');
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  console.log(`wrote ${OUT_FILE}`);
} else if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  for (const [name, r] of [['TRAIN (179, clear-OOS)', report.train], ['BOUNDARY (19, near-console)', report.boundary]]) {
    console.log(`\n=== OOS ${name} ===`);
    console.log(`fp: ${r.fp}/${r.n} (${(r.fpRate * 100).toFixed(1)}%)  oos-caught: ${r.oosCaught}  fallback: ${r.fallback}`);
    const top = Object.entries(r.byIntent).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) console.log('top claiming intents: ' + top.map(([i, n]) => `${i}×${n}`).join(', '));
    for (const e of r.fpExamples.slice(0, 8)) console.log(`  FP '${e.input.slice(0, 70)}' -> [${e.intents.join(', ')}] via ${e.via}`);
  }
}
