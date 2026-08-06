import crypto from 'crypto';
import { isGitRepo } from '../gitSafety.js';
import { pendingConfirmations } from '../state.js';
import { extractCommentMessage } from './builtinHelpers.js';

/**
 * Commit/push handlers (Phase 14 split of builtinGit.js, 2026-08-05 — bodies moved verbatim).
 * All three share the extractCommentMessage flow — the shared quote-aware comment parser from
 * the 2026-07-29 commit-truncation fix, so "push with comment 'bug fixes' ... and ..." keeps
 * the full quoted message on every path that can win the match.
 */
export const gitWorkflowHandlers = {
  git_push: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then add a remote origin.` }));
    } else {
      // "push the site with the comment 'bug fixes'" can match this plain git_push intent
      // instead of system.chit_chat.deploy (their example phrases overlap heavily — both are
      // full of "push ..." variants), and this branch used to always push bare, silently
      // dropping any comment the user typed. Parse it the same way deploy does so the comment
      // isn't lost regardless of which of the two intents wins the match.
      const commitMsg = extractCommentMessage(input);
      const token = crypto.randomUUID();
      const command = commitMsg
        ? `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`
        : 'git push';
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: commitMsg
          ? `git add -A && git commit -m "${commitMsg}" && git push  (commits with your comment, then pushes)`
          : 'git push (pushes local commits to the remote repository)',
        trigger: 'git_push'
      }));
    }
  },

  git_commit: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first.` }));
    } else {
      // Extract a commit message from the user's input if possible
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `git add -A && git commit -m "${commitMsg}" (stages all and commits)`,
        trigger: 'git_commit'
      }));
    }
  },

  git_commit_push: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then add a remote origin.` }));
    } else {
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `git add -A && git commit -m "${commitMsg}" && git push (stages all, commits, and pushes)`,
        trigger: 'git_commit_push'
      }));
    }
  },
};
