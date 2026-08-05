import crypto from 'crypto';
import { isGitRepo } from '../gitSafety.js';
import { executeCommand } from '../executor.js';
import { pendingConfirmations } from '../state.js';
import { isSafeParamValue } from '../paramCommand.js';
import { extractCommentMessage } from './builtinHelpers.js';

/**
 * Git intent handlers (Phase 10 step 2, extracted verbatim from builtinIntents.js).
 * Full (ws, action, input, project, sessionContext) signature for uniform dispatch.
 * `git_status` intentionally lives with the chit-chat set in builtinIntents.js.
 */
export const gitHandlers = {
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

  git_commit: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first.` }));
    } else {
      // Extract a commit message from the user's input if possible
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
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

  git_stash: async (ws, action, input, project, sessionContext) => {
    // New (2026-07-30, requested directly). Confirm-gated even though `git stash` is technically
    // reversible via `git stash pop` — it can look like uncommitted work "disappeared" from the
    // working tree, which is exactly the kind of surprising-but-recoverable action this app's
    // existing safety model (see CLAUDE.md) already requires a confirm step for.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { projectId: project.id, command: 'git stash', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash (shelves uncommitted changes — restore later with "git stash pop")', trigger: 'git_stash' }));
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

  git_stash_pop: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { projectId: project.id, command: 'git stash pop', trigger: input, createdAt: Date.now() });
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
        pendingConfirmations.set(token, { projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates and switches to a new branch)`, trigger: 'git_branch_create' }));
      }
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

  git_ahead_behind: async (ws, action, input, project, sessionContext) => {
    // Intent expansion (Phase 2, 2026-08-03): "am I behind origin" — git status -sb prints the
    // "[origin/main: ahead 2, behind 1]" line directly; no parsing needed. Read-only, immediate.
    executeCommand('git status -sb', project.path, ws, project.id);
    return true;
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
        pendingConfirmations.set(token, { projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates a tag on the current commit)`, trigger: 'git_tag' }));
      }
    }
  },

  git_remote_info: async (ws, action, input, project, sessionContext) => {
    // Phase 3 (2026-08-03): read-only `git remote -v` — same isGitRepo gate as git_diff.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. No remotes to show.` }));
    } else {
      executeCommand('git remote -v', project.path, ws, project.id);
    }
  }
};
