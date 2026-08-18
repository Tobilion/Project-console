import { createFileOpsTools } from './toolFileOps.js';
import { createFileEditTool } from './toolFileEdit.js';
import { createFileSearchTools } from './toolFileSearch.js';
import { createProjectInfoTools } from './toolProjectInfo.js';

/**
 * The file/git/info/memory tools, each bound to one project (Phase 9 split, 2026-08-04 —
 * extracted from tools.js; Phase 14 split, 2026-08-05 — now a pure composition of four
 * per-domain leaf factories, bodies moved verbatim). `resolveSafe` comes in from the
 * orchestrator (toolSandbox.js factory) since it needs the workspace-project resolution that
 * only tools.js owns. Tools take a single named-args object (not positional args) so an LLM
 * emitting JSON keys in a different order than we expect can't silently swap parameters (e.g.
 * oldString <-> newString).
 *
 * Tools that mutate the filesystem are intentionally NOT auto-executed from here — the
 * caller (server/wsHandlers/aiQuery.js) is responsible for gating writeFile/editFile/
 * insertAtLine/appendToFile/saveMemory behind user confirmation before invoking them.
 */
export function createFileTools({ project, root, resolveSafe }) {
  return {
    ...createFileOpsTools({ root, resolveSafe }),
    ...createFileEditTool({ root, resolveSafe }),
    ...createFileSearchTools({ root, resolveSafe }),
    ...createProjectInfoTools({ project, root }),
  };
}
