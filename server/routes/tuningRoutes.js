import { getTuningState, setTuning, resetTuning } from '../tuningStore.js';
import { semanticMatcher } from '../semanticMatcher.js';

// Phase 8 (2026-08-11): REST surface for the tuning-constant overrides (see tuningStore.js).
// GET returns defaults + active overrides so the settings UI can render both; POST applies a
// partial set (unknown keys / out-of-bounds values are dropped server-side, never echoed back);
// DELETE resets to factory defaults. After an apply/reset the Fuse index is rebuilt in place
// when the matcher is ready, so threshold knobs take effect for the NEXT match — no restart
// needed (the embedding model itself is unaffected by these knobs).
export function registerTuningRoutes(app) {
  app.get('/api/tuning', (req, res) => {
    res.json(getTuningState());
  });

  app.post('/api/tuning', (req, res) => {
    const applied = setTuning(req.body?.overrides);
    if (semanticMatcher.refreshFuseIndex()) {
      console.log('[tuning] Fuse index rebuilt with new thresholds');
    }
    res.json({ applied, ...getTuningState() });
  });

  app.delete('/api/tuning', (req, res) => {
    resetTuning();
    if (semanticMatcher.refreshFuseIndex()) {
      console.log('[tuning] Fuse index rebuilt with defaults');
    }
    res.json(getTuningState());
  });
}