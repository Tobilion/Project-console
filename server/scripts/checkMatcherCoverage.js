/**
 * checkMatcherCoverage.js â€” committed regression harness for the intent-matching pipeline.
 *
 * Run:  npm run check-matcher
 * Probe: node server/scripts/checkMatcherCoverage.js --probe   (prints actual routing, no asserts)
 *
 * Uses REAL embeddings (Xenova/all-MiniLM-L6-v2, cached at .cache/xenova â€” offline, ~60-120s
 * cold model load). The batteries are self-asserting {input, expect} pairs baked from the
 * current verified behavior of the real modules â€” no temp baseline files, so a regression in
 * any split/refactor shows up as a hard FAIL instead of a diff. `--probe` is the calibrator:
 * when intents intentionally grow/change, re-probe, eyeball the deltas, then update EXPECT.
 *
 * Batteries (see CLAUDE.md for provenance):
 *  - CONTROL: spec Â§4.3 control battery in its CURRENT documented state (two accepted changes:
 *    'run the tests' -> run_tests [Phase 1], 'what is the link' -> dev_server_status [Phase 1]).
 *  - PHASE1/2/3, BASICS: per-phase intent batteries from the 2026-08-03 intent-expansion records.
 *  - MATCHDAY: the 2026-08-04 "run server"/"run its server" misroute regression set.
 *  - TRAPS: confirmed-live misclassification regressions (2026-07-28/29/30).
 *  - MUST_NOT_STEAL: adjacent intents that must NOT capture another intent's phrasings.
 *  - GARBAGE: out-of-distribution input must land on the fallback, never a confident intent.
 *
 * NOTE: 'stop server' / 'what is the dev url' have connection.js pre-checks in the live app and
 * never reach the matcher there â€” they are deliberately NOT in this harness (matcher-only).
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const PROBE = process.argv.includes('--probe');
// Derived from this script's own location, not hardcoded to one machine/username â€” was
// literally `C:/Users/tobil/Desktop/Projects/Project console/server/`, which only ever worked
// on the original author's own machine (broke immediately for any other contributor, any other
// install path, or npm-published use â€” audit 2026-08-10, raised while generalizing the package
// for public distribution).
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;

const { semanticMatcher } = await import(pathToFileURL(base + 'semanticMatcher.js').href);
const { matchInput, isNlpBuiltinEligible } = await import(pathToFileURL(base + 'matcher.js').href);

import { project, fmt, BATTERIES } from './batteries/matcherBatteries.js';


await semanticMatcher.initialize();
await semanticMatcher.addProjectIntents([project]);

let total = 0, failed = 0;
for (const battery of BATTERIES) {
  // Phase 14: batteries with an `activeWhen` predicate only run when it passes (the de-locale
  // battery is machine-independent â€” it runs only when the profile locale is actually 'de').
  if (battery.activeWhen && !battery.activeWhen()) {
    if (PROBE) console.log(`\n=== ${battery.name} === (skipped â€” locale not active)`);
    continue;
  }
  console.log(`\n=== ${battery.name} ===`);
  for (const item of battery.items) {
    if (battery.unit) {
      // Unit-style rows (no embeddings): [intent, input, expected] against a pure predicate â€”
      // same pattern as the fixture-based unit rows in checkHandlerCoverage.js.
      const [intent, input, expected] = item;
      const got = isNlpBuiltinEligible(intent, input);
      const ok = got === expected;
      total++;
      if (!ok) failed++;
      if (PROBE) console.log(`  ${JSON.stringify(intent).padEnd(44)} / ${JSON.stringify(input).padEnd(30)} -> ${got}`);
      else if (!ok) console.log(`  FAIL ${JSON.stringify(intent)} / ${JSON.stringify(input)}\n    expected: ${expected}\n    got:      ${got}`);
      continue;
    }
    const [input, expect] = item;
    const r = await matchInput(input, project, 0);
    const got = fmt(r);
    const ok = got === expect;
    total++;
    if (!ok) failed++;
    if (PROBE) console.log(`  ${JSON.stringify(input).padEnd(58)} -> ${got}`);
    else if (!ok) console.log(`  FAIL ${JSON.stringify(input)}\n    expected: ${expect}\n    got:      ${got}`);
  }
  if (!PROBE) console.log(`  (${battery.items.length} inputs)`);
}

if (PROBE) {
  console.log(`\nProbe complete â€” ${total} inputs routed. Bake the desired outputs into EXPECT.`);
  process.exit(0);
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);