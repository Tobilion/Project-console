import { isGitRepo } from '../gitSafety.js';
import { executeCommand } from '../executor.js';

/**
 * Read-only git handlers (Phase 14 split of builtinGit.js, 2026-08-05 — bodies moved verbatim).
 * All immediate, no confirmation — same treatment as git_log/git_branch; the isGitRepo gate on
 * the newer ones mirrors git_diff's.
 */
export const gitReadHandlers = {
  git_log: async (ws, action, input, project, sessionContext) => {
    executeCommand('git log --oneline -10', project.path, ws, project.id);
    return true;
  },

  git_branch: async (ws, action, input, project, sessionContext) => {
    executeCommand('git branch', project.path, ws, project.id);
    return true;
  },

  git_checkout: async (ws, action, input, project, sessionContext) => {
    ws.send(JSON.stringify({ type: 'answer', data: `To switch branches, use AI mode or run \`git checkout <branch-name>\` directly. You can also tell me the branch name and I'll set up the command for confirmation.` }));
  },

  git_diff: async (ws, action, input, project, sessionContext) => {
    // Safe/read-only, same treatment as git_log/git_branch — no confirmation needed.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      executeCommand('git diff', project.path, ws, project.id);
      return true;
    }
  },

  git_stash_list: async (ws, action, input, project, sessionContext) => {
    // New (2026-08-03, Phase 3 of the intent-expansion spec). Read-only listing, same immediate
    // treatment as git_log/git_branch — never touches the stash itself.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      executeCommand('git stash list', project.path, ws, project.id);
      return true;
    }
  },

  git_ahead_behind: async (ws, action, input, project, sessionContext) => {
    // Intent expansion (Phase 2, 2026-08-03): "am I behind origin" — git status -sb prints the
    // "[origin/main: ahead 2, behind 1]" line directly; no parsing needed. Read-only, immediate.
    executeCommand('git status -sb', project.path, ws, project.id);
    return true;
  },
};
