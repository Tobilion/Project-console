// Phase 3 decomposition leaf: the full match() pipeline for SemanticMatcher (extracted
// verbatim from semanticMatcher.js — same stage order, floor/margin/collision logic, and
// telemetry shape). Operates on the live matcher singleton's state through the `matcher` arg.

import { findPreSemanticOverride } from './preSemanticOverrides.js';
import { matchKeywordRule } from './keywordRules.js';
import { runSemanticStage, runFuzzyStage } from './matcherStages.js';
import { getEffectiveThreshold } from './intentTelemetry.js';

export async function runMatchPipeline(matcher, input) {
  if (!matcher.ready) {
    try {
      await matcher.initialize();
    } catch {
      return null;
    }
  }

  const inputStr = input.trim().toLowerCase();
  if (!inputStr) return null;

  const _stages = [];

  // 0. Literal pre-checks for phrases confirmed (via live user testing, not just theory) to
  // get misclassified by pure embedding similarity to a superficially-similar but wrong
  // intent. Data + rationale live in preSemanticOverrides.js (Phase 5 split, 2026-08-04) —
  // the check itself is unchanged.
  const override = findPreSemanticOverride(inputStr);
  if (override) {
    _stages.push({ stage: 'literal_override', intent: override.intent, confidence: 0.9, matched: true });
    matcher._lastTelemetry = { stages: _stages, winner: 'literal_override', finalIntent: override.intent, finalConfidence: 0.9 };
    return { intent: override.intent, confidence: 0.9, source: 'keyword' };
  }

  // 1. Semantic matching via embedding cosine similarity (stage runner in matcherStages.js,
  // Phase 5 split — floor/margin/collision/closeSecond logic and telemetry shape unchanged)
  try {
    const sem = await runSemanticStage(inputStr, {
      extractor: matcher.extractor,
      embedInput: (t) => matcher.embedInput(t),
      projectIntentVectors: matcher.projectIntentVectors,
      intentVectors: matcher.intentVectors,
      getFloor: getEffectiveThreshold,
    });
    _stages.push(sem.stage);
    if (sem.result) {
      matcher._lastTelemetry = { stages: _stages, winner: 'semantic', finalIntent: sem.result.intent, finalConfidence: sem.result.confidence };
      return sem.result;
    }
  } catch (err) {
    _stages.push({ stage: 'semantic', matched: false, error: err.message });
  }

  // 2. Fuse.js fuzzy fallback (stage runner in matcherStages.js, Phase 5 split)
  const fz = runFuzzyStage(inputStr, matcher.fuseIndex);
  _stages.push(fz.stage);
  if (fz.result) {
    matcher._lastTelemetry = { stages: _stages, winner: 'fuzzy', finalIntent: fz.result.intent, finalConfidence: fz.result.confidence };
    return fz.result;
  }

  // 3. Keyword fallback for common patterns (rules + first-match-wins semantics in
  // keywordRules.js, Phase 5 split — per-rule confidences and telemetry shape unchanged)
  const kwRule = matchKeywordRule(inputStr);
  if (kwRule) {
    _stages.push({ stage: 'keyword', intent: kwRule.intent, confidence: kwRule.confidence, matched: true });
    matcher._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: kwRule.intent, finalConfidence: kwRule.confidence };
    return { intent: kwRule.intent, confidence: kwRule.confidence, source: 'keyword' };
  }

  _stages.push({ stage: 'keyword', matched: false });
  matcher._lastTelemetry = { stages: _stages, winner: null, finalIntent: null, finalConfidence: 0 };
  return null;
}
