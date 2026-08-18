// Cross-project semantic memory search — infrastructure expansion (2026-08-10). Every other
// piece of memory in this app (memory.md, project usage patterns, chat sessions) is scoped to
// one project; there was no way to ask "which project did I set up X in" across the whole
// scanned Projects/ folder. This searches every project's .console/memory.md at once using the
// same embedding model semanticMatcher/memoryDedupe already load — no new model, no new index
// persisted to disk, just a fan-out query at ask time.
import { readMemory } from './memoryStore.js';
import { cosineSimilarity } from './intentVectorScan.js';

// Bounds keep a single search bounded regardless of how many projects/entries exist: memory.md
// itself caps at 200 entries per project (memoryStore.js's MAX_ENTRIES), so MAX_TOTAL_LINES is
// generous headroom for a handful of projects with substantial memory, not a realistic ceiling
// for a single-user local install. Per-project is deliberately small (audit 2026-08-17): each
// line costs one model embed on the WS turn, and 20 lines/project across many projects already
// covers "which project did I set up X in" without ever serializing hundreds of embeds.
const MAX_LINES_PER_PROJECT = 20;
const MAX_TOTAL_LINES = 400;
export const RESULT_LIMIT = 8;

let extractorModulePromise = null;

async function getExtractor() {
  // Same lazy dynamic-import pattern as memoryDedupe.js — must not pull in the whole matcher
  // graph at module scope (cycle risk via crossProjectMemory <- builtinContextRuntime <-
  // builtinIntents <- ... <- semanticMatcher).
  if (!extractorModulePromise) {
    extractorModulePromise = import('./semanticMatcher.js').catch(() => null);
  }
  const mod = await extractorModulePromise;
  return mod?.semanticMatcher?.extractor || null;
}

function stripEntry(line) {
  return line.replace(/^-\s*/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').trim();
}

/**
 * Searches every project's memory.md for lines semantically close to `query`. Returns an array
 * of { projectId, projectName, line, score } sorted best-first and capped at RESULT_LIMIT, or
 * null if the embedding model isn't loaded yet (caller should tell the user to try again in a
 * moment rather than silently reporting zero results).
 */
export async function searchAllProjectMemory(projects, query) {
  const extractor = await getExtractor();
  if (!extractor) return null;
  const queryVec = (await extractor(query, { pooling: 'mean', normalize: true })).data;

  const scored = [];
  let totalScored = 0;
  for (const project of projects) {
    if (totalScored >= MAX_TOTAL_LINES) break;
    let content;
    try {
      content = await readMemory(project.path);
    } catch {
      continue;
    }
    if (!content) continue;
    // Most recently saved facts are most likely to be what "which project did I..." is asking
    // about — take the tail (readMemory returns oldest-first, same order as the file) when a
    // project's memory exceeds the per-project cap, rather than truncating recent entries off.
    const lines = content.split('\n').map(stripEntry).filter(Boolean).slice(-MAX_LINES_PER_PROJECT);
    for (const line of lines) {
      if (totalScored >= MAX_TOTAL_LINES) break;
      totalScored++;
      try {
        const lineVec = (await extractor(line, { pooling: 'mean', normalize: true })).data;
        scored.push({ projectId: project.id, projectName: project.name, line, score: cosineSimilarity(queryVec, lineVec) });
      } catch {
        // Skip a line that fails to embed rather than aborting the whole search.
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, RESULT_LIMIT);
}
