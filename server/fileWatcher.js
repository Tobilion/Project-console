import chokidar from 'chokidar';
import path from 'path';
import { scanSingleProject } from './projectScanner.js';

export function watchProjectConfigs(projectsDir, onProjectChanged) {
  const watcher = chokidar.watch('**/console.config.json', {
    cwd: projectsDir,
    ignoreInitial: true,
    depth: 3
  });

  let debounceTimer = null;

  // A config change/add/reload triggers a rescans with a 500ms debounce. Each callback body is
  // try/caught: a scanSingleProject rejection (unreadable dir, config edge case) used to surface
  // as an unhandled rejection from the timer callback (audit 2026-08-06, Phase 2).
  watcher.on('change', (relativePath) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const folderName = path.dirname(relativePath);
        const projectPath = path.join(projectsDir, folderName);
        const updated = await scanSingleProject(folderName, projectPath);
        if (updated) {
          onProjectChanged(updated);
        }
      } catch (err) {
        console.error(`[fileWatcher] scan failed for ${relativePath}:`, err.message);
      }
    }, 500);
  });

  watcher.on('add', (relativePath) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const folderName = path.dirname(relativePath);
        const projectPath = path.join(projectsDir, folderName);
        const updated = await scanSingleProject(folderName, projectPath);
        if (updated) {
          onProjectChanged(updated, true);
        }
      } catch (err) {
        console.error(`[fileWatcher] scan failed for ${relativePath}:`, err.message);
      }
    }, 500);
  });

  watcher.on('unlink', (relativePath) => {
    // A change/add debounce for the same config may still be pending — clear it so a deleted
    // project can't be re-added by the stale timer firing after the removal already ran
    // (audit 2026-08-06, Phase 2).
    clearTimeout(debounceTimer);
    const folderName = path.dirname(relativePath);
    onProjectChanged(null, false, folderName);
  });

  // chokidar emits 'error' (e.g. EPERM on a locked/unreadable tree) on the watcher emitter —
  // with no listener that surfaced as an uncaughtException (audit 2026-08-06, Phase 2).
  watcher.on('error', (err) => {
    console.error('[fileWatcher] watcher error:', err.message);
  });

  return watcher;
}
