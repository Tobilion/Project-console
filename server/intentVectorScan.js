/**
 * Pure vector machinery shared by semanticMatcher's match / nearestIntent /
 * bestProjectCommandEntry / findIntentCollisions (Phase 5 split, 2026-08-04 —
 * extracted from semanticMatcher.js, logic unchanged).
 *
 * projectIntentVectors shape: { intentName: { vectors, projectIndex, entryIndex } }
 * intentVectors shape:        { intentName: [vec, ...] }
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Run `consider(similarity, intent, meta)` over every vector in both the project-specific
 * and base intent sets, in that order. `meta` carries { projectIndex, entryIndex } for
 * project vectors and null for base intents — exactly the dual loop match()/nearestIntent()
 * used to inline.
 */
export function scanAllVectors(inputData, projectIntentVectors, intentVectors, consider) {
  for (const [intent, data] of Object.entries(projectIntentVectors)) {
    for (const vec of data.vectors) {
      consider(cosineSimilarity(inputData, vec), intent, { projectIndex: data.projectIndex, entryIndex: data.entryIndex });
    }
  }
  for (const [intent, vectors] of Object.entries(intentVectors)) {
    for (const vec of vectors) {
      consider(cosineSimilarity(inputData, vec), intent, null);
    }
  }
}

/**
 * Best-scoring project.action.* vector for ONE project index — the embedding scan behind
 * bestProjectCommandEntry (matcher.js stage 1b's config-entry check). Returns
 * { entryIndex, vectorIndex, score } or null.
 */
export function bestProjectActionVector(inputData, projectIntentVectors, projectIndex) {
  let best = null;
  for (const [intentName, data] of Object.entries(projectIntentVectors)) {
    if (!intentName.startsWith('project.action.')) continue;
    if (data.projectIndex !== projectIndex) continue;
    for (let i = 0; i < data.vectors.length; i++) {
      const sim = cosineSimilarity(inputData, data.vectors[i]);
      if (!best || sim > best.score) {
        best = { entryIndex: data.entryIndex, vectorIndex: i, score: sim };
      }
    }
  }
  return best;
}

/** Per-intent mean vectors (for findIntentCollisions). Skips intents with no vectors. */
export function averageIntentVectors(intentVectors) {
  const avgVectors = {};
  for (const [intent, vectors] of Object.entries(intentVectors)) {
    if (vectors.length === 0) continue;
    const n = vectors[0].length;
    const avg = new Float64Array(n);
    for (const vec of vectors) {
      for (let i = 0; i < n; i++) avg[i] += vec[i];
    }
    for (let i = 0; i < n; i++) avg[i] /= vectors.length;
    avgVectors[intent] = avg;
  }
  return avgVectors;
}
