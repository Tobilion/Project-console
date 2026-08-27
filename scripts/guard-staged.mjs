// Staged-file -> battery mapper for the pre-commit hook (2026-08-26). lint-staged invokes
// this with the staged file paths; it decides which check-* harnesses (and which test files)
// a change touches and runs only those. The full harness set stays CI's job — this gate is
// for catching regressions BEFORE they're committed, in seconds, not a full re-run.
//
// Mapping rules (keep in sync with the modules they cover):
//   wsHandlers/**            -> check-handlers  (dispatch rows for every handler)
//   matcher*/semanticMatcher*/intents/**/preSemanticOverrides.js/intentRegistry.js/
//   intentTrust.js           -> check-matcher (+ check-intents for intents/**, which own the
//                               phrase corpus the matcher scores against)
//   tool*/executor*/paramCommand/commandRisk/dangerousPatterns/urlSafety + their tests ->
//                               check-tools (+ the safety fuzz suite when server/test/**
//                               changed)
//   consoleCommandDocs.js/commandCatalog.js/README.md/features.md -> check-docs
//                                (catalog <-> README table sync)
//   cli-client*/cliRenderer*/cliOptions*/checkWsMessageCases* -> check-ws-cases (CLI parity)
//   codeIndex/**/codebase*   -> check-indexer
//   server/test/**           -> the safety + matcher test suites (npm test)
// Anything else (frontend src/, scripts/, desktop/) -> no battery (tsc in the hook already
// covers types; CI runs the full set).

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// npm.cmd via shell:false is EINVAL on this Node/Windows combo (live-probed 2026-08-26 — the
// guard's harness runs 'failed' instantly with no output). process.execPath + the npm CLI
// avoids the shell entirely and is deterministic across platforms. npm ships with Node (not
// per-project): resolve next to process.execPath first, then the npm_execpath npm itself
// sets when it runs a lifecycle script (the husky hook path).
const npmCli =
  (() => {
    const candidates = [
      process.env.npm_execpath && path.resolve(process.env.npm_execpath),
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    return candidates.find((c) => c && fs.existsSync(c));
  })();
if (!npmCli) {
  console.error('[guard-staged] Could not locate npm-cli.js — cannot run batteries.');
  process.exit(1);
}

const staged = process.argv.slice(2);
if (staged.length === 0) {
  process.exit(0);
}

const n = (s) => s.replace(/\\/g, '/');

function wanted(batteries) {
  for (const file of staged) {
    const f = n(file);
    if (batteries.some((b) => b(f))) return true;
  }
  return false;
}

const has = {
  handlers: (f) => f.startsWith('server/wsHandlers/'),
  matcher: (f) =>
    f.includes('/matcher') || f.includes('/semanticMatcher') ||
    f.startsWith('server/intents/') || f.endsWith('preSemanticOverrides.js') ||
    f.endsWith('intentRegistry.js') || f.endsWith('intentTrust.js') ||
    f.includes('commandCatalog.js') || f.includes('consoleCommandDocs.js') ||
    f.includes('commandGuesser.js') || f.includes('contextResolver.js') || f.includes('contextInjector.js'),
  intents: (f) => f.startsWith('server/intents/') || f.includes('intentsData.js') || f.includes('localeIntents.js'),
  tools: (f) =>
    f.includes('/tool') || f.includes('/executor') || f.endsWith('paramCommand.ts') ||
    f.endsWith('paramCommand.js') || f.endsWith('commandRisk.ts') || f.endsWith('commandRisk.js') ||
    f.endsWith('dangerousPatterns.ts') || f.endsWith('dangerousPatterns.js') ||
    f.endsWith('urlSafety.ts') || f.endsWith('urlSafety.js') ||
    f.includes('typedCommand.js') || f.includes('pluginTools.js') || f.includes('toolDefs.js'),
  docs: (f) =>
    f.includes('consoleCommandDocs.js') || f.includes('commandCatalog.js') ||
    f === 'README.md' || f === 'features.md',
  wsCases: (f) =>
    f.includes('cli-client.js') || f.includes('cliRenderer') || f.includes('cliOptions.js') ||
    f.includes('checkWsMessageCases'),
  indexer: (f) => f.startsWith('server/codeIndex/') || f.includes('codebaseIndexer') || f.includes('codebaseParser') || f.includes('codebaseDetect'),
  tests: (f) => f.startsWith('server/test/'),
};

const toRun = [];
if (wanted([has.handlers])) toRun.push('check-handlers');
if (wanted([has.matcher])) toRun.push('check-matcher');
if (wanted([has.intents])) toRun.push('check-intents');
if (wanted([has.tools])) toRun.push('check-tools');
if (wanted([has.docs])) toRun.push('check-docs');
if (wanted([has.wsCases])) toRun.push('check-ws-cases');
if (wanted([has.indexer])) toRun.push('check-indexer');
if (wanted([has.tests])) toRun.push('test');

if (toRun.length === 0) {
  console.log('[guard-staged] No server batteries needed for the staged files.');
  process.exit(0);
}

console.log(`[guard-staged] Running: ${toRun.join(', ')}`);
for (const script of toRun) {
  const res = spawnSync(process.execPath, [npmCli, 'run', script], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (res.status !== 0) {
    console.error(`\n[guard-staged] ${script} FAILED — fix before committing.\n`);
    process.exit(res.status ?? 1);
  }
}
console.log('[guard-staged] All staged batteries passed.');