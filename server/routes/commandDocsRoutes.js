// Phase 10 (UPGRADE-ROADMAP.md, 2026-08-12): serve the command catalog as JSON for the web
// Command Reference tab + the Ctrl+K deck. `commands` is the hand-curated COMMAND_DOCS;
// `intents` (2026-08-13) is the auto-generated full-intent coverage from commandCatalog.js.
// Read of existing data — the catalogs stay the single source; the frontend never duplicates.
import { buildCommandCatalog } from '../commandCatalog.js';

export function registerCommandDocsRoutes(app) {
  app.get('/api/command-docs', (req, res) => {
    // `commands` stays the curated layer's key for backward compatibility with the existing
    // consumers; `intents` is the additive full-coverage layer.
    const { curated, intents } = buildCommandCatalog();
    res.json({ commands: curated, intents });
  });
}
