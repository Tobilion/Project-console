import crypto from 'crypto';
import { performUndo, isGitRepo, pushCommandWithUpstream } from '../../gitSafety.js';
import { executeCommand } from '../../executor.js';
import { pendingConfirmations } from '../../state.js';
import { extractCommentMessage, assertSafeCommitMessage } from '../builtinHelpers.js';

/**
 * system.chit_chat.* git/command handlers (extracted verbatim from builtinChitChat.js).
 * `undo` is also reachable via the bare `'undo'` alias — the dispatcher maps it onto this
 * handler (key 'system.chit_chat.undo') before calling.
 */
export const toolsHandlers = {
  'system.chit_chat.undo': async (ws, action, input, project, sessionContext) => {
    const undoResult = await performUndo(project.path);
    if (undoResult.success) {
      ws.send(JSON.stringify({ type: 'answer', data: undoResult.message }));
    } else {
      // When the last commit isn't a console checkpoint, point the user at history/logs
      // so they can see what *is* revertible (the guard itself is correct — we just add UX).
      const hint = undoResult.message.includes('not a Console checkpoint')
        ? '\n\nTip: Try `show history` to see recent console actions, or `git log --oneline -5` to see commits. Only `console-checkpoint:` commits can be undone this way.'
        : '';
      ws.send(JSON.stringify({ type: 'error_output', data: undoResult.message + hint + '\n' }));
    }
  },

  'system.chit_chat.git_status': async (ws, action, input, project, sessionContext) => {
    executeCommand('git status --short', project.path, ws, project.id);
    return true;
  },

  'system.chit_chat.deploy': async (ws, action, input, project, sessionContext) => {
    // "Deploy" for Tobi's Vercel-connected projects is just "get my changes to GitHub" —
    // Vercel auto-deploys on push. If the user gave a custom comment ("push the site with
    // the comment 'bug fixes'"), commit with that message explicitly instead of relying on
    // the generic "console-checkpoint: before ..." auto-checkpoint — otherwise the comment
    // the user typed is silently discarded and never ends up in git history at all.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** isn't a git repository yet, so there's nothing to push. Run \`git init\`, add a remote, and push once manually — after that "deploy" will work here.`
      }));
    } else {
      const commitMsg = extractCommentMessage(input);
      const rejectReason = assertSafeCommitMessage(commitMsg);
      if (rejectReason) {
        ws.send(JSON.stringify({ type: 'answer', data: rejectReason }));
        return true;
      }
      const token = crypto.randomUUID();
      // pushCommandWithUpstream: a never-pushed branch would otherwise dead-end on the "no
      // upstream branch" fatal (the 2026-08-13 live failure) — the push part gains
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
        type: 'confirm_prompt',
        token,
        command: commitMsg
          ? `${command}  (commits with your comment, then pushes — Vercel deploys on push)`
          : `${command}  (pushes local commits to the remote repository)`,
        trigger: 'deploy'
      }));
    }
  },
};