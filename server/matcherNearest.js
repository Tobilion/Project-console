// Phase 3 decomposition leaf: raw best-scoring intent search for SemanticMatcher (extracted
// verbatim from semanticMatcher.js — see that file's nearestIntent for the original).

import { scanAllVectors } from './intentVectorScan.js';

/**
 * Raw best-scoring intent with NO floor or margin gating — used by matcher.js's no-match
 * path to offer a non-blocking "did you mean" chip when nothing cleared the normal gates but
 * the embedding still strongly favors one intent (callers gate on the returned confidence
 * themselves; this app's threshold is 0.45). Returns { intent, confidence, meta } or null.
 */
export async function computeNearestIntent(extractor, inputStr, projectIntentVectors, intentVectors) {
  if (!extractor) return null;
  try {
    const inputVec = await extractor(inputStr, {
      pooling: 'mean',
      normalize: true,
    });
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
    scanAllVectors(inputVec.data, projectIntentVectors, intentVectors, consider);
    if (bestIntent) return { intent: bestIntent, confidence: bestScore, meta: bestMeta };
    return null;
  } catch (err) {
    return null;
  }
}
