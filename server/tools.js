import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createRequire } from 'module';
import util from 'util';
import { performUndo } from './gitSafety.js';
import { loadPluginManifest, createPluginToolFn } from './pluginTools.js';
import { appendMemoryEntry } from './memoryStore.js';
import { runningProcesses, stopTrackedProcess } from './executor.js';
import { state } from './state.js';
import { webSearch, deepResearch } from './webSearch.js';
import { isProbeableUrl } from './urlSafety.js';
import { walkDir, isTextFile, getProjectFiles } from './toolScan.js';
import { applySingleEdit } from './toolEdit.js';
import { isCommandAllowed, ALLOWED_COMMANDS } from './toolAllow.js';
import {
  getPluginManifest,
  GATED_TOOLS,
  ALWAYS_CONFIRM_TOOLS,
  CUSTOM_RISKY_TOOLS,
  isGatedToolCall,
  isCustomToolRisky,
  getToolPermission,
  toolGrantKey,
  resolveToolGate,
} from './toolGate.js';

export { isCommandAllowed, ALLOWED_COMMANDS };
export {
  GATED_TOOLS,
  ALWAYS_CONFIRM_TOOLS,
  CUSTOM_RISKY_TOOLS,
  isGatedToolCall,
  isCustomToolRisky,
  getToolPermission,
  toolGrantKey,
  resolveToolGate,
};

const require = createRequire(import.meta.url);
const RE2 = require('re2');

const execAsync = util.promisify(exec);

/**
 * Every tool below is bound to a single project's directory (`project.path`) and can
 * never resolve outside of it — this is the sandbox boundary. Tools take a single
 * named-args object (not positional args) so an LLM emitting JSON keys in a different
 * order than we expect can't silently swap parameters (e.g. oldString <-> newString).
 *
 * Tools that mutate the filesystem or run commands are intentionally NOT auto-executed
 * from here — the caller (server/wsHandlers/aiQuery.js) is responsible for gating
 * writeFile/editFile/risky executeCommand behind user confirmation before invoking them.
 */
// Workspace projects state (populated by useConsole.ts via server websocket)
export const workspaceProjects = [];

export async function createProjectTools(project) {
  const root = path.resolve(project.path);

  /** Resolves a project-relative path and throws if it escapes the project root.
   *  Uses realpathSync.native to resolve symlinks before checking — a symlink inside
   *  the project could otherwise point outside it undetected.
   *  For new files (ENOENT), walks up to the nearest existing ancestor to verify it's
   *  within the sandbox. */
  function resolveSafe(relPath, projectId = null) {
    // If projectId is provided, find the matching workspace project
    let targetRoot = root;
    if (projectId && workspaceProjects?.length) {
      const wp = workspaceProjects.find(p => p.id === projectId);
      if (wp) targetRoot = path.resolve(wp.path);
    }
    const target = relPath && relPath.trim() ? relPath : '.';
    const resolved = path.resolve(targetRoot, target);
    try {
      const realResolved = realpathSync(resolved);
      const realRoot = realpathSync(targetRoot);
      if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
        throw new Error(`Path escapes sandbox: "${relPath}" resolves outside the project directory (${targetRoot}).`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Walk up to the nearest existing ancestor to verify sandbox boundary
        let ancestor = path.dirname(resolved);
        let found = false;
        while (ancestor !== path.dirname(ancestor)) {
          try {
            const realAncestor = realpathSync(ancestor);
            const realRoot = realpathSync(targetRoot);
            if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
              throw new Error(`Path escapes sandbox: "${relPath}" resolves outside the project directory (${targetRoot}).`);
            }
            found = true;
            break;
          } catch (ae) {
            if (ae.code !== 'ENOENT') throw ae;
            ancestor = path.dirname(ancestor);
          }
        }
        if (!found) {
          throw new Error(`Path escapes sandbox: "${relPath}" — no existing ancestor found within the project directory.`);
        }
      } else {
        throw err;
      }
    }
    return resolved;
  }

  async function readFile({ path: filePath } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    try {
      const resolved = resolveSafe(filePath);
      const buffer = await fs.readFile(resolved);
      // Reject binary files by checking for null bytes in the first 4096 bytes
      const head = buffer.subarray(0, Math.min(4096, buffer.length));
      if (head.includes(0)) {
        const name = path.basename(resolved);
        return { success: false, error: `Cannot read '${name}' — binary files are not supported. Only text files can be read.` };
      }
      const content = buffer.toString('utf-8');
      return { success: true, data: content };
    } catch (err) {
      return { success: false, error: `Failed to read file: ${err.message}` };
    }
  }

  async function writeFile({ path: filePath, content } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    if (typeof content !== 'string') return { success: false, error: 'content is required.' };
    try {
      const resolved = resolveSafe(filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      const written = await fs.readFile(resolved, 'utf-8');
      if (written.length !== content.length) {
        return { success: false, error: 'File truncation detected after write.' };
      }
      return { success: true, data: `Written ${path.relative(root, resolved) || path.basename(resolved)}` };
    } catch (err) {
      return { success: false, error: `Failed to write file: ${err.message}` };
    }
  }

  async function editFile({ path: filePath, oldString, newString, oldStrings, newStrings } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    const hasMulti = Array.isArray(oldStrings) || Array.isArray(newStrings);
    if (hasMulti) {
      if (!Array.isArray(oldStrings) || !Array.isArray(newStrings) || oldStrings.length === 0 || oldStrings.length !== newStrings.length) {
        return { success: false, error: 'oldStrings and newStrings must be non-empty arrays of equal length.' };
      }
      for (const s of oldStrings) if (typeof s !== 'string') return { success: false, error: 'Every oldStrings entry must be a string.' };
      for (const s of newStrings) if (typeof s !== 'string') return { success: false, error: 'Every newStrings entry must be a string.' };
    } else {
      if (typeof oldString !== 'string' || typeof newString !== 'string') {
        return { success: false, error: 'oldString and newString are required.' };
      }
    }
    try {
      const resolved = resolveSafe(filePath);
      const original = await fs.readFile(resolved, 'utf-8');

      // Phase 5 (PASS 5.5): multi-hunk edits — pass oldStrings/newStrings arrays and every hunk
      // is applied in order against the same content, ALL-OR-NOTHING: if any hunk fails to match
      // (exact or whitespace-normalized), nothing is written and the error names the failing hunk,
      // so a partial edit can never be left half-applied on disk.
      if (hasMulti) {
        let content = original;
        let fallbackUsed = false;
        for (let i = 0; i < oldStrings.length; i++) {
          const attempt = applySingleEdit(content, oldStrings[i], newStrings[i]);
          if (!attempt) {
            return {
              success: false,
              error: `Hunk ${i + 1} of ${oldStrings.length} not found in ${filePath} (checked an exact match and a whitespace-tolerant fallback). ` +
                `No changes were written — call readFile("${filePath}") again and copy oldString(s) directly from the current contents before retrying.`,
            };
          }
          content = attempt.content;
          fallbackUsed = fallbackUsed || attempt.usedFallback;
        }
        if (content === original) {
          return { success: false, error: 'No changes made (replacement identical to original).' };
        }
        await fs.writeFile(resolved, content, 'utf-8');
        const note = fallbackUsed ? ' (matched via whitespace-normalized fallback — verify the result looks right)' : '';
        return { success: true, data: `Edited ${filePath} (${oldStrings.length} hunk${oldStrings.length === 1 ? '' : 's'})${note}` };
      }

      const attempt = applySingleEdit(original, oldString, newString);
      if (!attempt) {
        return {
          success: false,
          error: `Text not found in ${filePath} (checked an exact match and a whitespace-tolerant fallback). ` +
            `The file may have changed since it was last read, or oldString doesn't reflect its real content — ` +
            `call readFile("${filePath}") again and copy oldString directly from the current contents before retrying.`,
        };
      }
      if (attempt.content === original) {
        return { success: false, error: 'No changes made (replacement identical to original).' };
      }
      await fs.writeFile(resolved, attempt.content, 'utf-8');
      const note = attempt.usedFallback ? ' (matched via whitespace-normalized fallback — verify the result looks right)' : '';
      return { success: true, data: `Edited ${filePath}${note}` };
    } catch (err) {
      return { success: false, error: `Failed to edit file: ${err.message}` };
    }
  }

  /**
   * Appends content to the end of a file (creating it if it doesn't exist yet) without needing
   * to know the existing content or line count — for trigger-mode "append X to file Y" requests
   * where there's no AI in the loop to compute an insertAtLine target. Gated the same as
   * writeFile/editFile since it mutates a file on disk.
   */
  async function appendToFile({ path: filePath, content } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    if (typeof content !== 'string') return { success: false, error: 'content is required.' };
    try {
      const resolved = resolveSafe(filePath);
      let existing = '';
      try {
        existing = await fs.readFile(resolved, 'utf-8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const separator = existing && !existing.endsWith('\n') ? '\n' : '';
      const newContent = existing + separator + content + '\n';
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, newContent, 'utf-8');
      return { success: true, data: `Appended to ${path.relative(root, resolved) || path.basename(resolved)}` };
    } catch (err) {
      return { success: false, error: `Failed to append to file: ${err.message}` };
    }
  }

  /**
   * Finds files by name/path fragment (not content — see searchCode for that). Exists so the
   * model can disambiguate a vague file reference before acting on it instead of guessing: e.g.
   * "add to the Claude.md file" when the project has both a root CLAUDE.md and a nested one
   * under docs/ should come back here with both candidates so the model can ask which one, per
   * this project's own convention of never guessing at ambiguous file targets.
   */
  async function findFiles({ pattern } = {}) {
    if (!pattern) return { success: false, error: 'pattern is required.' };
    try {
      const { files } = await getProjectFiles(root);
      const needle = pattern.trim().toLowerCase();
      const matches = files
        .map((f) => path.relative(root, f))
        .filter((rel) => rel.toLowerCase().includes(needle) || path.basename(rel).toLowerCase().includes(needle));
      return { success: true, data: matches };
    } catch (err) {
      return { success: false, error: `File search failed: ${err.message}` };
    }
  }

  /**
   * Inserts a new line at a specific 1-indexed line number without touching the rest of the
   * file — for requests like "add this as the 5th line" where editFile's find-and-replace
   * wouldn't apply (there's no existing text to match against). Gated the same as writeFile/
   * editFile since it mutates a file on disk.
   */
  async function insertAtLine({ path: filePath, line, content } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    if (!Number.isInteger(line) || line < 1) {
      return { success: false, error: 'line is required and must be a positive integer (1-indexed).' };
    }
    if (typeof content !== 'string') return { success: false, error: 'content is required.' };
    try {
      const resolved = resolveSafe(filePath);
      const original = await fs.readFile(resolved, 'utf-8');
      const lines = original.split('\n');
      const insertIdx = Math.min(line - 1, lines.length);
      lines.splice(insertIdx, 0, content);
      await fs.writeFile(resolved, lines.join('\n'), 'utf-8');
      return { success: true, data: `Inserted at line ${insertIdx + 1} of ${filePath} (file now ${lines.length} lines).` };
    } catch (err) {
      return { success: false, error: `Failed to insert into file: ${err.message}` };
    }
  }

  /** ReDoS check: reject patterns with nested quantifiers that could cause exponential backtracking. */
  function isReDosRisk(pattern) {
    if (typeof pattern !== 'string') return false;
    // Check for nested quantifiers like (a+)+, (a*)*, (?:a|b)+)+, [a-z]*+
    const dangerous = /\([^()]*?(?:[+*]\??|\{\d+,?\d*\})[^()]*?(?:[+*]\??|\{\d+,?\d*\})[^()]*?\)/;
    return dangerous.test(pattern);
  }

  async function searchCode({ pattern, include } = {}) {
    if (!pattern) return { success: false, error: 'pattern is required.' };
    if (isReDosRisk(pattern)) {
      return { success: false, error: `Pattern rejected: contains nested quantifiers that could cause ReDoS. Simplify the expression.` };
    }
    try {
      const { files } = await getProjectFiles(root);
      const regex = new RE2(pattern, 'gi');
      const matches = [];

      for (const file of files) {
        if (include && !file.endsWith(include.replace(/^\*/, ''))) continue;
        if (!isTextFile(file)) continue;
        try {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              matches.push({
                file: path.relative(root, file),
                line: i + 1,
                text: lines[i].trim().substring(0, 200)
              });
            }
          }
        } catch {}
      }
      return { success: true, data: matches };
    } catch (err) {
      return { success: false, error: `Search failed: ${err.message}` };
    }
  }

  async function listFiles({ path: dirPath, pattern } = {}) {
    try {
      const resolved = resolveSafe(dirPath || '.');
      let files;
      if (resolved === root) {
        const cached = await getProjectFiles(root);
        files = cached.files;
      } else {
        files = await walkDir(resolved);
      }
      const filtered = pattern ? files.filter(f => f.includes(pattern)) : files;
      const relative = filtered.map(f => path.relative(root, f));
      return { success: true, data: relative };
    } catch (err) {
      return { success: false, error: `Failed to list files: ${err.message}` };
    }
  }

  async function getProjectInfo() {
    return {
      success: true,
      data: {
        id: project.id,
        name: project.name,
        path: project.path,
        configEntries: project.config?.entries?.length || 0,
        docFiles: project.contextFiles?.length || 0,
        stack: project.parsedKnowledge?.stack?.trim() || null,
        commandsFound: project.parsedKnowledge?.commands?.trim() || null
      }
    };
  }

  async function getGitStatus() {
    try {
      const { stdout } = await execAsync('git status --short', { cwd: root });
      return { success: true, data: stdout.trim() || '(clean)' };
    } catch (err) {
      return { success: false, error: `Git status failed: ${err.message}` };
    }
  }

  async function undoLastChange() {
    return await performUndo(root);
  }

  /**
   * Persists a short, durable fact/preference/project note to this project's cross-session
   * memory file (.console/memory.md), so it's available in future AI-mode conversations, not
   * just this one. `importance: 'low'` runs immediately (see isGatedToolCall below — only
   * 'judgment' requires user approval first), by design: the point is the AI can jot down
   * low-stakes context (a preference, a project quirk, a correction) without interrupting the
   * conversation for a confirm click every time, while anything that reads as a real judgment
   * call about what's worth permanently remembering still gets a human checkpoint.
   */
  async function saveMemory({ content, importance } = {}) {
    if (!content) return { success: false, error: 'content is required.' };
    if (importance !== 'low' && importance !== 'judgment') {
      return { success: false, error: 'importance is required and must be "low" or "judgment".' };
    }
    return appendMemoryEntry(root, content);
  }

  /**
   * Phase 5 (PASS 5.3): read-only view of processes currently tracked for a project — the same
   * runningProcesses map "stop server" reads, plus the detected dev URL if one exists. Never
   * gated: it only reports state, it doesn't act on it.
   */
  async function listProcesses({ projectId } = {}) {
    const pid = projectId || project.id;
    const proc = runningProcesses.get(pid);
    if (!proc) return { success: true, data: [] };
    const since = proc.child?.spawnTime ? new Date(proc.child.spawnTime).toISOString() : null;
    return {
      success: true,
      data: [{
        projectId: pid,
        command: proc.command,
        url: state.lastDevUrls?.get(pid) || null,
        runningSince: since,
      }],
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
    const stopped = stopTrackedProcess(pid);
    if (!stopped.ok) return { success: true, data: 'No running process for this project.' };
    return { success: true, data: `Stopped \`${stopped.command}\`.` };
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
    const command = findTestCommand(project);
    if (!command) {
      return { success: true, data: 'No test setup detected for this project (no package.json test script, Cargo.toml, go.mod, or Python test marker).' };
    }
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: root, timeout: 90000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
      return { success: true, data: { command, output: `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20000) } };
    } catch (err) {
      const output = (err.stdout || '') + (err.stderr ? `\n${err.stderr}` : '');
      return { success: false, error: `${command} failed (exit ${err.code ?? '?'}): ${output.trim().slice(0, 4000) || err.message}` };
    }
  }

  // Base tools that are always available
  const baseTools = {
    readFile,
    writeFile,
    editFile,
    findFiles,
    insertAtLine,
    appendToFile,
    searchCode,
    listFiles,
    getProjectInfo,
    getGitStatus,
    undoLastChange,
    saveMemory,
    // Phase 5 (PASS 5.3) process/test tools
    listProcesses,
    stopProcess,
    probeUrl,
    runTests,
    // Phase 5 (PASS 5.5): web research tools (SSRF-guarded, read-only network fetches)
    webSearch,
    deepResearch,
  };

  // Load and merge custom plugin tools from console.tools.json
  const manifest = await getPluginManifest(root);
  if (manifest?.tools?.length) {
    const riskyTools = new Set();
    for (const entry of manifest.tools) {
      if (baseTools[entry.name]) continue; // Don't override built-in tools
      baseTools[entry.name] = createPluginToolFn(entry, root);
      if (entry.risky) riskyTools.add(entry.name);
    }
    if (riskyTools.size > 0) {
      CUSTOM_RISKY_TOOLS.set(root, riskyTools);
    }
  }

  return baseTools;
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
