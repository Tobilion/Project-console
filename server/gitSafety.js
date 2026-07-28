import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

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

  try {
    await execAsync('git add -A', { cwd: projectPath });
    const commitMsg = `console-checkpoint: before "${trigger}"`;
    await execAsync(`git commit --allow-empty -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: projectPath });
    return { success: true, message: `Git checkpoint created: ${commitMsg}` };
  } catch (err) {
    return { success: false, message: `Failed to create git checkpoint: ${err.message}` };
  }
}

export async function performUndo(projectPath) {
  if (!(await isGitRepo(projectPath))) {
    return { success: false, message: 'This project is not a git repository. Undo checkpoint is not available.' };
  }

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
}
