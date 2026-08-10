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

// Phase 1: per-project watcher for the scheduler's file-save / git-commit triggers. The spec
// says to hook into the existing fileWatcher rather than build a second watching mechanism,
// so this lives in the same module — but watches a whole project tree instead of the config
// glob. node_modules, .console and the bulk of .git are ignored to keep the event rate
// sane; git-commit detection watches the ref files a commit actually rewrites
// (.git/refs/heads/*, .git/HEAD, .git/packed-refs — a commit moves the branch ref, so its
// mtime/path event is the commit signal). 1s debounce coalesces editor save bursts.
export function watchProjectChanges(project, onFsEvent) {
  const watcher = chokidar.watch(project.path, {
    ignoreInitial: true,
    ignored: (p) => {
      if (typeof p !== 'string') return false;
      const n = p.split('\\').join('/');
      if (n.includes('/node_modules/')) return true;
      if (n.includes('/.console/')) return true;
      if (!n.includes('/.git/')) return false;
      return !/(\/\.git\/(?:refs\/heads\/[^/]+$|HEAD$|packed-refs$))/.test(n);
    },
  });
  let debounceTimer = null;
  const fire = (eventType) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        onFsEvent(eventType);
      } catch (err) {
        console.error(`[fileWatcher] scheduler event failed for ${project.id}:`, err.message);
      }
    }, 1000);
  };
  watcher.on('add', () => fire('file-save'));
  watcher.on('change', (p) => {
    const n = p.split('\\').join('/');
    // A .git ref change means a commit (or branch op) happened — distinct signal.
    fire(n.includes('/.git/') ? 'git-commit' : 'file-save');
  });
  watcher.on('unlink', () => fire('file-save'));
  watcher.on('error', (err) => {
    console.error(`[fileWatcher] project watcher error (${project.id}):`, err.message);
  });
  return watcher;
}