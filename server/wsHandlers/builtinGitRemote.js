import crypto from 'crypto';
import { isGitRepo } from '../gitSafety.js';
import { executeCommand } from '../executor.js';
import { pendingConfirmations } from '../state.js';

/**
 * Remote/pull handlers (Phase 14 split of builtinGit.js, 2026-08-05 — bodies moved verbatim).
 * git_remote_add handles the "Can I attach the github link" case — parses a URL or asks for
 * one instead of guessing, and its `origin` upsert works whether the remote already exists.
 */
export const gitRemoteHandlers = {
  git_remote_add: async (ws, action, input, project, sessionContext) => {
    // "Can I attach the github link" had nowhere to go before — no intent existed for setting
    // up a remote at all, so it fell through to an unrelated generic help response. Parse a
    // URL out of the input; if there isn't one, ask for it instead of guessing.
    const urlMatch = input.match(/(https?:\/\/\S+|git@[\w.-]+:\S+)/i);
    if (!urlMatch) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Paste the GitHub repository URL (e.g. \`https://github.com/you/repo.git\`) and I'll set it as the remote.`
      }));
    } else if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then I can add the remote.` }));
    } else {
      const url = urlMatch[1].replace(/["').,]+$/, '');
      const token = crypto.randomUUID();
      // Works whether "origin" already exists or not, without needing an extra round trip to check.
      const command = `git remote add origin ${url} || git remote set-url origin ${url}`;
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `${command}  (sets "origin" to ${url})`,
        trigger: 'git_remote_add'
      }));
    }
  },

  git_pull: async (ws, action, input, project, sessionContext) => {
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      projectId: project.id,
      command: 'git pull',
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: 'git pull (fetches and merges remote changes)',
      trigger: 'git_pull'
    }));
  },

  git_fetch: async (ws, action, input, project, sessionContext) => {
    // Intent expansion (Phase 2, 2026-08-03): read-only — updates remote-tracking refs, never
    // touches the working tree. Same immediate treatment as git_log/git_branch.
    executeCommand('git fetch', project.path, ws, project.id);
    return true;
  },

  git_remote_info: async (ws, action, input, project, sessionContext) => {
    // Phase 3 (2026-08-03): read-only `git remote -v` — same isGitRepo gate as git_diff.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. No remotes to show.` }));
    } else {
      executeCommand('git remote -v', project.path, ws, project.id);
    }
  },
};
