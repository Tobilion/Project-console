// Pure edit-matching helpers for the file-edit tools (Phase 9 split, 2026-08-04 — extracted
// from tools.js; consumed by toolFileTools.js's editFile implementation). No fs access, no
// side effects — pure string/line matching, which is exactly what makes them unit-testable.

/** Collapse a line's leading/trailing whitespace and internal whitespace runs to one space, so
 * two lines that differ only in indentation or spacing compare equal. Used by editFile's
 * whitespace-tolerant fallback below. */
export function normalizeLine(line) {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Finds a contiguous block of `contentLines` whose normalized form matches `oldLines`'
 * normalized form exactly, returning the starting index or -1. This is a fallback for
 * editFile's exact-substring match — small local models frequently fail to reproduce a file's
 * exact whitespace/quoting when they compose an `oldString`, and normalized-line matching
 * recovers the common case (same text, different indentation/spacing) without falling back to
 * something as loose as fuzzy/similarity matching that could silently edit the wrong block.
 */
export function findNormalizedLineMatch(contentLines, oldLines) {
  if (oldLines.length === 0 || oldLines.length > contentLines.length) return -1;
  const normOld = oldLines.map(normalizeLine);
  for (let i = 0; i <= contentLines.length - normOld.length; i++) {
    let matched = true;
    for (let j = 0; j < normOld.length; j++) {
      if (normalizeLine(contentLines[i + j]) !== normOld[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/**
 * Phase 5 (PASS 5.5) — applies ONE hunk of an editFile request to a file's current content:
 * exact substring match first, then the whitespace-normalized line-range fallback (see
 * findNormalizedLineMatch). Returns { content, usedFallback } or null when neither match works.
 * Shared by the single-pair editFile path and the multi-hunk path so both behave identically.
 */
export function applySingleEdit(content, oldString, newString) {
  if (content.includes(oldString)) {
    const newContent = content.replace(oldString, newString);
    return { content: newContent, usedFallback: false };
  }
  const contentLines = content.split('\n');
  const oldLines = oldString.split('\n');
  const startLine = findNormalizedLineMatch(contentLines, oldLines);
  if (startLine === -1) return null;
  const before = contentLines.slice(0, startLine);
  const after = contentLines.slice(startLine + oldLines.length);
  return { content: [...before, ...newString.split('\n'), ...after].join('\n'), usedFallback: true };
}
