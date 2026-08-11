import fs from 'fs/promises';
import path from 'path';
import { resolveLocalImport } from '../codebaseParsers.js';
import { hasTypeScriptProject, runTypeScriptCheck } from '../verifyHarness.js';
import { getProcessLog } from '../executor.js';
import { enqueueTask, hasActiveTask, activeTaskLabel } from '../taskQueue.js';

const DEAD_CODE_MAX_LISTED = 25;
const CIRCULAR_MAX_LISTED = 10;
const LOG_ERROR_RE = /\b(error|exception|traceback|failed|fatal)\b/i;
const LOG_MAX_LISTED = 20;
const COVERAGE_MAX_LISTED = 10;
const BUNDLE_MAX_LISTED = 8;

function normPath(p) {
  return String(p).split(/[\\/]/).join('/');
}

/**
 * project.diagnostics.* — read-only codebase health checks (Phase 5 intent taxonomy expansion,
 * audit 2026-08-10). Built on infrastructure that already existed for other purposes: the Phase
 * 1 symbol/import graph (codebaseIndexer.js/codebaseGraph.js/codebaseParsers.js) for dead-code
 * and circular-import detection, the Phase 1.4 background type checker (verifyHarness.js) run
 * synchronously here instead of debounced-in-background, and the per-process log ring buffers
 * (executorProcesses.js, re-exported via executor.js) for log scanning. All heuristic, all
 * clearly labeled as such in the reply text — none of these are a substitute for a real linter,
 * bundler analysis, or `tsc` run in CI.
 */
export const diagnosticsHandlers = {
  'project.diagnostics.dead_code': async (ws, action, input, project) => {
    const idx = project.codebaseIndex;
    if (!idx?.symbolIndex?.files || Object.keys(idx.symbolIndex.files).length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No symbol index available for **[${project.name}]** yet — run a project scan first.` }));
      return true;
    }
    const { files, usedBy } = idx.symbolIndex;
    const entryPoints = new Set((idx.entryPoints || []).map(normPath));
    const findings = [];
    for (const [file, symbols] of Object.entries(files)) {
      if (entryPoints.has(normPath(file))) continue; // entry points are used externally (npm start, etc.)
      const refsForFile = usedBy[file] || {};
      for (const sym of symbols) {
        if (sym.exported === false) continue;
        const refs = refsForFile[sym.name];
        if (!refs || refs.length === 0) findings.push(`${file}: ${sym.kind || 'export'} \`${sym.name}\`${sym.line ? ` (line ${sym.line})` : ''}`);
      }
    }
    if (findings.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No unreferenced exports found in **[${project.name}]** (heuristic scan — same-file dynamic usage or usage from outside the indexed codebase won't show up here).` }));
    } else {
      let msg = `### Possibly dead code — [${project.name}]\n\nExported symbols with no in-repo references found (${findings.length} total):\n\n`;
      msg += findings.slice(0, DEAD_CODE_MAX_LISTED).map((f) => `- ${f}`).join('\n');
      if (findings.length > DEAD_CODE_MAX_LISTED) msg += `\n- …and ${findings.length - DEAD_CODE_MAX_LISTED} more`;
      msg += `\n\nThis is a heuristic based on same-project import/reference tracking — it can't see usage from outside this repo (published packages, dynamic \`require\`, string-based imports), so double-check before deleting anything.`;
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
    return true;
  },

  'project.diagnostics.circular_imports': async (ws, action, input, project) => {
    const idx = project.codebaseIndex;
    const repoMap = idx?.repoMap || [];
    if (repoMap.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No repo map available for **[${project.name}]** yet — run a project scan first.` }));
      return true;
    }
    const knownPaths = new Set(repoMap.map((e) => normPath(e.path)));
    const adjacency = new Map();
    for (const entry of repoMap) {
      const from = normPath(entry.path);
      const resolved = [];
      for (const spec of entry.imports || []) {
        const r = resolveLocalImport(entry.path, spec, knownPaths);
        if (r) resolved.push(normPath(r));
      }
      adjacency.set(from, resolved);
    }

    // Simple DFS cycle detection over the file-level import graph. Cap the number of cycles
    // reported (a genuinely tangled project could have many overlapping ones) — this is meant to
    // flag that a problem exists and point at a starting file, not enumerate every cycle.
    const cycles = [];
    const visited = new Set();
    const stack = [];
    const onStack = new Set();

    function dfs(node) {
      if (cycles.length >= CIRCULAR_MAX_LISTED) return;
      visited.add(node);
      stack.push(node);
      onStack.add(node);
      for (const next of adjacency.get(node) || []) {
        if (cycles.length >= CIRCULAR_MAX_LISTED) break;
        if (onStack.has(next)) {
          const start = stack.indexOf(next);
          cycles.push([...stack.slice(start), next]);
        } else if (!visited.has(next)) {
          dfs(next);
        }
      }
      stack.pop();
      onStack.delete(node);
    }
    for (const node of adjacency.keys()) {
      if (cycles.length >= CIRCULAR_MAX_LISTED) break;
      if (!visited.has(node)) dfs(node);
    }

    if (cycles.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No circular imports detected in **[${project.name}]** (heuristic scan of resolved relative imports).` }));
    } else {
      let msg = `### Circular imports — [${project.name}]\n\nFound ${cycles.length} import cycle(s):\n\n`;
      msg += cycles.map((c) => `- ${c.join(' → ')}`).join('\n');
      msg += `\n\nBased on resolved relative imports only (no node_modules/package "exports" resolution) — real, but not exhaustive.`;
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
    return true;
  },

  'project.diagnostics.type_check': async (ws, action, input, project) => {
    if (!(await hasTypeScriptProject(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** doesn't have a \`tsconfig.json\` — nothing to type-check.` }));
      return true;
    }
    // Runs off the chat turn via taskQueue.js (infrastructure expansion, 2026-08-10) instead of
    // awaiting tsc inline — a real run can take up to HARNESS_TIMEOUT_MS (60s), which used to
    // hold this WS connection open the whole time. The queued task posts its own 'answer' when
    // done, out of band; the frontend's answerCase renders any incoming 'answer' as a fresh chat
    // bubble with no matching 'end' required (see src/hooks/wsMessageCases.ts), so no protocol
    // change was needed on the frontend side.
    const queued = hasActiveTask(project.id);
    ws.send(JSON.stringify({
      type: 'answer',
      data: queued
        ? `Another task ("${activeTaskLabel(project.id)}") is running for **[${project.name}]** — queuing the type check behind it. I'll post the result here when it's done.`
        : `Running \`tsc --noEmit\` on **[${project.name}]** in the background — I'll post the result here when it's done.`,
    }));
    enqueueTask(project.id, 'type_check', async () => {
      const result = await runTypeScriptCheck(project.path, () => {});
      const msg = result.errors === 0
        ? `### Type check — [${project.name}]\n\nPassed — 0 errors.`
        : `### Type check — [${project.name}]\n\n**${result.errors} error(s)** found. Last output:\n\n\`\`\`\n${result.lines.join('\n')}\n\`\`\``;
      // readyState 1 === WebSocket.OPEN — the connection may have closed while this ran in the
      // background; sending on a closed socket would throw and take the queue pump down with it.
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'answer', data: msg }));
    });
    return true;
  },

  'project.diagnostics.env_check': async (ws, action, input, project) => {
    const readKeys = async (name) => {
      try {
        const content = await fs.readFile(path.join(project.path, name), 'utf-8');
        const keys = new Set();
        for (const line of content.split('\n')) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          if (m) keys.add(m[1]);
        }
        return keys;
      } catch {
        return null;
      }
    };
    const [envKeys, exampleKeys] = await Promise.all([readKeys('.env'), readKeys('.env.example')]);

    if (exampleKeys === null) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has no \`.env.example\` to check against.${envKeys ? ` (\`.env\` exists with ${envKeys.size} variable(s).)` : ''}` }));
      return true;
    }
    if (envKeys === null) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has a \`.env.example\` (${exampleKeys.size} variable(s)) but no \`.env\` file — none of them are set locally.` }));
      return true;
    }
    const missing = [...exampleKeys].filter((k) => !envKeys.has(k));
    const extra = [...envKeys].filter((k) => !exampleKeys.has(k));
    let msg = `### Env check — [${project.name}]\n\n`;
    if (missing.length === 0 && extra.length === 0) {
      msg += `\`.env\` matches \`.env.example\` — all ${exampleKeys.size} variable(s) present.`;
    } else {
      if (missing.length) msg += `**Missing from \`.env\`** (present in \`.env.example\`): ${missing.join(', ')}\n\n`;
      if (extra.length) msg += `**In \`.env\` but not \`.env.example\`**: ${extra.join(', ')}\n\n`;
      msg += `(Checks variable names only — values aren't compared.)`;
    }
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
    return true;
  },

  'project.diagnostics.log_errors': async (ws, action, input, project) => {
    // getProcessLog only has data for a currently-tracked (still-running) process — the log
    // buffer is discarded once a process is stopped/exits, so there's no "check a past run's
    // errors" case here, only "check the currently running process's errors so far".
    const log = getProcessLog(project.id);
    if (!log) {
      ws.send(JSON.stringify({ type: 'answer', data: `No process is currently running for **[${project.name}]**, so there's no log to check.` }));
      return true;
    }
    if (!log.lines?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]**'s running process (\`${log.command}\`) hasn't produced any output yet.` }));
      return true;
    }
    const errorLines = log.lines.filter((l) => LOG_ERROR_RE.test(l));
    if (errorLines.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No error-shaped lines found in the recent log output for **[${project.name}]** (command: \`${log.command}\`).` }));
    } else {
      let msg = `### Recent errors — [${project.name}]\n\ncommand: \`${log.command}\`\n\n`;
      const shown = errorLines.slice(-LOG_MAX_LISTED);
      msg += '```\n' + shown.join('\n') + '\n```';
      if (errorLines.length > shown.length) msg += `\n\n(${errorLines.length} error-shaped line(s) total, showing the most recent ${shown.length}.)`;
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
    return true;
  },

  // Phase 8 (2026-08-11): test-coverage report from EXISTING artifacts only — the handlers
  // never run a test/coverage command (read-only diagnostics like the rest of this module).
  'project.diagnostics.test_coverage_report': async (ws, action, input, project) => {
    const LCOV_PATHS = ['coverage/lcov.info', '.coverage/lcov.info', 'lcov.info'];
    const SUMMARY_PATHS = ['coverage/coverage-summary.json', 'coverage/coverage-final.json'];

    // lcov.info record shape: SF <path>, LF <lines found>, LH <lines hit>, BRF/BRH optional.
    function parseLcov(text) {
      const files = [];
      let cur = null;
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line === 'end_of_record') {
          if (cur?.sf && typeof cur.lf === 'number' && typeof cur.lh === 'number') files.push(cur);
          cur = null;
        } else if (line.startsWith('SF:')) {
          cur = { sf: line.slice(3), lf: 0, lh: 0 };
        } else if (cur && line.startsWith('LF:')) {
          cur.lf = parseInt(line.slice(3), 10) || 0;
        } else if (cur && line.startsWith('LH:')) {
          cur.lh = parseInt(line.slice(3), 10) || 0;
        }
      }
      return files;
    }

    // coverage-summary.json / coverage-final.json shape: { [file]: { lines: { total, covered } } }
    function parseSummary(obj) {
      const files = [];
      for (const [file, data] of Object.entries(obj || {})) {
        if (file === 'total' || !data?.lines) continue;
        const total = data.lines.total || 0;
        const covered = data.lines.covered || 0;
        files.push({ sf: file, lf: total, lh: covered });
      }
      return files;
    }

    let files = [];
    let source = null;
    for (const p of LCOV_PATHS) {
      try {
        files = parseLcov(await fs.readFile(path.join(project.path, p), 'utf-8'));
        if (files.length > 0) { source = p; break; }
      } catch { /* try next candidate */ }
    }
    if (!source) {
      for (const p of SUMMARY_PATHS) {
        try {
          files = parseSummary(JSON.parse(await fs.readFile(path.join(project.path, p), 'utf-8')));
          if (files.length > 0) { source = p; break; }
        } catch { /* try next candidate */ }
      }
    }
    if (!source) {
      ws.send(JSON.stringify({ type: 'answer', data: `No coverage report found in **[${project.name}]** — looked for \`coverage/lcov.info\`, \`coverage/coverage-summary.json\` and \`coverage-final.json\`. Run your test runner with coverage output first (e.g. \`npm test -- --coverage\`), then ask again.` }));
      return true;
    }

    const withLines = files.filter((f) => f.lf > 0);
    const totalFound = withLines.reduce((s, f) => s + f.lf, 0);
    const totalHit = withLines.reduce((s, f) => s + f.lh, 0);
    const pct = (n) => (n > 0 ? `${(n * 100).toFixed(1)}%` : '0%');
    let msg = `### Test coverage — [${project.name}]\n\nOverall: **${pct(totalHit / totalFound)}** (${totalHit}/${totalFound} lines) — from \`${source}\`\n`;
    if (withLines.length > 0) {
      const worst = [...withLines].sort((a, b) => (a.lh / a.lf) - (b.lh / b.lf)).slice(0, COVERAGE_MAX_LISTED);
      msg += `\nLowest-covered files:\n`;
      msg += worst.map((f) => `- ${pct(f.lh / f.lf)} \`${f.sf}\` (${f.lh}/${f.lf})`).join('\n');
      if (withLines.length > worst.length) msg += `\n- …and ${withLines.length - worst.length} more files`;
    }
    msg += `\n\n(Based on existing coverage artifacts — nothing was run.)`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
    return true;
  },

  // Phase 8 (2026-08-11): bundle-size analysis from EXISTING build output — walks the common
  // output dirs and lists the largest assets + a total. Never triggers a build; a project with
  // no build output gets a clean "build first" answer instead of a guess.
  'project.diagnostics.bundle_size_analysis': async (ws, action, input, project) => {
    const BUNDLE_DIRS = ['dist', 'build', 'out', 'public/build', 'web-build'];
    const BUNDLE_EXTS = new Set(['.js', '.cjs', '.mjs', '.css']);
    const BUNDLE_MAX_DEPTH = 6;
    const BUNDLE_MAX_FILES = 5000;

    const assets = [];
    let visited = 0;

    async function walk(dir, depth) {
      if (depth > BUNDLE_MAX_DEPTH || visited > BUNDLE_MAX_FILES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // dir missing/unreadable — treat as empty
      }
      for (const entry of entries) {
        if (visited > BUNDLE_MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          visited++;
          if (BUNDLE_EXTS.has(path.extname(entry.name).toLowerCase())) {
            try {
              const stat = await fs.stat(full);
              assets.push({ name: path.relative(project.path, full).split(/[\\/]/).join('/'), size: stat.size });
            } catch { /* raced deletion — skip */ }
          }
        }
      }
    }

    for (const d of BUNDLE_DIRS) {
      await walk(path.join(project.path, d), 1);
    }
    if (assets.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No build output found in **[${project.name}]** (looked in ${BUNDLE_DIRS.join(', ')}). Build the app first, then ask again — this analyzes existing artifacts only, it never runs a build.` }));
      return true;
    }

    const total = assets.reduce((s, a) => s + a.size, 0);
    const fmt = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
    const largest = [...assets].sort((a, b) => b.size - a.size).slice(0, BUNDLE_MAX_LISTED);
    let msg = `### Bundle size — [${project.name}]\n\n**${fmt(total)} total** across ${assets.length} asset(s) in ${BUNDLE_DIRS.join(', ')}.\n\nLargest assets:\n`;
    msg += largest.map((a) => `- ${fmt(a.size)} \`${a.name}\``).join('\n');
    if (assets.length > largest.length) msg += `\n- …and ${assets.length - largest.length} more`;
    msg += `\n\n(Existing build output only — nothing was built or executed.)`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
    return true;
  },
};
