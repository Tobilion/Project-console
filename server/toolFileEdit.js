import fs from 'fs/promises';
import { applySingleEdit } from './toolEdit.js';
import { invalidateProjectFiles } from './toolScan.js';

/**
 * The find-and-replace edit tool (Phase 14 split of toolFileTools.js, 2026-08-05 — body moved
 * verbatim). Single-pair oldString/newString OR multi-hunk oldStrings/newStrings, all-or-nothing.
 * `applySingleEdit` (toolEdit.js) tries an exact match first, then a whitespace-normalized
 * line-range fallback for smaller models that don't reproduce indentation byte-for-byte.
 */
export function createFileEditTool({ root, resolveSafe }) {
  async function editFile({ path: filePath, oldString, newString, oldStrings, newStrings } = {}) {
    if (!filePath) return { success: false, error: 'path is required.' };
    const hasMulti = Array.isArray(oldStrings) || Array.isArray(newStrings);
    if (hasMulti) {
      if (!Array.isArray(oldStrings) || !Array.isArray(newStrings) || oldStrings.length === 0 || oldStrings.length !== newStrings.length) {
        return { success: false, error: 'oldStrings and newStrings must be non-empty arrays of equal length.' };
      }
      for (const s of oldStrings) if (typeof s !== 'string') return { success: false, error: 'Every oldStrings entry must be a string.' };
      for (const s of newStrings) if (typeof s !== 'string') return { success: false, error: 'Every newStrings entry must be a string.' };
    } else {
      if (typeof oldString !== 'string' || typeof newString !== 'string') {
        return { success: false, error: 'oldString and newString are required.' };
      }
    }
    try {
      const resolved = resolveSafe(filePath);
      const original = await fs.readFile(resolved, 'utf-8');

      // Phase 5 (PASS 5.5): multi-hunk edits — pass oldStrings/newStrings arrays and every hunk
      // is applied in order against the same content, ALL-OR-NOTHING: if any hunk fails to match
      // (exact or whitespace-normalized), nothing is written and the error names the failing hunk,
      // so a partial edit can never be left half-applied on disk.
      if (hasMulti) {
        let content = original;
        let fallbackUsed = false;
        for (let i = 0; i < oldStrings.length; i++) {
          const attempt = applySingleEdit(content, oldStrings[i], newStrings[i]);
          if (!attempt) {
            return {
              success: false,
              error: `Hunk ${i + 1} of ${oldStrings.length} not found in ${filePath} (checked an exact match and a whitespace-tolerant fallback). ` +
                `No changes were written — call readFile("${filePath}") again and copy oldString(s) directly from the current contents before retrying.`,
            };
          }
          content = attempt.content;
          fallbackUsed = fallbackUsed || attempt.usedFallback;
        }
        if (content === original) {
          return { success: false, error: 'No changes made (replacement identical to original).' };
        }
        await fs.writeFile(resolved, content, 'utf-8');
        invalidateProjectFiles(root);
        const note = fallbackUsed ? ' (matched via whitespace-normalized fallback — verify the result looks right)' : '';
        return { success: true, data: `Edited ${filePath} (${oldStrings.length} hunk${oldStrings.length === 1 ? '' : 's'})${note}` };
      }

      const attempt = applySingleEdit(original, oldString, newString);
      if (!attempt) {
        return {
          success: false,
          error: `Text not found in ${filePath} (checked an exact match and a whitespace-tolerant fallback). ` +
            `The file may have changed since it was last read, or oldString doesn't reflect its real content — ` +
            `call readFile("${filePath}") again and copy oldString directly from the current contents before retrying.`,
        };
      }
      if (attempt.content === original) {
        return { success: false, error: 'No changes made (replacement identical to original).' };
      }
      await fs.writeFile(resolved, attempt.content, 'utf-8');
      invalidateProjectFiles(root);
      const note = attempt.usedFallback ? ' (matched via whitespace-normalized fallback — verify the result looks right)' : '';
      return { success: true, data: `Edited ${filePath}${note}` };
    } catch (err) {
      return { success: false, error: `Failed to edit file: ${err.message}` };
    }
  }

  return { editFile };
}
