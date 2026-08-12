// Phase 15 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Notifications panel —
// read-only watch-rule + channel listing. Rule mutations (add/remove, event toggles) go
// through the normal WS admin-command path so the terminal stays the single source of truth.
import { getWatchRules } from '../watchRules.js';
import { getRules, getWebhooks } from '../notify/notifyStore.js';

export function registerNotificationsRoutes(app) {
  app.get('/api/notifications', (req, res) => {
    res.json({
      rules: getWatchRules(),
      events: getRules().events,
      desktop: getRules().desktop,
      webhooks: getWebhooks(),
    });
  });
}
