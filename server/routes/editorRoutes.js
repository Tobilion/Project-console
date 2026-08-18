// Phase T2 (2026-08-14): REST surface for the editor/IDE registry (editorsStore.js) —
// GET returns the current list + extension defaults; POST replaces either (settings UI
// saves the whole state). Gitignored data/editors.json behind the store, never the
// git-tracked user-profile.json. Read-only consumers (open_with dispatch) go through
// editorsStore directly, not this route.
import { getEditorsState, setEditors } from '../editorsStore.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerEditorRoutes(app) {
  app.get('/api/editors', (req, res) => {
    res.json(getEditorsState());
  });

  app.post('/api/editors', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const updated = setEditors(body);
    res.json(updated);
  }));
}
