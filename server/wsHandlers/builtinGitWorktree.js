import crypto from 'crypto';
import { isGitRepo } from '../gitSafety.js';
import { executeCommand } from '../executor.js';
import { pendingConfirmations } from '../state.js';
import { isSafeParamValue } from '../paramCommand.js';

/**
 * Stash/branch/tag handlers (Phase 14 split of builtinGit.js, 2026-08-05 — bodies moved
 * verbatim). All confirm-gated (shelving/restoring work, branch creation, tag creation);
 * git_branch_create + git_tag validate user-supplied names with isSafeParamValue BEFORE the
 * confirm prompt, since the name substitutes straight into the command string.
 */
export const gitWorktreeHandlers = {
  git_stash: async (ws, action, input, project, sessionContext) => {
    // New (2026-07-30, requested directly). Confirm-gated even though `git stash` is technically
    // reversible via `git stash pop` — it can look like uncommitted work "disappeared" from the
    // working tree, which is exactly the kind of surprising-but-recoverable action this app's
    // existing safety model (see CLAUDE.md) already requires a confirm step for.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { owner: ws, projectId: project.id, command: 'git stash', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash (shelves uncommitted changes — restore later with "git stash pop")', trigger: 'git_stash' }));
    }
  },

  git_stash_pop: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { owner: ws, projectId: project.id, command: 'git stash pop', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash pop (restores the most recently stashed changes — can conflict with current changes)', trigger: 'git_stash_pop' }));
    }
  },

  git_branch_create: async (ws, action, input, project, sessionContext) => {
    // New (2026-07-30, requested directly). Same injection-safety check paramCommand.js's
    // parameterized commands already use for user-supplied values substituted into a command
    // string — a branch name is exactly that kind of value.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const branchMatch = input.match(/(?:branch|create a branch|new branch|make a branch)(?:\s+called|\s+named)?\s+["'`]?([\w./-]+)["'`]?/i);
      const branchName = branchMatch?.[1];
      if (!branchName || !isSafeParamValue(branchName)) {
        ws.send(JSON.stringify({ type: 'answer', data: `What should the new branch be called? Try "create a branch called feature-x".` }));
      } else {
        const token = crypto.randomUUID();
        const command = `git checkout -b ${branchName}`;
        pendingConfirmations.set(token, { owner: ws, projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates and switches to a new branch)`, trigger: 'git_branch_create' }));
      }
    }
  },

  git_tag: async (ws, action, input, project, sessionContext) => {
    // Intent expansion (Phase 2, 2026-08-03): no tag name -> list (read-only, immediate, same
    // as git_log); a tag name -> confirm-gated `git tag <name>`. The name is validated with
    // isSafeParamValue BEFORE the confirm prompt, exactly like git_branch_create, since it
    // substitutes straight into the command string.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const tagName = (input.match(/(?:called|named)\s+([A-Za-z0-9._/-]+)/i) ||
                       input.match(/\btag(?: this)?(?: as)?\s+([A-Za-z0-9._/-]+)/i))?.[1] || null;
      if (!tagName) {
        executeCommand('git tag', project.path, ws, project.id);
      } else if (!isSafeParamValue(tagName)) {
        ws.send(JSON.stringify({ type: 'answer', data: `Tag name **${tagName}** contains characters that aren't allowed. Use letters, numbers, dots, underscores, slashes, and hyphens.` }));
      } else {
        const token = crypto.randomUUID();
        const command = `git tag ${tagName}`;
        pendingConfirmations.set(token, { owner: ws, projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates a tag on the current commit)`, trigger: 'git_tag' }));
      }
    }
  },
};
