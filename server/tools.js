import path from 'path';
import { createPluginToolFn } from './pluginTools.js';
import { webSearch, deepResearch } from './webSearch.js';
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
