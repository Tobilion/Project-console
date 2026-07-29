import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createRequire } from 'module';
import util from 'util';
import { performUndo } from './gitSafety.js';
import { loadPluginManifest, createPluginToolFn } from './pluginTools.js';

const require = createRequire(import.meta.url);
const RE2 = require('re2');

const execAsync = util.promisify(exec);

const TEXT_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.css', '.html',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.env', '.txt', '.xml', '.svg',
  '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.sqlite', '.db'
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'venv', '.venv', 'dist', 'build',
  '.next', '.cache', '__pycache__', 'env', '.vscode'
]);

/** Collapse a line's leading/trailing whitespace and internal whitespace runs to one space, so
 * two lines that differ only in indentation or spacing compare equal. Used by editFile's
 * whitespace-tolerant fallback below. */
function normalizeLine(line) {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Finds a contiguous block of `contentLines` whose normalized form matches `oldLines`'
 * normalized form exactly, returning the starting index or -1. This is a fallback for
 * editFile's exact-substring match — small local models frequently fail to reproduce a file's
 * exact whitespace/quoting when they compose an `oldString`, and normalized-line matching
 * recovers the common case (same text, different indentation/spacing) without falling back to
 * something as loose as fuzzy/similarity matching that could silently edit the wrong block.
 */
function findNormalizedLineMatch(contentLines, oldLines) {
  if (oldLines.length === 0 || oldLines.length > contentLines.length) return -1;
  const normOld = oldLines.map(normalizeLine);
  for (let i = 0; i <= contentLines.length - normOld.length; i++) {
    let matched = true;
    for (let j = 0; j < normOld.length; j++) {
      if (normalizeLine(contentLines[i + j]) !== normOld[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

async function walkDir(dirPath, maxDepth = 6) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && maxDepth > 0) {
      const sub = await walkDir(fullPath, maxDepth - 1);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

// Allowlist for executeCommand — only these executables may be run through the console.
// Prevents arbitrary command execution even if a path-escaped or unapproved command
// somehow reaches the execution path.
export const ALLOWED_COMMANDS = [
  'npm', 'node', 'git', 'python', 'pip', 'python3', 'pip3',
  'npx', 'vite', 'tsc', 'tsx', 'eslint', 'prettier', 'jest', 'vitest',
];

export function isCommandAllowed(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const exe = cmd.trim().split(/\s+/)[0].toLowerCase();
  // Normalize Windows backslashes, strip extension, compare basename only
  const normalized = exe.replace(/\\/g, '/');
  const base = path.basename(normalized).replace(/\.(exe|bat|cmd|ps1)$/i, '');
  return ALLOWED_COMMANDS.includes(base);
}

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
// Cache walkDir results per project root with mtime invalidation so repeated
// findFiles/searchCode/listFiles calls don't re-scan the whole filesystem.
const fileIndexCache = new Map();

// Workspace projects state (populated by useConsole.ts via server websocket)
export const workspaceProjects = [];

async function getProjectFiles(root) {
  const cached = fileIndexCache.get(root);
  try {
    const stat = await fs.stat(root);
    if (cached && cached.mtime >= stat.mtimeMs) return cached;
    const files = await walkDir(root);
    const entry = { files, mtime: stat.mtimeMs };
    fileIndexCache.set(root, entry);
    return entry;
  } catch {
    return cached || { files: [], mtime: 0 };
  }
}

/** Cache for plugin manifests to avoid reading the file on every tool creation. */
const pluginManifestCache = new Map();

async function getPluginManifest(root) {
  if (pluginManifestCache.has(root)) {
    const cached = pluginManifestCache.get(root);
    // If it's a promise (first call in flight), await it; otherwise return the resolved value
    return cached instanceof Promise ? cached : cached;
  }
  const promise = loadPluginManifest(root).then(result => {
    pluginManifestCache.set(root, result);
    return result;
  }).catch(() => {
    pluginManifestCache.set(root, null);
    return null;
  });
  pluginManifestCache.set(root, promise);
  return promise;
}

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

  async function editFile({ path: filePath, oldString, newString } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      return { success: false, error: 'oldString and newString are required.' };
    }
    try {
      const resolved = resolveSafe(filePath);
      const content = await fs.readFile(resolved, 'utf-8');

      if (content.includes(oldString)) {
        const newContent = content.replace(oldString, newString);
        if (newContent === content) {
          return { success: false, error: 'No changes made (replacement identical to original).' };
        }
        await fs.writeFile(resolved, newContent, 'utf-8');
        return { success: true, data: `Edited ${filePath}` };
      }

      // LOCAL_ROUTER_UPGRADE_PROMPT.md piece 3: exact match failed — a common failure mode for
      // smaller local models that don't reproduce a file's exact whitespace/quoting when they
      // compose oldString. Before giving up, try a whitespace-normalized line-range match: if a
      // contiguous block of the file's real lines matches oldString's lines once each line is
      // trimmed and its internal whitespace collapsed, replace that exact original block with
      // newString (verbatim, as given) rather than silently failing.
      const contentLines = content.split('\n');
      const oldLines = oldString.split('\n');
      const startLine = findNormalizedLineMatch(contentLines, oldLines);
      if (startLine === -1) {
        return {
          success: false,
          error: `Text not found in ${filePath} (checked an exact match and a whitespace-tolerant fallback). ` +
            `The file may have changed since it was last read, or oldString doesn't reflect its real content — ` +
            `call readFile("${filePath}") again and copy oldString directly from the current contents before retrying.`,
        };
      }
      const before = contentLines.slice(0, startLine);
      const after = contentLines.slice(startLine + oldLines.length);
      const newContent = [...before, ...newString.split('\n'), ...after].join('\n');
      if (newContent === content) {
        return { success: false, error: 'No changes made (replacement identical to original).' };
      }
      await fs.writeFile(resolved, newContent, 'utf-8');
      return { success: true, data: `Edited ${filePath} (matched via whitespace-normalized fallback — verify the result looks right)` };
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
    undoLastChange
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

/** Tool names whose effects are destructive/irreversible-ish and must be confirmed by the user before running. */
export const GATED_TOOLS = new Set(['writeFile', 'editFile', 'insertAtLine', 'appendToFile']);

/**
 * Per-project risky custom plugin tools. Populated by createProjectTools() when loading
 * console.tools.json — maps project root -> Set of tool names with risky: true.
 */
export const CUSTOM_RISKY_TOOLS = new Map();

export function isGatedToolCall(toolName, args) {
  if (GATED_TOOLS.has(toolName)) return true;
  if (toolName === 'executeCommand' && args?.risky) return true;
  // Not a built-in tool name — could be a custom plugin tool with risky: true
  // (checked by project root context in runToolCall)
  return false;
}

/** Overload: check if a custom tool by name is registered as risky for a given project root. */
export function isCustomToolRisky(toolName, projectRoot) {
  const riskySet = CUSTOM_RISKY_TOOLS.get(projectRoot);
  return riskySet ? riskySet.has(toolName) : false;
}
