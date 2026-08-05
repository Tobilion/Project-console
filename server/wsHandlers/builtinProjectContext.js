import { contextIndexHandlers } from './builtinContextIndex.js';
import { contextRepoMapHandlers } from './builtinContextRepoMap.js';
import { contextScanHandlers } from './builtinContextScans.js';
import { contextRuntimeHandlers } from './builtinContextRuntime.js';

/**
 * project.context.* / project.context.running_processes / project.context.session_info — the
 * read-only codebase-introspection branch bodies extracted verbatim from builtinIntents.js
 * (Phase 10 step 5; Phase 14 split, 2026-08-05 — now a pure merge of four per-domain handler
 * maps: cached-index reads, repo-map reads, on-demand scans, live-runtime state).
 */
export const projectContextHandlers = {
  ...contextIndexHandlers,
  ...contextRepoMapHandlers,
  ...contextScanHandlers,
  ...contextRuntimeHandlers,
};
