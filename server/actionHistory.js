// Phase 4 (2026-08-10): per-project action history. Append-only NDJSON log at
// `<project>/.console/action-history.jsonl` recording every mutating action the console
// executes: file writes/edits/inserts/appends (from any path — AI loop, direct tool calls,
// trigger-mode file ops) and confirmed/risky shell commands. Each file entry carries its
// pre-image inline so `revert action <id>` can restore exactly that action's before-state,
// including for entries far back in the log (no dependency on the aiGuardrails journal,
// which only keeps the most recent few pre-images).
//
// Revert is only ever the caller's decision: the admin tier gates file restores behind the
// standard confirm flow, and git/command entries are answer-only (the exact git command to
// run, computed against the live repo state at revert time — see revertAction).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import util from 'util';
import { exec } from 'child_process';
import { ensureGitignored } from './sessionMigration.js';
import { writeFileAtomicSync } from './atomicWrite.js';

const execAsync = util.promisify(exec);

const MAX_ACTIONS = 2000;
const AVG_LINE_BYTES = 220; // cap-trim heuristic; never counts lines on every append
const HISTORY_FILE_NAME = 'action-history.jsonl';

const ACTION_TYPES = new Set([
  'file_write',
  'file_edit',
  'file_insert',
  'file_append',
  'file_move',
  'command',
  'git',
  'revert',
]);

function historyFile(projectPath) {
  return path.join(projectPath, '.console', HISTORY_FILE_NAME);
}

/**
 * Append one action record. Entry fields: type (one of ACTION_TYPES), description (human
 * string shown in "show history"), plus type-specific extras: path/existed/preContent for
 * file actions, command for command/git actions, sessionId where the caller has one.
 * Returns the record id, or null when the write failed (never throws — history logging
 * must not break the action that produced it).
 */
export function appendAction(projectPath, entry) {
  if (!entry || !ACTION_TYPES.has(entry.type)) return null;
  const file = historyFile(projectPath);
  try {
    // Synchronous mkdir so the very first action on a fresh project can't lose the race
    // against ensureProjectConsoleDir's async mkdir (the .gitignore add is fire-and-forget —
    // it's a nicety, the mkdir is correctness).
    fs.mkdirSync(path.dirname(file), { recursive: true });
    void ensureGitignored(projectPath);
  } catch {
    // Project path unreadable or not writable — history is best-effort.
    return null;
  }
  const record = {
    id: crypto.randomUUID().slice(0, 8),
    ts: Date.now(),
    ...entry,
  };
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
    // Trim when the log is well past the cap: only then pay for a full read+rewrite.
    if (fs.statSync(file).size > MAX_ACTIONS * AVG_LINE_BYTES) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      if (lines.length > MAX_ACTIONS) {
        writeFileAtomicSync(file, lines.slice(-MAX_ACTIONS).join('\n') + '\n');
      }
    }
  } catch {
    return null;
  }
  return record.id;
}

/**
 * Most-recent-first list. Corrupt lines are skipped (never crash the list because one
 * write was torn). Returns [{id, ts, type, description, ...}].
 */
export function listActions(projectPath, { limit = 20, offset = 0 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(historyFile(projectPath), 'utf-8');
  } catch {
    return [];
  }
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  entries.reverse();
  return entries.slice(offset, offset + limit);
}

export function getAction(projectPath, id) {
  return listActions(projectPath, { limit: MAX_ACTIONS }).find((a) => a.id === id) || null;
}

function isSafeRelativePath(projectPath, relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  const abs = path.resolve(projectPath, relPath);
  const root = path.resolve(projectPath);
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Revert one action. Returns { ok: true, data } for a performed file restore, or
 * { ok: true, answerOnly: true, data } for git/command entries (no auto-run — the data is
 * the exact git command the user would run themselves), or { error }.
 */
export async function revertAction(projectPath, id) {
  const action = getAction(projectPath, id);
  if (!action) {
    return { error: `No action with id "${id}" found in this project's history.` };
  }

  if (action.type === 'revert') {
    return { ok: true, answerOnly: true, data: `Action ${id} is itself a revert record — there is nothing to undo there.` };
  }

  // Phase 2 (2026-08-11): file moves (general-mode tidy) undo by moving the file back to its
  // original path. Refuses when the destination is already occupied (never overwrite a live
  // file to undo an old move) or the moved copy is gone.
  if (action.type === 'file_move') {
    if (!isSafeRelativePath(projectPath, action.from) || !isSafeRelativePath(projectPath, action.to)) {
      return { error: `Action ${id} has an unsafe path — refusing to restore.` };
    }
    const fromAbs = path.resolve(projectPath, action.from);
    const toAbs = path.resolve(projectPath, action.to);
    try {
      if (!fs.existsSync(toAbs)) {
        return { error: `Action ${id} moved a file that no longer exists at ${action.to} — nothing to undo.` };
      }
      if (fs.existsSync(fromAbs)) {
        return { error: `Action ${id} already has a file at ${action.from} — refusing to overwrite it.` };
      }
      fs.renameSync(toAbs, fromAbs);
    } catch (err) {
      return { error: `Restore failed: ${err.message}` };
    }
    appendAction(projectPath, {
      type: 'revert',
      description: `Reverted action ${id}: moved ${action.to} back to ${action.from}`,
      path: action.from,
    });
    return {
      ok: true,
      data: `Moved ${action.to} back to ${action.from}.`,
    };
  }

  if (action.type.startsWith('file_')) {
    if (!isSafeRelativePath(projectPath, action.path)) {
      return { error: `Action ${id} has an unsafe path (${action.path}) — refusing to restore.` };
    }
    const abs = path.resolve(projectPath, action.path);
    try {
      if (action.existed) {
        if (typeof action.preContent !== 'string') {
          return { error: `Action ${id} has no pre-image to restore from.` };
        }
        fs.writeFileSync(abs, action.preContent, 'utf-8');
      } else {
        fs.rmSync(abs, { force: true });
      }
    } catch (err) {
      return { error: `Restore failed: ${err.message}` };
    }
    appendAction(projectPath, {
      type: 'revert',
      description: `Reverted action ${id}: ${action.existed ? 'restored' : 'deleted'} ${action.path}`,
      path: action.path,
    });
    return {
      ok: true,
      data: action.existed
        ? `Restored ${action.path} to its state before action ${id}.`
        : `Deleted ${action.path} (it did not exist before action ${id}).`,
    };
  }

  // git / command: answer-only, checkpoint-aware. A console checkpoint is a commit whose
  // message starts with "console-checkpoint:" (gitSafety.js); when that commit is still the
  // repo's HEAD, reset --hard HEAD~1 is the exact safe undo the console itself would run.
  let topCommit = null;
  try {
    const { stdout } = await execAsync('git log -1 --pretty=%B', { cwd: projectPath, windowsHide: true });
    topCommit = stdout.trim();
  } catch {
    // Not a git repo (or no commits) — fall through to generic advice.
  }

  const cmd = (action.command || action.description || '').toLowerCase();
  if (topCommit && topCommit.startsWith('console-checkpoint:')) {
    return {
      ok: true,
      answerOnly: true,
      data:
        `This action is a git change, and the repo's latest commit is still the automatic checkpoint ` +
        `created before it. To undo it yourself:\n\n    git reset --hard HEAD~1\n\n` +
        `Only run this if no other commit has been made since.`,
    };
  }
  if (cmd.includes('push')) {
    return {
      ok: true,
      answerOnly: true,
      data:
        `This action pushed to a remote, so history may already be shared — there is no safe ` +
        `automatic revert. If it was a mistake, undo it with a new commit:\n\n    git revert <sha>\n\n` +
        `Find the sha in "git log".`,
    };
  }
  if (cmd.includes('commit')) {
    return {
      ok: true,
      answerOnly: true,
      data:
        `This action committed. If it is the latest commit and you want to undo it while keeping ` +
        `your changes:\n\n    git reset --soft HEAD~1\n\n` +
        `If it is not the latest commit, use "git revert <sha>" (find it in "git log") — never ` +
        `reset past newer commits.`,
    };
  }
  return {
    ok: true,
    answerOnly: true,
    data:
      `This action is a git/command change with no safe automatic revert. Undo it manually — ` +
      `e.g. with "git revert <sha>" for a committed change, or by re-editing the affected files. ` +
      `The console never rewrites history on its own.`,
  };
}
