// Phase 17 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Pack Marketplace panel —
// read-only registry index + config. Installing goes through the WS admin-command path
// ("install pack <name> from registry") so preview/confirm/journaling stay in the terminal.
import { getRegistryUrl, fetchRegistryIndex } from '../packRegistry.js';

export function registerMarketplaceRoutes(app) {
  app.get('/api/registry/config', (req, res) => {
    res.json({ url: getRegistryUrl() });
  });

  app.get('/api/registry/packs', async (req, res) => {
    const result = await fetchRegistryIndex();
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ packs: result.packs });
  });
}
