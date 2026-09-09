import express from 'express';
import path from 'path';
import fs from 'fs';

/**
 * Resolve the static-frontend root for production mode.
 * The esbuild bundle lives at dist/server.js (dirname=dist/) but the built
 * frontend sits at server/ — this checks a few candidate paths and picks
 * whichever actually contains index.html.
 */
export function resolveStaticRoot(__dirname) {
  const candidates = [
    __dirname,
    path.resolve(__dirname, '..', 'server'),
    path.resolve(__dirname, 'server'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) || __dirname;
}

/**
 * Attach Vite's dev middleware to the Express app in dev mode.
 * Must be called before any production static-middleware setup.
 */
export async function setupDevServer(app, httpServer) {
  // vite is a dev-only dependency (never staged into the packaged app's production
  // node_modules — npm ci --omit=dev skips it even when listed in both sections). It is
  // imported dynamically HERE, inside the dev branch, because a static top-level import
  // crashed the packaged server at module load: ERR_MODULE_NOT_FOUND "Cannot find package
  // 'vite'" from resources/server/index.js on the installed app (2026-08-25, P0).
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      // Vite's own file watcher (chokidar) watches the whole project root by default, which
      // includes `data/` — this app's own runtime-written state (conversation index,
      // near-miss logs, telemetry, distillation records). Every session created / message
      // sent / command run rewrites one of those JSON files, and before the HMR websocket fix
      // above, Vite's resulting "full reload" signal silently failed to reach the browser (so
      // this went unnoticed). Now that HMR actually works, without this exclusion *any* of
      // those writes would force a full-page reload — which looked exactly like "clicking New
      // Chat makes the page go white and reload," since creating a session is one of the things
      // that writes to `data/conversations/index.json`. Phase 6: `logs/` (daemon + schedule
      // logs), `*.pid` (server.pid), and `dist/` (the shadowing bundle) are runtime
      // artifacts too — keep this list in sync with vite.config.ts.
      watch: { ignored: ['**/data/**', '**/.cache/**', '**/*.console/**', '**/logs/**', '**/*.pid', '**/dist/**'] },
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

/**
 * Set up production static-file serving with SPA fallback.
 */
export function setupProdStatic(app, __dirname) {
  const distPath = resolveStaticRoot(__dirname);
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/stream')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
