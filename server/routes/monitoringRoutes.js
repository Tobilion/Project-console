import { metrics } from '../metrics.js';
import { runningProcesses } from '../executor.js';
import { state } from '../state.js';

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
}
