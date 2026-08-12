// Phase 10 (UPGRADE-ROADMAP.md, 2026-08-12): serve the command catalog (consoleCommandDocs.js)
// as JSON for the web Command Reference tab. Read of existing data — the catalog stays the
// single source; the frontend never duplicates it.
import { COMMAND_DOCS } from '../consoleCommandDocs.js';

export function registerCommandDocsRoutes(app) {
  app.get('/api/command-docs', (req, res) => {
    res.json({ commands: COMMAND_DOCS });
  });
}
