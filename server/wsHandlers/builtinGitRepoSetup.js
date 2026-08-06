import crypto from 'crypto';
import { isGitRepo } from '../gitSafety.js';
import { executeCommand } from '../executor.js';
import { pendingConfirmations } from '../state.js';

/**
 * Repo-setup + staging handlers (Phase 14 split of builtinGit.js, 2026-08-05 — bodies moved
 * verbatim). git_init carries the 2026-07-29 no-clobber guard (short-circuits when a repo
 * already exists instead of offering a no-op confirm); git_ignore_add/git_add are immediate.
 */
export const gitRepoSetupHandlers = {
  git_add: async (ws, action, input, project, sessionContext) => {
    executeCommand('git add -A', project.path, ws, project.id);
    return true;
  },

  git_init: async (ws, action, input, project, sessionContext) => {
    // Confirmed live 2026-07-29: "set up git for this folder" was tried twice in one session —
    // every other git-setup intent here already checks isGitRepo() before acting (git_push/
    // git_commit/deploy all tell the user to run git init first if there's *no* repo yet), but
    // this was the one path that didn't check the other direction. `git init` on an already-
    // initialized repo is technically harmless (git just reinitializes in place, same .git
    // folder, no data loss), but there's no reason to even offer a confirm prompt for a no-op —
    // short-circuit with a clear "already set up" message instead.
    if (await isGitRepo(project.path)) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** is already a git repository — nothing to set up. Try "git status" to see its current state.`
      }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: 'git init',
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: 'git init (creates a new git repository here)',
        trigger: 'git_init'
      }));
    }
  },

  git_ignore_add: async (ws, action, input, project, sessionContext) => {
    // Extract what to ignore from input, default to node_modules
    const ignoreMatch = input.match(/(?:add|ignore)\s+(.+?)\s+(?:to\s+)?gi?ignore/i);
    const toIgnore = ignoreMatch ? ignoreMatch[1].trim() : 'node_modules';
    // Use windows-compatible echo to append
    executeCommand(`echo "${toIgnore}" >> .gitignore`, project.path, ws, project.id);
    return true;
  },

  git_rm_cached: async (ws, action, input, project, sessionContext) => {
    const rmMatch = input.match(/(?:remove|untrack|rm)\s+(.+?)\s+(?:from\s+)?(?:git|tracking)/i);
    const toRemove = rmMatch ? rmMatch[1].trim() : 'node_modules';
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      owner: ws,
      projectId: project.id,
      command: `git rm --cached -r "${toRemove}"`,
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: `git rm --cached -r "${toRemove}" (removes from tracking, keeps on disk)`,
      trigger: 'git_rm_cached'
    }));
  },
};
