import { metrics } from '../metrics.js';

export function registerMonitoringRoutes(app) {
  app.get('/api/metrics', (req, res) => {
    res.json(metrics.snapshot());
  });

  app.post('/api/metrics/reset', (req, res) => {
    metrics.reset();
    res.json({ success: true });
  });
}
