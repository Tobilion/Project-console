// Phase 15 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Notifications panel —
// read-only watch-rule + channel listing. Rule mutations (add/remove, event toggles) go
// through the normal WS admin-command path so the terminal stays the single source of truth.
import { getWatchRules } from '../watchRules.js';
import { getRules, getWebhooks } from '../notify/notifyStore.js';
import { testWebhookUrl } from '../notify/notifyChannels.js';
import { asyncHandler } from '../asyncHandler.js';

// Webhook URLs are bearer secrets (notifications.json is gitignored for exactly that reason),
// and this GET is unauthenticated — in LAN mode (HOST=0.0.0.0) any caller could read them.
// The panel only displays the count, and webhook removal happens via the WS admin command
// (`webhook remove <n>`) which works on the index, so the response only needs a masked preview.
function maskWebhookUrl(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname + u.search;
    const shown = tail.length > 6 ? tail.slice(-6) : tail;
    return `${u.protocol}//${u.host}/…${shown}`;
  } catch {
    return '…';
  }
}

export function registerNotificationsRoutes(app) {
  app.get('/api/notifications', (req, res) => {
    res.json({
      rules: getWatchRules(),
      events: getRules().events,
      desktop: getRules().desktop,
      webhooks: getWebhooks().map(maskWebhookUrl),
    });
  });

  // Round-6 audit (2026-08-24): Postman-style webhook tester — POSTs one test payload to a
  // URL the user typed in the Notifications panel and returns status/time/size for the
  // response panel. The URL goes through the same SSRF guard + redirect-manual fetch as a
  // real webhook send, so testing can never reach an address a real send couldn't.
  app.post('/api/notifications/test-webhook', asyncHandler(async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string' || url.trim() === '') {
      return res.status(400).json({ success: false, error: 'A webhook URL is required.' });
    }
    const result = await testWebhookUrl(url.trim());
    res.json({ success: true, ...result });
  }));
}
