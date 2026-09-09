import path from 'path';
import fs from 'fs';
import { watchProjectConfigs } from '../fileWatcher.js';
import { state, projectsMutex } from '../state.js';
import { syncProjectWatchers } from '../codeIndex/codeIndexBuilder.js';
import { invalidateScanCacheForPath } from '../scanCache.js';
import { broadcast } from '../wsServer.js';
import { nlpEngine } from '../nlpEngine.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { log } from '../logger.js';

/**
 * Start watching `console.config.json` inside the scan root for live project-list updates.
 * Single-file changes trigger a targeted rescan (one project replaced/added/removed) and
 * retrain the NLP classifier + refresh project intents, then broadcast the updated list.
 */
export function startConfigWatcher(dirToScan) {
  try {
    if (!fs.existsSync(dirToScan)) return;
    watchProjectConfigs(dirToScan, async (updated, isNew, removedName) => {
      // Drop any cached whole-scan that contains the changed project, so the cache never
      // serves the pre-change array while the watcher's own single-project rescan already
      // refreshed the live caches (belt-and-braces — the mtime signature in scanCache.js
      // would also catch the edit on the next read).
      if (removedName) invalidateScanCacheForPath(path.join(dirToScan, removedName));
      else if (updated) invalidateScanCacheForPath(updated.path);
      await projectsMutex.runExclusive(async () => {
        if (removedName) {
          state.activeProjectsCache = state.activeProjectsCache.filter((p) => p.folderName !== removedName);
        } else if (isNew) {
          const existing = state.activeProjectsCache.findIndex((p) => p.id === updated.id);
          if (existing >= 0) state.activeProjectsCache[existing] = updated;
          else state.activeProjectsCache.push(updated);
        } else {
          const idx = state.activeProjectsCache.findIndex((p) => p.id === updated.id);
          if (idx >= 0) state.activeProjectsCache[idx] = updated;
        }
      });
      // Close code-index watchers for projects the config watcher just filtered out.
      syncProjectWatchers(state.activeProjectsCache);
      nlpEngine.train(state.activeProjectsCache).catch(() => {});
      semanticMatcher.clearProjectIntents().catch(() => {});
      semanticMatcher.addProjectIntents(state.activeProjectsCache).catch((err) =>
        log.warn('Project-intent refresh failed after config change:', err?.message || err),
      );
      broadcast({ type: 'projects_updated', data: state.activeProjectsCache });
    });
    log.info('File watcher active for console.config.json changes.');
  } catch (err) {
    log.error('File watcher failed to start:', err.message);
  }
}
