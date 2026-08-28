import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec, execFile } from 'child_process';
import util from 'util';
import { Mutex } from 'async-mutex';

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// Per-project mutex for git operations that touch the index (add/commit/reset).
// Concurrent checkpoints on the same repo race on .git/index.lock — the second `git add -A`
// fails with "Unable to create index.lock" (reproduced via concurrent Promise.all in
// partB-concurrency.mjs, 2026-08-28). JS is single-threaded but async ops interleave at
// await points, so two checkpoints can interleave between `git add` and `git commit`.
// The mutex serializes the whole add+commit sequence per project path (case-insensitive on
// win32, where the same folder can be referenced with different casing).
const checkpointMutexes = new Map();
function getCheckpointMutex(projectPath) {
  const key = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  if (!checkpointMutexes.has(key)) checkpointMutexes.set(key, new Mutex());
  return checkpointMutexes.get(key);
}

export async function isGitRepo(projectPath) {
  try {
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', { cwd: projectPath });
    return stdout.trim() === 'true';
  } catch (err) {
    return false;
  }
}

export async function createCheckpoint(projectPath, trigger) {
  if (!(await isGitRepo(projectPath))) {
    return { success: false, message: 'Project is not a git repository. Skipping git checkpoint.' };
  }
  const mutex = getCheckpointMutex(projectPath);
  return mutex.runExclusive(async () => {
    const tmpFile = path.join(os.tmpdir(), `console-checkpoint-${crypto.randomUUID()}.txt`);
    try {
      await execAsync('git add -A', { cwd: projectPath });
      const commitMsg = `console-checkpoint: before "${trigger}"`;
      // -F tempfile instead of `git commit -m "..."` interpolation: the trigger can contain
      // double quotes (a user's quoted commit message riding a deploy/push confirm), and cmd.exe
      // does not honor \" escaping, so the interpolated -m used to fail with a confusing
      // "[GIT SAFETY] Failed to create git checkpoint" warning (live-probed 2026-08-18). -F
      // passes the message out-of-band through execFile — no shell ever parses the trigger text.
      fs.writeFileSync(tmpFile, commitMsg, 'utf8');
      await execFileAsync('git', ['commit', '--allow-empty', '-F', tmpFile], { cwd: projectPath });
      return { success: true, message: `Git checkpoint created: ${commitMsg}` };
    } catch (err) {
      return { success: false, message: `Failed to create git checkpoint: ${err.message}` };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });
}

/**
 * Builds a push command that cannot fail with "no upstream branch": when the checked-out
 * branch has no tracking remote, the push is rewritten as `git push --set-upstream <remote>
 * <branch>` (the command git itself suggests), so a first push of a new branch succeeds in
 * one step. Used by the console's own push builders (deploy / git_push / git_commit_push);
 * typed commands run exactly as typed and rely on executorGitRetry's one-click suggestion
 * instead. Returns the input unchanged on any failure, on a detached HEAD, or when the
 * branch already tracks an upstream. Branch and remote names come from git itself (refname
 * charset), so interpolating them into a shell command is safe.
 */
export async function pushCommandWithUpstream(cwd, pushCommand = 'git push') {
  try {
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = branchOut.trim();
    if (!branch || branch === 'HEAD') return pushCommand; // detached HEAD — leave alone
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', '@{u}'], { cwd });
      return pushCommand; // already tracks an upstream
    } catch {
      const { stdout: remotesOut } = await execFileAsync('git', ['remote'], { cwd });
      const remote = remotesOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || 'origin';
      return `${pushCommand} --set-upstream ${remote} ${branch}`;
    }
  } catch {
    return pushCommand;
  }
}

export async function performUndo(projectPath) {
  if (!(await isGitRepo(projectPath))) {
    return { success: false, message: 'This project is not a git repository. Undo checkpoint is not available.' };
  }
  const mutex = getCheckpointMutex(projectPath);
  return mutex.runExclusive(async () => {
    try {
      const { stdout: commitMsg } = await execAsync('git log -1 --pretty=%B', { cwd: projectPath });
      const trimmedMsg = commitMsg.trim();

      if (!trimmedMsg.startsWith('console-checkpoint:')) {
        const topCommitFirstLine = trimmedMsg.split('\n')[0];
        return {
          success: false,
          message: `Undo refused: The last commit ("${topCommitFirstLine}") is not a Console checkpoint. Aborting undo to protect your work.`
        };
      }

      await execAsync('git reset --hard HEAD~1', { cwd: projectPath });
      return {
        success: true,
        message: `Undo successful! Restored pre-command state from checkpoint: "${trimmedMsg.split('\n')[0]}"`
      };
    } catch (err) {
      return { success: false, message: `Undo failed: ${err.message}` };
    }
  });
}
