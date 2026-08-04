// Platform detection helper — the single source of truth for `isWindows` used by command-guess
// logic. Factored out of commandGuesser.js (Phase 2 modularization) so every platform-branching
// guess resolves against one shared constant instead of re-defining it locally.

export const isWindows = process.platform === 'win32';
