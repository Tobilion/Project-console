// Phase 3 decomposition leaf: intent-collision detection for SemanticMatcher (extracted
// verbatim from semanticMatcher.js — see that file's findIntentCollisions for the original).

import { averageIntentVectors, cosineSimilarity } from './intentVectorScan.js';

/**
 * Averages each intent's per-phrase embedding vectors into a single representative vector,
 * then compares every pair. Returns pairs whose cosine similarity exceeds `threshold` —
 * these intents may be hard for the model to distinguish.
 */
export function computeIntentCollisions(intentVectors, threshold = 0.9) {
  if (!intentVectors) return [];
  const avgVectors = averageIntentVectors(intentVectors);
  const collisions = [];
  const seen = new Set();
  for (const [a, va] of Object.entries(avgVectors)) {
    for (const [b, vb] of Object.entries(avgVectors)) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (a === b || seen.has(key)) continue;
      seen.add(key);
      const sim = cosineSimilarity(va, vb);
      if (sim >= threshold) {
        collisions.push({ intentA: a, intentB: b, similarity: sim });
      }
    }
  }
  collisions.sort((a, b) => b.similarity - a.similarity);
  return collisions;
}
