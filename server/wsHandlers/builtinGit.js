import { gitWorkflowHandlers } from './builtinGitWorkflow.js';
import { gitRemoteHandlers } from './builtinGitRemote.js';
import { gitRepoSetupHandlers } from './builtinGitRepoSetup.js';
import { gitReadHandlers } from './builtinGitRead.js';
import { gitWorktreeHandlers } from './builtinGitWorktree.js';
import { gitMaintenanceHandlers } from './builtinGitMaintenance.js';

/**
 * Git intent handlers (Phase 10 step 2, extracted verbatim from builtinIntents.js; Phase 14
 * split, 2026-08-05 — now a pure merge of five per-domain handler maps, bodies moved verbatim).
 * Full (ws, action, input, project, sessionContext) signature for uniform dispatch.
 * `git_status` intentionally lives with the chit-chat set in builtinIntents.js.
 */
export const gitHandlers = {
  ...gitWorkflowHandlers,
  ...gitRemoteHandlers,
  ...gitRepoSetupHandlers,
  ...gitReadHandlers,
  ...gitWorktreeHandlers,
  ...gitMaintenanceHandlers,
};
