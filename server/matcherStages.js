/**
 * Semantic + fuzzy stage runners for semanticMatcher.match() (Phase 5 split, 2026-08-04 —
 * extracted from semanticMatcher.js, logic and telemetry shapes unchanged). Each runner
 * returns { result, stage } where `result` is the accepted match (or null) and `stage` is
 * the telemetry entry the caller pushes onto its stage list.
 */
import { scanAllVectors, cosineSimilarity } from './intentVectorScan.js';

/**
 * Embedding cosine-similarity stage: best project vector, then best base-intent vector,
 * gated on the intent's effective floor (per-intent telemetry threshold when one exists,
 * else 0.6) plus a MIN_MARGIN lead over the runner-up. On acceptance, a second cheap pass
 * finds the best-scoring DIFFERENT intent (see the collision comment below) and returns
 * collision/closeSecond alongside the winner.
 */
export async function runSemanticStage(inputStr, { extractor, projectIntentVectors, intentVectors, getFloor }) {
  const inputVec = await extractor(inputStr, { pooling: 'mean', normalize: true });
  const inputData = inputVec.data;

  let bestIntent = null;
  let bestScore = -1;
  let bestMeta = null;
  let secondBestScore = -1;

  const consider = (sim, intent, meta) => {
    if (sim > bestScore) {
      secondBestScore = bestScore;
      bestScore = sim;
      bestIntent = intent;
      bestMeta = meta;
    } else if (sim > secondBestScore) {
      secondBestScore = sim;
    }
  };

  scanAllVectors(inputData, projectIntentVectors, intentVectors, consider);

  const effectiveFloor = bestIntent ? getFloor(bestIntent) : 0.6;
  const MIN_MARGIN = 0.03;
  // Non-blocking "did you mean" band (2026-08-04): a different intent within this margin
  // of the winner is NOT ambiguous enough to block on (that's `collision` below), but is
  // close enough that surfacing it as a chip on the answer is worth it. Only applies to
  // accepted semantic matches — the no-match case uses nearestIntent() instead.
  const CLOSE_MARGIN = 0.10;
  const margin = bestScore - secondBestScore;
  const stage = { stage: 'semantic', intent: bestIntent, confidence: bestScore, margin, floor: effectiveFloor, matched: bestScore >= effectiveFloor && margin >= MIN_MARGIN };

  if (!(bestScore >= effectiveFloor && margin >= MIN_MARGIN)) return { result: null, stage };

  // Requested directly (2026-07-30) after "Stop it" silently matched system.chit_chat.yes_no
  // instead of the stop-server intent it was meant for — a true collision (two DIFFERENT
  // intents scoring almost identically) was previously indistinguishable from an ordinary
  // confident match, and got silently resolved to whichever won by a hair. `secondBestScore`
  // above can belong to the SAME intent as the winner (a different example phrase scoring
  // almost as well), which isn't a real ambiguity — so this does a second, cheap pass to find
  // the best-scoring vector belonging to a genuinely DIFFERENT intent, and only flags a
  // collision when that different intent is nearly tied with the winner. matcher.js turns
  // this into a "did you mean X or Y?" prompt instead of guessing — scoped deliberately
  // narrow (only fires when we were about to confidently return an answer anyway) per the
  // user's explicit choice to limit this to true collisions, not every low-confidence match.
  let bestOtherIntent = null;
  let bestOtherScore = -1;
  let bestOtherMeta = null;
  const considerOther = (sim, intent, meta) => {
    if (intent === bestIntent) return;
    if (sim > bestOtherScore) {
      bestOtherScore = sim;
      bestOtherIntent = intent;
      bestOtherMeta = meta;
    }
  };
  scanAllVectors(inputData, projectIntentVectors, intentVectors, considerOther);

  const trueMargin = bestOtherIntent ? bestScore - bestOtherScore : 1;
  const collision = (bestOtherIntent && trueMargin < MIN_MARGIN)
    ? { intent: bestOtherIntent, confidence: bestOtherScore, meta: bestOtherMeta }
    : null;
  const closeSecond = (bestOtherIntent && !collision && trueMargin <= CLOSE_MARGIN)
    ? { intent: bestOtherIntent, confidence: bestOtherScore, meta: bestOtherMeta }
    : null;

  return {
    result: { intent: bestIntent, confidence: bestScore, source: 'semantic', meta: bestMeta, collision, closeSecond },
    stage,
  };
}

/**
 * Fuse.js fuzzy fallback stage. Fuzzy floor scales with input length (0.35 for ≤3 chars,
 * 0.4 for ≤4, 0.55 otherwise) — 0.4 used to cut off single-edit typos on short inputs
 * ("hep" -> "help") before they ever reached this second gate. Project-trigger hits get
 * their { projectIndex, entryIndex } meta reconstructed from the synthetic intent name.
 */
export function runFuzzyStage(inputStr, fuseIndex) {
  try {
    const fuseResults = fuseIndex.search(inputStr);
    if (fuseResults.length > 0) {
      const top = fuseResults[0];
      const confidence = 1 - top.score;
      const item = top.item;
      const fuzzyFloor = inputStr.length <= 3 ? 0.35 : inputStr.length <= 4 ? 0.4 : 0.55;
      const stage = { stage: 'fuzzy', intent: item.intent, confidence, floor: fuzzyFloor, matched: confidence >= fuzzyFloor };
      if (confidence >= fuzzyFloor) {
        const result = { intent: item.intent, confidence, source: 'fuzzy' };
        if (item.isProject) {
          const parts = item.intent.split('.');
          const pIdx = parseInt(parts[2], 10);
          const eIdx = parseInt(parts[3], 10);
          result.meta = { projectIndex: pIdx, entryIndex: eIdx };
        }
        return { result, stage };
      }
      return { result: null, stage };
    }
    return { result: null, stage: { stage: 'fuzzy', matched: false, reason: 'no results' } };
  } catch {
    return { result: null, stage: { stage: 'fuzzy', matched: false, error: 'exception' } };
  }
}
