import { exec } from 'child_process';
import util from 'util';
import { performUndo } from './gitSafety.js';
import { appendMemoryEntry } from './memoryStore.js';

const execAsync = util.promisify(exec);

/**
 * Project/git/memory info tools (Phase 14 split of toolFileTools.js, 2026-08-05 — bodies moved
 * verbatim). getGitStatus/undoLastChange operate on the bound project root; saveMemory writes
 * to .console/memory.md via memoryStore.js (importance 'judgment' is gated upstream by
 * isGatedToolCall in toolGate.js).
 */
export function createProjectInfoTools({ project, root }) {
  async function getProjectInfo() {
    return {
      success: true,
      data: {
        id: project.id,
        name: project.name,
        path: project.path,
        configEntries: project.config?.entries?.length || 0,
        docFiles: project.contextFiles?.length || 0,
        stack: project.parsedKnowledge?.stack?.trim() || null,
        commandsFound: project.parsedKnowledge?.commands?.trim() || null
      }
    };
  }

  async function getGitStatus() {
    try {
      const { stdout } = await execAsync('git status --short', { cwd: root });
      return { success: true, data: stdout.trim() || '(clean)' };
    } catch (err) {
      return { success: false, error: `Git status failed: ${err.message}` };
    }
  }

  async function undoLastChange() {
    return await performUndo(root);
  }

  /**
   * Persists a short, durable fact/preference/project note to this project's cross-session
   * memory file (.console/memory.md), so it's available in future AI-mode conversations, not
   * just this one. `importance: 'low'` runs immediately (see isGatedToolCall in toolGate.js —
   * only 'judgment' requires user approval first), by design: the point is the AI can jot down
   * low-stakes context (a preference, a project quirk, a correction) without interrupting the
   * conversation for a confirm click every time, while anything that reads as a real judgment
   * call about what's worth permanently remembering still gets a human checkpoint.
   */
  async function saveMemory({ content, importance } = {}) {
    if (!content) return { success: false, error: 'content is required.' };
    if (importance !== 'low' && importance !== 'judgment') {
      return { success: false, error: 'importance is required and must be "low" or "judgment".' };
    }
    return appendMemoryEntry(root, content);
  }

  return { getProjectInfo, getGitStatus, undoLastChange, saveMemory };
}
