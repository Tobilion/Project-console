import { exec } from 'child_process';
import util from 'util';
import { runningProcesses, stopTrackedProcess } from './executor.js';
import { state } from './state.js';
import { isProbeableUrl } from './urlSafety.js';
import { buildSandboxEnv } from './executorSandbox.js';
import { readProfile } from './routes/profileRoutes.js';
import fs from 'fs/promises';
import path from 'path';
import { getCommandDir } from './commandDir.js';

// Process/test/probe tools for the AI tool layer (Phase 9 split, 2026-08-04 — extracted from
// tools.js; consumed by tools.js's createProjectTools assembly). Factory-bound to one project,
// same as the rest of the tools — `project`/`root` come in from the caller, nothing here
// reaches outside the sandbox.

const execAsync = util.promisify(exec);

export function createProcessTools({ project, root }) {
  /**
   * Phase 5 (PASS 5.3): read-only view of processes currently tracked for a project — the same
   * runningProcesses map "stop server" reads, plus the detected dev URL if one exists. Never
   * gated: it only reports state, it doesn't act on it.
   */
  async function listProcesses({ projectId } = {}) {
    const pid = projectId || project.id;
    const procs = [...(runningProcesses.get(pid)?.values() || [])];
    return {
      success: true,
      data: procs.map((proc) => ({
        projectId: pid,
        command: proc.command,
        url: state.lastDevUrls?.get(pid) || null,
        runningSince: proc.child?.spawnTime ? new Date(proc.child.spawnTime).toISOString() : null,
      })),
    };
  }

  /**
   * Phase 5 (PASS 5.3): stops a running process for a project via the shared stopTrackedProcess
   * helper (executor.js) — the SAME single kill path as the "stop server" trigger phrase and the
   * Processes-dock stop button, so the cleanup (kill + map delete + log delete + lastDevUrls
   * delete + broadcasts) can never drift between callers. Never a raw kill on the model's say-so:
   * it's in ALWAYS_CONFIRM_TOOLS, so the user always approves it first.
   */
  async function stopProcess({ projectId } = {}) {
    const pid = projectId || project.id;
    const stopped = await stopTrackedProcess(pid);
    if (!stopped.ok) return { success: true, data: 'No running process for this project.' };
    const headsup = stopped.warning ? ` Heads-up: ${stopped.warning}.` : '';
    return { success: true, data: `Stopped \`${stopped.command}\`.${headsup}` };
  }

  /**
   * Phase 5 (PASS 5.3): liveness check for a URL (e.g. "is the dev server up yet?"). Restricted
   * to localhost/private http(s) addresses by the same SSRF discipline as webSearch's external
   * allowlist — a probing tool must never become a lever for reaching internal services.
   * Read-only, ungated.
   */
  async function probeUrl({ url } = {}) {
    if (!url) return { success: false, error: 'url is required.' };
    try {
      const urlObj = new URL(url);
      if (!isProbeableUrl(urlObj)) {
        return { success: false, error: `Refusing to probe "${url}" — only localhost/private http(s) URLs are allowed.` };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(urlObj.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal });
        return { success: true, data: { ok: res.ok, status: res.status, url: urlObj.toString() } };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { success: false, error: `Probe failed: ${err.message}` };
    }
  }

  /**
   * Phase 5 (PASS 5.3): runs the project's test command, detected by the same shared marker
   * logic as trigger-mode run_tests (findTestCommand). A command execution — so it lives in
   * ALWAYS_CONFIRM_TOOLS and the user approves every run. Bounded exec (90s / 10MB) so a hung
   * test suite can't wedge the model loop.
   */
  async function runTests() {
    // Wrapper projects (scriptless root + one sub-package) run tests inside the sub-package:
    // root keyFiles has no package.json there, so first check the sub-package's own test
    // script (the one package.json marker findTestCommand understands), then fall back to
    // the root marker scan exactly as before. commandDir.js.
    let command = null;
    let runRoot = root;
    const sub = await getCommandDir(project);
    if (sub) {
      runRoot = path.join(root, sub);
      try {
        const subPkg = JSON.parse(await fs.readFile(path.join(runRoot, 'package.json'), 'utf-8'));
        if (subPkg.scripts && subPkg.scripts.test) command = 'npm test';
      } catch {}
    }
    if (!command) command = findTestCommand(project);
    if (!command) {
      return { success: true, data: 'No test setup detected for this project (no package.json test script, Cargo.toml, go.mod, or Python test marker).' };
    }
    try {
      // Phase 3: runTests is ALWAYS_CONFIRM_TOOLS — when the user opted into the sandbox,
      // run the test suite with the allowlisted env (executorSandbox.js) as well.
      const sandboxed = readProfile().sandboxRiskyCommands;
      const { stdout, stderr } = await execAsync(command, {
        cwd: runRoot,
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: sandboxed ? buildSandboxEnv(process.env, runRoot) : undefined,
      });
      return { success: true, data: { command, output: `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20000) } };
    } catch (err) {
      const output = (err.stdout || '') + (err.stderr ? `\n${err.stderr}` : '');
      return { success: false, error: `${command} failed (exit ${err.code ?? '?'}): ${output.trim().slice(0, 4000) || err.message}` };
    }
  }

  return { listProcesses, stopProcess, probeUrl, runTests };
}

/**
 * Phase 5 (2026-08-03, PASS 5.3) — single source of truth for test-command detection, shared by
 * the AI-mode runTests tool (tools.js) and the trigger-mode run_tests handler
 * (builtinIntents.js). Identical marker order to the original handler: package.json scripts.test
 * → Cargo.toml → go.mod → Python (pyproject.toml/requirements.txt). keyFiles content is truncated
 * at 2000 chars with a "\n... (truncated)" tail by readKeyFiles — stripped before parsing, same
 * convention as detectFrameworks/configInitializer (a large package.json without that would
 * silently report "no test setup detected"). Returns the command string or null.
 */
export function findTestCommand(project) {
  const keyFiles = project?.codebaseIndex?.keyFiles || {};
  const pkgJson = keyFiles['package.json'];
  let scripts = {};
  if (pkgJson) {
    try {
      scripts = JSON.parse(pkgJson.replace(/\n\.\.\. \(truncated\)$/, '')).scripts || {};
    } catch {}
  }
  if (scripts.test) return 'npm test';
  if (keyFiles['cargo.toml']) return 'cargo test';
  if (keyFiles['go.mod']) return 'go test ./...';
  if (keyFiles['pyproject.toml'] || keyFiles['requirements.txt']) return 'python -m pytest';
  return null;
}
