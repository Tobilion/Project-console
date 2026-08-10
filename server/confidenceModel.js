// Stage 1 of the "use ML instead of hardcoding" work (2026-07-29, requested directly): a small,
// pure-JS logistic regression trained on real accept/reject outcomes, used to replace the fixed
// if/else threshold-bump rules in intentTelemetry.js's suggestThresholds() with a learned floor.
// Deliberately does NOT depend on Ollama or any local/cloud AI model — this is classic supervised
// learning over numbers already being logged (intentTelemetry.js's stages/confidence/margin data
// plus the falsePositive label set in connection.js whenever a gated action is approved or
// rejected), so it works identically whether or not AI mode has ever been used.
//
// Phase 3 (2026-08-04): the gradient-descent math lives in logisticRegression.js and the model
// file persistence in modelStore.js; this module owns feature extraction, labeled-example
// collection, and the retrain/predict/floor-search orchestration on top of those two leaves.
import { readTelemetry, listTelemetryProjectIds } from './telemetryFile.js';
import { loadModel, saveModel } from './modelStore.js';
import { sigmoid, trainLogisticRegression } from './logisticRegression.js';
import { PURE_CHITCHAT_INTENTS } from './intentTrust.js';

// Below this many labeled examples, don't trust the model at all — a handful of accept/reject
// outcomes would just overfit to noise. suggestThresholds() falls back to its original hardcoded
// heuristic until real usage crosses this bar, so there's zero regression for a fresh install.
const MIN_LABELED = 12;

// Phase 4 (audit 2026-08-10 §2.2): one pooled model fit across every intent meant a single
// family's quirks could only ever be patched with a hand-authored clamp bolted on afterward —
// which is exactly how CHITCHAT_FLOOR_MIN (intentTelemetry.js) came to exist: the pooled model
// ratcheted every high-match intent's floor down together, including zero-argument canned
// chit-chat replies that should never get more permissive. Splitting by family means each
// group's floor is learned from examples of THAT group's own behavior, and a future family with
// its own quirks doesn't need its own hand-authored clamp — it just needs enough of its own
// labeled examples. Coarse and heuristic on purpose (name-prefix matching over the existing
// dot/underscore intent-naming convention — see CLAUDE.md's "Intent catalog"), not a real
// taxonomy: the goal is separating groups that behave differently, not modeling the full
// hierarchy. CHITCHAT_FLOOR_MIN in intentTelemetry.js stays in place regardless — this is
// defense in depth, not a replacement for it.
export const INTENT_FAMILIES = ['chitchat', 'git', 'knowledge', 'general'];

/** Coarse family classification for an intent name, used to route it to its own sub-model. */
export function familyOf(intent) {
  if (!intent) return 'general';
  if (PURE_CHITCHAT_INTENTS.has(intent) || intent.startsWith('system.chit_chat.')) return 'chitchat';
  if (intent.startsWith('git_') || intent.startsWith('git.')) return 'git';
  if (intent.startsWith('project.')) return 'knowledge';
  return 'general';
}

const FEATURE_NAMES = ['confidence', 'margin', 'isSemantic', 'isFuzzy', 'isKeyword', 'isLiteralOverride', 'inputLenNorm'];

// Search range/step for deriving a recommended floor from the trained model (see learnedFloor()
// below) and the target confidence level a floor should clear.
const FLOOR_SEARCH_MIN = 0.35;
const FLOOR_SEARCH_MAX = 0.95;
const FLOOR_SEARCH_STEP = 0.02;
const TARGET_ACCEPT_PROB = 0.7;

/**
 * Turns one telemetry record (see telemetryStats.js's getIntentStats / intentTelemetry.js's
 * logMatch) into a numeric feature vector. Pooled across every project rather than trained
 * per-project or per-intent — a single personal user generates too few labeled examples for
 * either to have enough data on its own, and the underlying dispatcher behavior these features
 * describe (how a semantic score/margin/winning stage relates to whether the user actually wanted
 * that result) doesn't really differ by project.
 */
export function extractFeatures(record) {
  const stages = record.stages || [];
  const semanticStage = stages.find((s) => s.stage === 'semantic');
  const confidence = typeof record.finalConfidence === 'number' ? record.finalConfidence : 0;
  const margin = semanticStage && typeof semanticStage.margin === 'number' ? semanticStage.margin : 0;
  const winner = record.winner || '';
  return [
    confidence,
    margin,
    winner === 'semantic' ? 1 : 0,
    winner === 'fuzzy' ? 1 : 0,
    winner === 'keyword' ? 1 : 0,
    winner === 'literal_override' ? 1 : 0,
    Math.min(1, (record.input?.length || 0) / 60),
  ];
}

/** Every labeled telemetry record across every project, grouped by intent family —
 *  falsePositive is only set (true/false) when a gated action's confirm/reject response
 *  actually got linked back to a telemetry entry (see connectionConfirm.js); everything else is
 *  unlabeled and skipped. */
function collectLabeledExamplesByFamily() {
  const byFamily = Object.fromEntries(INTENT_FAMILIES.map((f) => [f, { X: [], y: [] }]));
  for (const projectId of listTelemetryProjectIds()) {
    for (const entry of readTelemetry(projectId)) {
      if (entry.falsePositive !== true && entry.falsePositive !== false) continue;
      if (!entry.finalIntent) continue;
      const family = familyOf(entry.finalIntent);
      byFamily[family].X.push(extractFeatures(entry));
      byFamily[family].y.push(entry.falsePositive ? 0 : 1); // accepted -> 1, rejected -> 0
    }
  }
  return byFamily;
}

function trainOneFamily(X, y) {
  if (X.length < MIN_LABELED) return null;
  const { weights, bias } = trainLogisticRegression(X, y);

  // learnedFloor() below needs to hold margin/input-length at "typical" values while it searches
  // over confidence alone. A fixed guessed constant doesn't reflect this model's own training
  // distribution — verified live: with real accepted examples averaging margin ~0.17, a fixed
  // guess of 0.08 made the search fall short of the target probability almost everywhere and
  // pinned the recommended floor at the search ceiling regardless of confidence. Using the actual
  // mean margin/input-length among this model's own accepted examples keeps the floor search
  // self-consistent with what it was trained on, instead of guessing at a second set of numbers.
  const acceptedIdx = y.map((label, i) => (label === 1 ? i : -1)).filter((i) => i >= 0);
  const meanOf = (col) => acceptedIdx.length
    ? acceptedIdx.reduce((s, i) => s + X[i][col], 0) / acceptedIdx.length
    : (col === 1 ? 0.08 : 0.33);

  return {
    weights,
    bias,
    sampleCount: X.length,
    trainedAt: Date.now(),
    features: FEATURE_NAMES,
    typicalMargin: meanOf(1),
    typicalInputLenNorm: meanOf(6),
  };
}

/**
 * Retrains one confidence model per intent family from every project's labeled telemetry. Safe
 * to call often (startup sweep, and fire-and-forget after every new label — see
 * index.js/connectionConfirm.js): a family below MIN_LABELED examples is left untrained (null),
 * so suggestThresholds() keeps using the original hardcoded heuristic for that family's intents
 * until there's real signal to trust something learned over it — independently per family, not
 * gated on the total across all of them.
 */
export function retrainConfidenceModel() {
  const byFamily = collectLabeledExamplesByFamily();
  const families = {};
  let totalSamples = 0;
  let anyTrained = false;
  for (const family of INTENT_FAMILIES) {
    const { X, y } = byFamily[family];
    const trained = trainOneFamily(X, y);
    families[family] = trained || { sampleCount: X.length };
    totalSamples += X.length;
    if (trained) anyTrained = true;
  }
  saveModel({ families, retrainedAt: Date.now() });
  return { trained: anyTrained, sampleCount: totalSamples, families: Object.fromEntries(
    INTENT_FAMILIES.map((f) => [f, { trained: !!families[f].weights, sampleCount: families[f].sampleCount }])
  ) };
}

function familyModel(family) {
  const store = loadModel();
  const m = store?.families?.[family];
  return m?.weights ? m : null;
}

/** Predicted probability [0,1] that a match with these features would be accepted, for the given
 *  intent family, or null if that family's model hasn't been trained yet. */
export function predictAcceptProbability(features, family = 'general') {
  const model = familyModel(family);
  if (!model) return null;
  const z = model.bias + features.reduce((s, x, j) => s + x * (model.weights[j] || 0), 0);
  return sigmoid(z);
}

/**
 * Finds the lowest semantic confidence score at which the given family's trained model predicts
 * P(accept) >= TARGET_ACCEPT_PROB, holding margin/winning-stage/input-length at typical passing
 * values — i.e. "how confident does a semantic match in this family need to be before it's
 * actually worth trusting", learned from that family's own real accept/reject outcomes instead
 * of guessed at, and instead of borrowing another family's curve. Returns null if this family's
 * model isn't trained yet (caller should fall back to the existing hardcoded heuristic).
 */
export function learnedFloor(family = 'general') {
  const model = familyModel(family);
  if (!model) return null;
  const typicalMargin = typeof model.typicalMargin === 'number' ? model.typicalMargin : 0.08;
  const typicalInputLenNorm = typeof model.typicalInputLenNorm === 'number' ? model.typicalInputLenNorm : 0.33;
  for (let c = FLOOR_SEARCH_MIN; c <= FLOOR_SEARCH_MAX; c += FLOOR_SEARCH_STEP) {
    const p = predictAcceptProbability([c, typicalMargin, 1, 0, 0, 0, typicalInputLenNorm], family);
    if (p !== null && p >= TARGET_ACCEPT_PROB) return Math.round(c * 100) / 100;
  }
  // Model never reaches the target confidence even at the search ceiling — be conservative
  // rather than silently returning a floor that doesn't reflect what it actually learned.
  return FLOOR_SEARCH_MAX;
}

/**
 * With a family name, returns that family's own training status. With no argument, returns an
 * aggregate across every family (kept for the `telemetry review` summary line/existing callers)
 * plus a `families` breakdown for anything that wants the detail.
 */
export function getModelInfo(family) {
  const store = loadModel();
  if (family) {
    const m = store?.families?.[family];
    if (!m?.weights) return { trained: false, minRequired: MIN_LABELED, sampleCount: m?.sampleCount || 0 };
    return { trained: true, sampleCount: m.sampleCount, trainedAt: m.trainedAt, minRequired: MIN_LABELED };
  }
  if (!store?.families) return { trained: false, minRequired: MIN_LABELED, sampleCount: 0 };
  let sampleCount = 0;
  let trained = false;
  let trainedAt = null;
  const families = {};
  for (const f of INTENT_FAMILIES) {
    const m = store.families[f];
    sampleCount += m?.sampleCount || 0;
    families[f] = { trained: !!m?.weights, sampleCount: m?.sampleCount || 0 };
    if (m?.weights) {
      trained = true;
      if (!trainedAt || m.trainedAt > trainedAt) trainedAt = m.trainedAt;
    }
  }
  return { trained, sampleCount, trainedAt, minRequired: MIN_LABELED, families };
}