// Phase 19 (UPGRADE-ROADMAP.md, 2026-08-12): connected-users surface — attribution labels
// from the live connection registry. Read-only; the Dashboard renders "who's connected" when
// more than one user is present (single-user stays invisible — zero behavior change).
import { connectionRegistry } from '../state.js';

export function registerConnectedUsersRoutes(app) {
  app.get('/api/connected-users', (req, res) => {
    const users = [];
    const seen = new Set();
    for (const [, ctx] of connectionRegistry) {
      const name = ctx.displayName || 'local';
      if (seen.has(name)) continue;
      seen.add(name);
      users.push({
        name,
        projectId: ctx.activeProjectId || null,
      });
    }
    // HOST=0.0.0.0 is the explicit LAN opt-in (see CLAUDE.md's safety model) — the client
    // only prompts for a display name when this is true.
    res.json({ users, lanBound: process.env.HOST === '0.0.0.0' });
  });
}
