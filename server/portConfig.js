// Shared port/host constants — single source of truth for every entry point that
// probes or binds the console server's port range. Before this module, BASE_PORT,
// MAX_PORT_ATTEMPTS and HOST were hardcoded independently in 5+ files (server/index.js,
// server/cliOptions.js, desktop/main.cjs, server/doctor.js, scripts/daemon.mjs, bin/cli.js,
// start.bat) and diverged silently: desktop/main.cjs ignored PORT/host env, doctor.js
// hardcoded 'localhost' vs the server's '127.0.0.1', and bin/cli.js literal loops never
// tracked the constant. Extend this file when the range changes; don't add a new literal.

export const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
export const MAX_PORT_ATTEMPTS = 20; // 3000-3019 (widened 2026-08-26)
export const MAX_PORT = BASE_PORT + MAX_PORT_ATTEMPTS - 1;
export const HOST = process.env.HOST || '127.0.0.1';
export const CLI_HOST = process.env.HOST || 'localhost'; // CLI connects via 'localhost' (resolves to 127.0.0.1/::1)
export const OLLAMA_DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

export function* portRange() {
  for (let p = BASE_PORT; p <= MAX_PORT; p++) yield p;
}
