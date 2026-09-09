import { discoverProjects } from '../projectScanner.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { nlpEngine } from '../nlpEngine.js';
import { state, projectsMutex, dedupeProjectIds } from '../state.js';
import { setCachedScan } from '../scanCache.js';
import { readProfile } from '../routes/profileRoutes.js';
import { log } from '../logger.js';

/**
 * Phase 6 (2026-08-17): the project scan and the embedding-model load are the two slowest
 * boot steps and touch disjoint state (the scan writes the project cache under the projects
 * mutex; initialize() builds intent vectors + the Fuse index from INTENTS/learned intents).
 * Running them serially made every cold boot pay both back to back; run them concurrently.
 *
 * After both complete, NLP classifier training and the project-intent embedding pass run
 * in parallel — both need the scan result above, so they join after the Promise.all.
 */
export async function discoverAndInitializeProjects(dirToScan, emitBootState) {
  emitBootState('scanning');
  await Promise.all([
    projectsMutex.runExclusive(async () => {
      state.activeProjectsCache = dedupeProjectIds(
        await discoverProjects(dirToScan, { includeAll: readProfile().scanAllFolders }),
      );
    }),
    semanticMatcher
      .initialize()
      .then(() => emitBootState('matcher-init'))
      .catch((err) => log.error('SemanticMatcher init failed:', err.message)),
  ]);
  // Prime the whole-scan cache with the boot scan so the first GET /api/projects (web
  // load) hits instead of re-walking the container (scanCache.js, Phase 6).
  setCachedScan(dirToScan, readProfile().scanAllFolders, state.activeProjectsCache);

  emitBootState('nlp-training');
  await Promise.all([
    nlpEngine.train(state.activeProjectsCache),
    semanticMatcher.addProjectIntents(state.activeProjectsCache).catch((err) =>
      log.warn('Project-intent injection failed at boot (matching/AI context degraded):', err?.message || err),
    ),
  ]);
  log.info(`NLP training complete. ${state.activeProjectsCache.length} project(s) loaded.`);
}
