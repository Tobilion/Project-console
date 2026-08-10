// Semantic redundancy check for .console/memory.md (Phase 1, Part 1.3 — memory
// deduplication). The string-normalized dedupe in memoryStore.js only catches near-identical
// re-saves ("prefers dark mode" vs "prefers dark mode (wants zinc theme)" slips through);
// this adds an embedding-level comparison against existing entries and lets the caller
// reject redundant writes. The embedding extractor is SHARED with semanticMatcher (one
// model instance for the whole process); it is null until the server's startup
// initialize() finishes, in which case the caller simply falls back to string dedupe —
// this check is an enhancement, never a hard requirement.
import { cosineSimilarity } from './intentVectorScan.js';

/** Cosine at or above which an entry is considered "already remembered". */
export const REDUNDANT_COSINE_THRESHOLD = 0.92;
/** Embedding comparisons are O(lines); cap so a large memory file can't stall a save. */
export const MAX_LINES_TO_SCORE = 50;

let extractorModulePromise = null;

async function getExtractor() {
  // Dynamic import: semanticMatcher pulls in the whole matcher graph, which must not be
  // loaded at module scope from the memoryStore import chain (cycle risk). The promise is
  // cached, but a null extractor (model not yet initialized) is re-checked on every call
  // so the check starts working the moment the model is ready.
  if (!extractorModulePromise) {
    extractorModulePromise = import('./semanticMatcher.js').catch(() => null);
  }
  const mod = await extractorModulePromise;
  return mod?.semanticMatcher?.extractor || null;
}

/**
 * True when `candidate` is semantically redundant with any of `existingLines` (already
 * cleaned: no "- " bullet prefix, no trailing date). Returns false on ANY failure or when
 * the embedder is unavailable — the caller's string dedupe remains the baseline.
 */
export async function isSemanticallyRedundant(existingLines, candidate) {
  const lines = (existingLines || []).filter((l) => typeof l === 'string' && l.trim());
  if (lines.length === 0 || lines.length > MAX_LINES_TO_SCORE) return false;
  const extractor = await getExtractor();
  if (!extractor) return false;
  try {
    const candidateVec = (await extractor(candidate, { pooling: 'mean', normalize: true })).data;
    for (const line of lines) {
      const lineVec = (await extractor(line, { pooling: 'mean', normalize: true })).data;
      if (cosineSimilarity(candidateVec, lineVec) >= REDUNDANT_COSINE_THRESHOLD) return true;
    }
  } catch {
    return false;
  }
  return false;
}
