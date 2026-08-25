// afterPack hook (electron-builder, 2026-08-24).
//
// electron-builder excludes node_modules from extraResources copies by default (documented
// behavior — the stage's production dependency tree never reached resources/). This hook
// copies desktop/stage/node_modules into appOutDir/resources BEFORE the NSIS target
// compresses the app dir, so the packaged shell can spawn the console server (whose source
// imports express/ws/vite/... from resources/node_modules). CommonJS on purpose: builder
// hooks are loaded via require, not the ESM loader.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const src = path.join(packager.projectDir, 'stage', 'node_modules');
  const dest = path.join(appOutDir, 'resources', 'node_modules');
  if (!fs.existsSync(src)) {
    throw new Error(`[after-pack] staged node_modules missing at ${src} — run "npm run stage" first`);
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[after-pack] copied production node_modules (${src}) -> ${dest}`);
};