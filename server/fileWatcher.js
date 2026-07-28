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

  watcher.on('change', (relativePath) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const folderName = path.dirname(relativePath);
      const projectPath = path.join(projectsDir, folderName);
      const updated = await scanSingleProject(folderName, projectPath);
      if (updated) {
        onProjectChanged(updated);
      }
    }, 500);
  });

  watcher.on('add', (relativePath) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const folderName = path.dirname(relativePath);
      const projectPath = path.join(projectsDir, folderName);
      const updated = await scanSingleProject(folderName, projectPath);
      if (updated) {
        onProjectChanged(updated, true);
      }
    }, 500);
  });

  watcher.on('unlink', (relativePath) => {
    const folderName = path.dirname(relativePath);
    onProjectChanged(null, false, folderName);
  });

  return watcher;
}
