// Query orchestration for the semantic code index (Phase 7, 2026-08-11). The handler-facing
// surface: embed the query, search the persisted store, and report one of three statuses —
// 'unavailable' (no embedding model), 'indexing' (a build task is queued/running), or 'ready'
// with file:line citations. Deliberately retrieval-only: the answer is a list of real code
// locations, never generated prose.
import { semanticMatcher } from '../semanticMatcher.js';
import { hasActiveTask } from '../taskQueue.js';
import { buildProjectIndex, indexNeedsFullBuild } from './codeIndexBuilder.js';
import * as store from './codeIndexStore.js';
import { TOP_K_QUERY, MAX_RESULT_SNIPPET_CHARS } from './codeIndexData.js';

/** Raw search over the loaded store — no status gates. The enqueued post-build task calls this
 *  directly (searchProjectCode would report 'indexing' forever from inside its own task). */
export async function performSearch(project, query) {
  const vector = await semanticMatcher.extractor(query, { pooling: 'mean', normalize: true });
  const hits = await store.searchChunks(project.id, project.path, vector.data, TOP_K_QUERY);
  return hits.map((hit) => ({
    filePath: hit.file,
    startLine: hit.start,
    endLine: hit.end,
    score: hit.sim,
    snippet: hit.text.length > MAX_RESULT_SNIPPET_CHARS
      ? hit.text.slice(0, MAX_RESULT_SNIPPET_CHARS) + '...'
      : hit.text,
  }));
}

/**
 * Searches the project's persisted code index. Never blocks a WS turn for a build: a missing
 * or stale store returns { status: 'indexing' } and the caller enqueues the build, posting the
 * result out of band when done (same shape as project.diagnostics.type_check).
 */
export async function searchProjectCode(project, query) {
  if (!semanticMatcher.ready || !semanticMatcher.extractor) {
    return { status: 'unavailable', results: [] };
  }
  if (hasActiveTask(project.id)) {
    return { status: 'indexing', results: [] };
  }
  if (await indexNeedsFullBuild(project)) {
    return { status: 'indexing', results: [] };
  }
  return { status: 'ready', results: await performSearch(project, query) };
}

// Exported for the check-indexer unit harness — lets the fixture build/update one file without
// spinning up a real project scan.
export const _testHooks = { buildProjectIndex };
