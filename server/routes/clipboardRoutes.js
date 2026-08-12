// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Clipboard panel — read-only
// history + snippets listing. All mutations (copy/save/delete/clear) go through the normal WS
// trigger-command path so the terminal stays the single source of truth.
import { getClipboardHistory } from '../clipboardHistory.js';
import { listSnippets } from '../snippetStore.js';
import { readProfile } from './profileRoutes.js';

export function registerClipboardRoutes(app) {
  app.get('/api/clipboard-history', (req, res) => {
    // Honest: when the opt-in setting is off the buffer is empty/never polled — the panel
    // renders its explanation from /api/profile instead of from this endpoint's emptiness.
    res.json({ history: readProfile().clipboardHistory ? getClipboardHistory() : [] });
  });

  app.get('/api/snippets', (req, res) => {
    res.json({ snippets: listSnippets() });
  });
}
