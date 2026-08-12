// Phase 18: minimal preload — the console is a normal browser app; the shell only needs
// process info for diagnostics. No privileged APIs are exposed to the renderer (the app
// never runs inside the shell's webview anyway — it opens in the default browser).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('consoleShell', {
  isPackaged: process.env.NODE_ENV === 'production',
});
