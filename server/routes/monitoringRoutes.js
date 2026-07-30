import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { metrics } from '../metrics.js';
import { runningProcesses } from '../executor.js';
import { state } from '../state.js';

/** Runs a git command in the given directory with a timeout, returning { stdout, stderr }. */
function runGit(cwd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

export function registerMonitoringRoutes(app) {
  app.get('/api/metrics', (req, res) => {
    res.json(metrics.snapshot());
  });

  app.post('/api/metrics/reset', (req, res) => {
    metrics.reset();
    res.json({ success: true });
  });

  // Returns every project that currently has a running process tracked by the
  // executor — includes the command that started it, its PID, PID of the tracked
  // child, and any detected dev-server URL.
  app.get('/api/active-servers', (req, res) => {
    const servers = [];
    for (const [projectId, proc] of runningProcesses) {
      servers.push({
        projectId,
        command: proc.command,
        pid: proc.child?.pid || null,
        url: state.lastDevUrls.get(projectId) || null,
      });
    }
    res.json(servers);
  });

  // Per-project dashboard aggregating git status, recent commits, dev URLs, and
  // running processes. Cached for 30s to avoid hammering git on every request.
  let dashboardCache = null;
  let dashboardCacheTime = 0;
  const CACHE_TTL = 30000;

  app.get('/api/dashboard', async (req, res) => {
    const now = Date.now();
    if (dashboardCache && (now - dashboardCacheTime < CACHE_TTL)) {
      return res.json(dashboardCache);
    }

    const results = [];
    for (const project of state.activeProjectsCache) {
      const entry = {
        id: project.id,
        name: project.name,
        path: project.path,
        uncommitted: [],
        recentCommits: [],
        devUrl: state.lastDevUrls.get(project.id) || null,
        runningCommand: null,
      };

      const proc = runningProcesses.get(project.id);
      if (proc) entry.runningCommand = proc.command;

      try {
        const gitDir = path.join(project.path, '.git');
        if (fs.existsSync(gitDir)) {
          const { stdout: statusOut } = await runGit(project.path, ['status', '--short']);
          if (statusOut.trim()) {
            entry.uncommitted = statusOut.trim().split('\n').slice(0, 100);
          }

          const { stdout: logOut } = await runGit(project.path, ['log', '--oneline', '-5']);
          if (logOut.trim()) {
            entry.recentCommits = logOut.trim().split('\n').filter(Boolean);
          }
        }
      } catch {
        // Not a git repo, or git unavailable — entry stays with empty arrays
      }

      results.push(entry);
    }

    dashboardCache = results;
    dashboardCacheTime = now;
    res.json(results);
  });
}
