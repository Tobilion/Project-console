# Desktop build & release (single source of truth for `how do i ...` answers)

This file is the authoritative how-to for the desktop app's build/release pipeline. The
`system.chit_chat.how_do_i` intent renders it when asked "how do i rebuild the desktop app",
"how do i release an update", or similar phrasings (catalog entry in
`server/consoleCommandDocs.js`). Keep THIS file in sync with the real process when the
pipeline changes — the intent answers from here, not from code comments.

## What the pipeline looks like

- `desktop/` is a self-contained Electron project (its own package.json; the root install
  never pulls Electron).
- `desktop/scripts/stage-server.mjs` builds the production server runtime into
  `desktop/stage/` (gitignored): server source, the vite-built frontend inside `server/`
  (production mode serves static files from `__dirname`), an EMPTY `data/` directory (a
  fresh install must start like a new user — no developer data, onboarding wizard on
  first run), and a production-only `node_modules` (`npm ci --omit=dev`).
- The stage also bundles the server entry to `stage/dist/server.js` (esbuild,
  `--packages=external` — see `npm run build` for the identical repo-root command).
  Server leaves are partially TypeScript since 2026-08-26, and the packaged runtime must
  run under plain Node (electron-as-node, no tsx shipped); `main.cjs` prefers
  `dist/server.js` when present, which is exactly this file.
- `electron-builder` packages the stage via `extraResources` into `resources/`; a
  post-pack hook adds the staged `node_modules` (electron-builder excludes them from
  `extraResources` by default). `main.cjs` spawns the server child with
  `ELECTRON_RUN_AS_NODE=1` + `NODE_ENV=production` + `CONSOLE_DESKTOP=1` (the last one
  suppresses the npm-CLI update check — the desktop app has its own update channel).
- Updates use `electron-updater` (GitHub Releases provider, `build.publish` in
  `desktop/package.json`): user-confirmed download + explicit restart-to-install dialogs.

## Rebuild the Windows installer (no release)

```powershell
cd desktop
npm install            # first time only (electron, electron-builder, electron-updater)
npm run dist           # stage + electron-builder --win nsis
# result: desktop\dist\Project Console Setup 1.0.0.exe
```

`npm run dist:mac` / `npm run dist:linux` produce the `.dmg` / `.AppImage` on their own
hosts (mac/linux builds run on CI — see below). The stage is rebuilt on every run, so a
stale stage can never be packaged twice.

## Release an update (Windows NSIS to GitHub Releases)

1. Bump the version in `desktop/package.json` (`version` field — the app's own version,
   independent of the root npm CLI package version).
2. Push to `main` (or trigger manually: Actions → "Desktop Builds" → Run workflow). The
   `publish-windows` job builds and runs `electron-builder --win nsis --publish always`
   with `GH_TOKEN`, which uploads the installer + `latest.yml` to a GitHub Release on
   `Tobilion/Project-console`.
3. Installed apps pick it up automatically: `electron-updater` checks the release feed
   ~30s after launch, prompts "Download & install", then "Restart & install" once the
   download finishes. The tray menu also has "Check for updates".
4. Manual check while developing: run `npm run dist:publish` locally with a `GH_TOKEN`
   environment variable set (same as CI).

## FAQ

- **Does the installer include the CLI?** Yes — `resources\server\cli-client.js` + the staged
  node_modules ship with every install, and a **"Project Console CLI"** Start Menu shortcut
  (added by `desktop/scripts/nsis-cli-shortcut.nsh`) opens a terminal running
  `resources\cli.cmd`, which launches the client with the bundled Electron runtime as plain
  Node (`ELECTRON_RUN_AS_NODE=1`) — full CLI access with zero npm/Node on the user's machine.
  Start the app first (the CLI connects to its server on ports 3000-3019).
- **Why does the installer never show an update?** No release exists yet (or the app's
  version in `desktop/package.json` is not older than the release's). `electron-updater`
  fails silently when offline or when nothing is published.
- **Why did the packaged app crash on launch at 1.0.0?** A static `import ... from 'vite'`
  at the top of `server/index.js` — vite is a devDependency and is NOT shipped in the
  staged `node_modules` (`npm ci --omit=dev` skips it even when listed in both sections).
  Fixed by importing vite dynamically inside the dev-only branch. Never add a static
  import of a devDependency to `server/` — the packaged boot test only catches it with a
  truly clean install.
- **Why is `data/` empty in the package?** Developer data (profile, conversations,
  telemetry, clipboard history) must never ship to users. The server creates everything
  lazily; `setupComplete` defaults to false, so the onboarding wizard shows on first run.