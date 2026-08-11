import { getToolPanels } from '../toolPanelRegistry.js';

// Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): REST surface for the interactive-tool registry.
// The web client fetches the card grid from here so per-tool availability can be reported
// server-side later without a client restructure. Read-only, no auth surface change.
export function registerToolPanelRoutes(app) {
  app.get('/api/tool-panels', (req, res) => {
    res.json({ panels: getToolPanels() });
  });
}