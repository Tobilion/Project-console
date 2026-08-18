// Phase 3 decomposition leaf: raw best-scoring intent search for SemanticMatcher (extracted
// verbatim from semanticMatcher.js — see that file's nearestIntent for the original).

import { scanAllVectors } from './intentVectorScan.js';

/**
 * Raw best-scoring intent with NO floor or margin gating — used by matcher.js's no-match
 * path to offer a non-blocking "did you mean" chip when nothing cleared the normal gates but
 * the embedding still strongly favors one intent (callers gate on the returned confidence
 * themselves; this app's threshold is 0.45). Returns { intent, confidence, meta } or null.
 * `embedInput` is a function returning the vector data for a string — semanticMatcher passes
 * its cached embedInput so repeated did-you-mean lookups skip the model call (Phase 6).
 */
export async function computeNearestIntent(embedInput, inputStr, projectIntentVectors, intentVectors) {
  if (!embedInput) return null;
  try {
    const inputData = await embedInput(inputStr);
    if (!inputData) return null;
    let bestIntent = null;
    let bestScore = -1;
    let bestMeta = null;
    const consider = (sim, intent, meta) => {
      if (sim > bestScore) {
        bestScore = sim;
        bestIntent = intent;
        bestMeta = meta;
      }
    };
    scanAllVectors(inputData, projectIntentVectors, intentVectors, consider);
    if (bestIntent) return { intent: bestIntent, confidence: bestScore, meta: bestMeta };
    return null;
  } catch (err) {
    return null;
  }
}
