import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';
import { isGitRepo } from '../gitSafety.js';
import { pendingConfirmations } from '../state.js';

const execAsync = util.promisify(exec);

// Branch names that must never be offered for cleanup even if `git branch --merged` lists them —
// deleting the branch you're currently on isn't possible anyway (git refuses it), but the common
// long-lived integration branches are excluded defensively so a fresh repo with an unusual default
// branch name doesn't accidentally nominate its own trunk.
const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'development']);

/**
 * Phase 5 intent taxonomy expansion (audit 2026-08-10, §4 rows 1 and 20): two git-family
 * handlers that need more than a single raw command — branch cleanup requires computing which
 * branches are safe to offer before asking for confirmation, and the PR-readiness check is a
 * composite of several git queries collapsed into one plain-language answer. Split out of
 * builtinGit.js's other leaves since neither fits the "one command, one leaf" shape those use.
 */
export const gitMaintenanceHandlers = {
  git_branch_cleanup: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
      return true;
    }
    let current = '';
    let merged = [];
    try {
      const cur = await execAsync('git branch --show-current', { cwd: project.path });
      current = cur.stdout.trim();
      const mrg = await execAsync('git branch --merged', { cwd: project.path });
      merged = mrg.stdout.split('\n')
        .map((l) => l.replace(/^\*?\s+/, '').trim())
        .filter((name) => name && name !== current && !PROTECTED_BRANCH_NAMES.has(name.toLowerCase()));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Could not check merged branches: ${err.message}\n` }));
      return true;
    }
    if (merged.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No merged branches to clean up in **[${project.name}]** — everything besides \`${current}\` is either unmerged or protected.` }));
      return true;
    }
    // git accepts multiple names on one `-d`; each name is a validated existing local branch from
    // `git branch --merged`'s own output, not user-supplied text, so no shell-metacharacter risk.
    const token = crypto.randomUUID();
    const command = `git branch -d ${merged.map((b) => `"${b}"`).join(' ')}`;
    pendingConfirmations.set(token, {
      owner: ws, projectId: project.id, command, trigger: input, createdAt: Date.now(),
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: `${command}  (deletes ${merged.length} branch(es) already merged into ${current}: ${merged.join(', ')})`,
      trigger: 'git_branch_cleanup',
    }));
    return true;
  },

  git_pr_ready_check: async (ws, action, input, project, sessionContext) => {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
      return true;
    }
    const issues = [];
    let branch = '';
    try {
      const status = await execAsync('git status --porcelain', { cwd: project.path });
      const dirty = status.stdout.trim().length > 0;
      if (dirty) issues.push('you have uncommitted changes');

      const sb = await execAsync('git status -sb', { cwd: project.path });
      const header = sb.stdout.split('\n')[0] || '';
      branch = (header.match(/^##\s+([^.\s]+)/) || [, ''])[1];
      const aheadMatch = header.match(/ahead (\d+)/);
      const behindMatch = header.match(/behind (\d+)/);
      const ahead = aheadMatch ? parseInt(aheadMatch[1], 10) : 0;
      const behind = behindMatch ? parseInt(behindMatch[1], 10) : 0;
      if (!header.includes('...')) issues.push('this branch has no upstream/tracking branch set — push it first');
      if (behind > 0) issues.push(`you're ${behind} commit(s) behind the remote branch — pull or rebase first`);

      let msg = `### PR readiness — [${project.name}]\n\n`;
      if (issues.length === 0) {
        msg += `Looks ready. \`${branch}\` is clean${ahead > 0 ? ` and ${ahead} commit(s) ahead of the remote` : ''}, with no uncommitted changes.`;
      } else {
        msg += `Not quite ready yet:\n\n${issues.map((i) => `- ${i}`).join('\n')}`;
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Could not run the PR readiness check: ${err.message}\n` }));
    }
    return true;
  },
};
