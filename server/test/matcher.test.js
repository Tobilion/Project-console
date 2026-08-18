// Counted regression suite for the intent-matching pipeline. Runs the same batteries as
// the legacy check-matcher harness (server/scripts/checkMatcherCoverage.js) under the
// node:test runner, so every case is an individually-named test. The embedding model
// loads once in `before` (cold load ~60-120s) and is reused by every case; tests within
// this file run serially by default, which the model needs.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { semanticMatcher } from '../semanticMatcher.js';
import { matchInput, isNlpBuiltinEligible } from '../matcher.js';
import { project, fmt, BATTERIES } from '../scripts/batteries/matcherBatteries.js';

before(async () => {
  await semanticMatcher.initialize();
  await semanticMatcher.addProjectIntents([project]);
});

for (const battery of BATTERIES) {
  if (battery.activeWhen && !battery.activeWhen()) continue;

  if (battery.unit) {
    for (const [intent, input, expected] of battery.items) {
      test(`[${battery.name}] ${intent} / ${input}`, () => {
        assert.equal(isNlpBuiltinEligible(intent, input), expected);
      });
    }
    continue;
  }

  for (const [input, expect] of battery.items) {
    test(`[${battery.name}] ${input}`, async () => {
      const result = await matchInput(input, project, 0);
      assert.equal(fmt(result), expect);
    });
  }
}
