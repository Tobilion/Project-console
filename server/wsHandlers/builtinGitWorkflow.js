import crypto from 'crypto';
import { isGitRepo, pushCommandWithUpstream } from '../gitSafety.js';
import { pendingConfirmations } from '../state.js';
import { extractCommentMessage, assertSafeCommitMessage } from './builtinHelpers.js';

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
      const rejectReason = assertSafeCommitMessage(commitMsg);
      if (rejectReason) {
        ws.send(JSON.stringify({ type: 'answer', data: rejectReason }));
        return true;
      }
      const token = crypto.randomUUID();
      // pushCommandWithUpstream: a branch that has never been pushed would otherwise dead-end
      // on the "no upstream branch" fatal (the 2026-08-13 live failure) — the push part gains
      // --set-upstream so a first push succeeds in one step (2026-08-18).
      const command = commitMsg
        ? await pushCommandWithUpstream(project.path, `git add -A && git commit -m "${commitMsg}" && git push`)
        : await pushCommandWithUpstream(project.path, 'git push');
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
          ? `${command}  (commits with your comment, then pushes)`
          : `${command}  (pushes local commits to the remote repository)`,
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
      const rejectReason = assertSafeCommitMessage(commitMsg);
      if (rejectReason) {
        ws.send(JSON.stringify({ type: 'answer', data: rejectReason }));
        return true;
      }
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg}"`,
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
      const rejectReason = assertSafeCommitMessage(commitMsg);
      if (rejectReason) {
        ws.send(JSON.stringify({ type: 'answer', data: rejectReason }));
        return true;
      }
      const token = crypto.randomUUID();
      const command = await pushCommandWithUpstream(project.path, `git add -A && git commit -m "${commitMsg}" && git push`);
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `${command}  (stages all, commits, and pushes)`,
        trigger: 'git_commit_push'
      }));
    }
  },
};
