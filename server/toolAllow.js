import path from 'path';

// Command allowlist for the tool layer (Phase 9 split, 2026-08-04 — extracted from tools.js;
// re-exported from tools.js so external importers are untouched).

// Allowlist for executeCommand — only these executables may be run through the console.
// Prevents arbitrary command execution even if a path-escaped or unapproved command
// somehow reaches the execution path.
export const ALLOWED_COMMANDS = [
  'npm', 'node', 'git', 'python', 'pip', 'python3', 'pip3',
  'npx', 'vite', 'tsc', 'tsx', 'eslint', 'prettier', 'jest', 'vitest',
  // Broadened framework coverage (2026-08-11, reported directly — an Angular project's `ng
  // serve` was rejected on a friend's machine even after the PATH-resolution typed-command fix,
  // because `ng` wasn't in this allowlist either — see the isCommandAllowed(line) fallback in
  // typedCommand.js's extractCommandLine, which single-token and env-prefixed commands still
  // depend on). Covers the CLIs of the frameworks users actually run through this console day to
  // day: Angular, Flutter/Dart, Rust, Go, JVM (Maven/Gradle wrapper-less form), .NET, Ruby, PHP,
  // and the other JS package managers beyond npm.
  'ng', 'flutter', 'dart', 'yarn', 'pnpm', 'bun', 'deno',
  'cargo', 'go', 'mvn', 'gradle', 'dotnet', 'ruby', 'bundle', 'php', 'composer',
];

export function isCommandAllowed(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  let rest = cmd.trim();
  // Tolerate one leading env-var-assignment prefix (`PORT=3001 npm run dev` on POSIX, or
  // `set PORT=3001&& npm run dev` on Windows) before checking the actual executable — added for
  // the port-conflict retry commands executor.js's buildPortRetryCommand() constructs, which
  // would otherwise get rejected because "PORT=3001"/"set" isn't itself an allowed executable.
  // Only strips the prefix for the purposes of *this check*; the full original string (env
  // assignment included) is still what actually gets executed.
  const winEnvPrefix = /^set\s+[A-Za-z_][A-Za-z0-9_]*=\S*&&\s*/i;
  const posixEnvPrefix = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
  if (winEnvPrefix.test(rest)) {
    rest = rest.replace(winEnvPrefix, '');
  } else if (posixEnvPrefix.test(rest)) {
    rest = rest.replace(posixEnvPrefix, '');
  }
  const exe = (rest.split(/\s+/)[0] || '').toLowerCase();
  // Normalize Windows backslashes, strip extension, compare basename only
  const normalized = exe.replace(/\\/g, '/');
  const base = path.basename(normalized).replace(/\.(exe|bat|cmd|ps1)$/i, '');
  return ALLOWED_COMMANDS.includes(base);
}
