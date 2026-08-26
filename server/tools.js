import path from 'path';
import fs from 'fs/promises';
import { createPluginToolFn } from './pluginTools.js';
import { webSearch, deepResearch } from './webSearch.js';
import { appendAction } from './actionHistory.js';
import { isCommandAllowed, ALLOWED_COMMANDS } from './toolAllow';
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
} from './toolGate';
import { createProcessTools, findTestCommand } from './toolProcess.js';
import { createResolveSafe } from './toolSandbox.js';
import { createFileTools } from './toolFileTools.js';

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
  findTestCommand,
};

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
  const resolveSafe = createResolveSafe(root, workspaceProjects);

  // Base tools that are always available
  const {
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
  } = createFileTools({ project, root, resolveSafe });
  const { listProcesses, stopProcess, probeUrl, runTests } = createProcessTools({ project, root });

  // Phase 4 (2026-08-10): transparent history wrapper around the four file-mutating tools.
  // Every write/edit/insert/append from ANY caller (AI loop, direct tool calls, trigger-mode
  // file ops) lands in the project's .console/action-history.jsonl with its pre-image inline,
  // so `revert action <id>` can restore exactly that action's before-state. The wrapper is a
  // pure passthrough: pre-read failures, logging failures and unsafe paths never change the
  // tool's behavior or result.
  const MUTATING_FILE_TOOLS = {
    writeFile: { type: 'file_write', describe: (p, existed) => (existed ? `Overwrote ${p}` : `Created ${p}`) },
    editFile: { type: 'file_edit', describe: (p) => `Edited ${p}` },
    insertAtLine: { type: 'file_insert', describe: (p) => `Inserted into ${p}` },
    appendToFile: { type: 'file_append', describe: (p) => `Appended to ${p}` },
  };
  const logFileAction = (toolName, relPath, existed, preContent) => {
    const meta = MUTATING_FILE_TOOLS[toolName];
    if (!meta || !relPath || typeof relPath !== 'string') return null;
    try {
      return appendAction(project.path, {
        type: meta.type,
        description: meta.describe(relPath, existed),
        path: relPath,
        existed,
        preContent,
      });
    } catch {
      // History logging never breaks the action that produced it.
      return null;
    }
  };
  const wrapMutatingTool = (toolName, toolFn) => {
    if (typeof toolFn !== 'function') return toolFn;
    return async (args) => {
      const relPath = args?.path;
      if (!relPath || typeof relPath !== 'string') return toolFn(args);
      const abs = path.resolve(root, relPath);
      if (abs !== root && !abs.startsWith(root + path.sep)) return toolFn(args);
      let preContent = null;
      let existed = false;
      try {
        const st = await fs.stat(abs);
        if (st.size > 1_000_000) return toolFn(args); // too large for an inline pre-image — skip logging, keep behavior
        preContent = await fs.readFile(abs, 'utf-8');
        existed = true;
      } catch {
        // New file (or unreadable) — pre-image stays null, revert will delete instead.
      }
      const result = await toolFn(args);
      if (result?.success) {
        // Additive journal id on the result (2026-08-24): the trigger-mode fileOp confirm
        // branch reads it to offer an undo toast; the AI loop and tool history ignore it.
        const actionId = logFileAction(toolName, relPath, existed, preContent);
        if (actionId) return { ...result, actionId };
      }
      return result;
    };
  };

  const baseTools = {
    readFile,
    writeFile: wrapMutatingTool('writeFile', writeFile),
    editFile: wrapMutatingTool('editFile', editFile),
    findFiles,
    insertAtLine: wrapMutatingTool('insertAtLine', insertAtLine),
    appendToFile: wrapMutatingTool('appendToFile', appendToFile),
    searchCode,
    listFiles,
    getProjectInfo,
    getGitStatus,
    undoLastChange,
    saveMemory,
    // Phase 5 (PASS 5.3) process/test tools (from createProcessTools above)
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
