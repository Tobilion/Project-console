import fs from 'fs';
import path from 'path';
import { EXPORT_DIR } from '../workspaceTransfer.js';

// Phase 6 (2026-08-11): download endpoint for workspace export bundles. The export admin
// command writes the bundle into data/workspace-exports/ and answers with both the absolute
// path and a markdown download link pointing here. Local file only — the same offline-first
// rule as the export itself, no upload/cloud anywhere.
const FILE_RE = /^workspace-\d{8}-\d{6}\.json$/;

export function registerWorkspaceRoutes(app) {
  // GET /api/workspace/export?file=<name> — serves one specific bundle; without ?file,
  // serves the most recent one. Basename validation keeps the lookup inside EXPORT_DIR.
  app.get('/api/workspace/export', (req, res) => {
    const requested = req.query?.file;
    let fileName = null;
    if (typeof requested === 'string' && FILE_RE.test(requested)) {
      fileName = requested;
    } else {
      try {
        if (fs.existsSync(EXPORT_DIR)) {
          const newest = fs.readdirSync(EXPORT_DIR)
            .filter((f) => FILE_RE.test(f))
            .map((f) => ({ f, t: fs.statSync(path.join(EXPORT_DIR, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)[0];
          fileName = newest?.f || null;
        }
      } catch {
        fileName = null;
      }
    }
    if (!fileName) {
      res.status(404).json({ error: 'No workspace export available yet — run `export workspace` in chat first.' });
      return;
    }
    res.download(path.join(EXPORT_DIR, fileName), fileName);
  });
}
