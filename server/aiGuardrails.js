import fs from 'fs/promises';
import path from 'path';
import { AST_CAPABLE_EXTS } from './codebaseData.js';
import { getTsModule, scriptKindFor } from './codebaseParsers.js';
import { simulateEditContent } from './diffPreview.js';

/**
 * AI write-path guards (Phase 1, Part 1.2 — "don't let the model break the code silently"):
 *
 *  - syntaxCheck: parse-level validation of JS/TS-family content via the `typescript` compiler
 *    (same lazy module as codebaseParsers). Parse diagnostics only — semantic/type diagnostics
 *    need a full program and would false-positive on partial files mid-edit. Never a hard
 *    requirement: returns null when typescript is unavailable, and every caller treats null
 *    as "no information".
 *  - validateToolCall: pre-execution guard run by the tool callers (aiQueryToolRun.js /
 *    connectionToolCall.js) for the four file-mutating tools. Simulates the edit in memory,
 *    syntax-checks the result, and — when the edit would break parsing — journals the file's
 *    pre-edit content (first-write-wins per file, so a restore always goes back to the state
 *    before the FIRST breaking edit) and returns a warning that rides on the tool result the
 *    model sees. Warns, never blocks: the approval gates are the only thing that can stop a
 *    write.
 *  - restorePreImage: the journal's consumer — restores (or deletes, for a file that didn't
 *    exist) the pre-edit content. Wired into the undoLastChange tool so the model can undo a
 *    breaking edit even in projects with no git repo.
 */

/**
 * The four tools whose success should kick off the background type-check verification
 * (verifyHarness.js). Exported so the AI-direct and frontend tool-call paths attach the same
 * hook without redefining the set.
 */
export const FILE_MUTATING_TOOLS = new Set(['writeFile', 'editFile', 'insertAtLine', 'appendToFile']);
const MAX_JOURNAL_ENTRIES = 50;

/** resolvedPath -> { content, existed, recordedAt } (insertion-ordered; oldest dropped first). */
const journal = new Map();

/**
 * Parse-level syntax check for JS/TS-family content. Returns { ok: true }, { ok: false, line,
 * message }, or null when the extension isn't syntax-checkable or typescript is unavailable.
 */
export async function syntaxCheck(content, ext) {
  if (typeof content !== 'string' || !AST_CAPABLE_EXTS.has(ext)) return null;
  const TS = await getTsModule();
  if (!TS) return null;
  try {
    const sourceFile = TS.createSourceFile(`file${ext}`, content, TS.ScriptTarget.Latest, false, scriptKindFor(TS, ext));
    const diag = sourceFile.parseDiagnostics[0];
    if (!diag) return { ok: true };
    const line = TS.getLineAndCharacterOfPosition(sourceFile, diag.start).line + 1;
    return { ok: false, line, message: TS.flattenDiagnosticMessageText(diag.messageText, ' ') };
  } catch {
    return null;
  }
}

/** Records the pre-edit content of a file (first write wins; the journal never overwrites). */
export function recordPreImage(resolvedPath, content, existed) {
  if (journal.has(resolvedPath)) return false;
  journal.set(resolvedPath, { content, existed, recordedAt: Date.now() });
  if (journal.size > MAX_JOURNAL_ENTRIES) {
    journal.delete(journal.keys().next().value);
  }
  return true;
}

export function getPreImage(resolvedPath) {
  return journal.get(resolvedPath)?.content ?? null;
}

export function clearPreImage(resolvedPath) {
  journal.delete(resolvedPath);
}

/**
 * Pre-execution guard for the file-mutating tools. Returns null when nothing is worth flagging
 * (non-file tool, un-simulatable edit, clean syntax, non-JS/TS file, or containment failure —
 * the sandbox rejects escapes anyway), or { ok: true, warning } when the simulated edit breaks
 * parsing and the pre-edit content was journaled.
 */
export async function validateToolCall(tool, args, root) {
  if (!root || !FILE_MUTATING_TOOLS.has(tool) || !args?.path) return null;
  const ext = path.extname(args.path).toLowerCase();
  if (!AST_CAPABLE_EXTS.has(ext)) return null;
  try {
    const resolved = path.resolve(root, args.path);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

    let current = '';
    let existed = true;
    try {
      current = await fs.readFile(resolved, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      existed = false;
    }

    const next = simulateEditContent(current, tool, args);
    if (next === null || next === current) return null;

    const check = await syntaxCheck(next, ext);
    if (!check || check.ok) return null;

    recordPreImage(resolved, current, existed);
    return {
      ok: true,
      warning: `SYNTAX WARNING in ${args.path} (line ${check.line}): ${check.message} — the change was applied, but the file may not parse. ` +
        `The pre-edit content is journaled; call undoLastChange with path: "${args.path}" to restore it if needed.`,
    };
  } catch {
    return null;
  }
}

/**
 * Restores a journaled pre-edit file (or deletes a file that didn't exist before the edit).
 * Returns { success: false, error } when the path is outside the root or has no journal entry.
 */
export async function restorePreImage(resolvedPath, root) {
  const entry = journal.get(resolvedPath);
  const inside = root && (resolvedPath === root || resolvedPath.startsWith(root + path.sep));
  const rel = path.relative(root, resolvedPath).split(path.sep).join('/') || path.basename(resolvedPath);
  if (!inside) return { success: false, error: 'Path is outside the project root.' };
  if (!entry) return { success: false, error: `No journaled pre-edit content for ${rel}.` };

  try {
    if (entry.existed) {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, entry.content, 'utf-8');
      clearPreImage(resolvedPath);
      return { success: true, data: `Restored ${rel} from the pre-edit journal.` };
    }
    await fs.rm(resolvedPath, { force: true });
    clearPreImage(resolvedPath);
    return { success: true, data: `Removed ${rel} (it did not exist before the edit).` };
  } catch (err) {
    return { success: false, error: `Restore failed: ${err.message}` };
  }
}
