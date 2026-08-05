import fs from 'fs/promises';
import path from 'path';

// Phase 14 PASS 3a (2026-08-05, spec console-chitchat-ai-upgrade-prompt.md §6 PASS 5.5 —
// "diff preview on the file-edit confirmation card", never implemented in that phase): a
// best-effort, line-based before/after preview attached to tool_confirm_prompt for the file
// tools (writeFile/editFile/insertAtLine/appendToFile), so the user can see what an AI-
// proposed edit actually changes BEFORE approving it. Pure read-only — never writes, never
// resolves outside the project root, and any failure returns null so the confirmation flow
// is never blocked or slowed by preview generation.

const MAX_SOURCE_LINES = 400; // LCS is O(n*m); skip previews for huge files
const MAX_DIFF_LINES = 60; // lines shown per side, with a "... N more" tail
const FILE_TOOLS = new Set(['writeFile', 'editFile', 'insertAtLine', 'appendToFile']);

/** LCS line diff — returns { removed, added } arrays (no unchanged lines), capped. */
export function diffLines(oldContent, newContent, maxLines = MAX_DIFF_LINES) {
  const a = (oldContent ?? '').split('\n');
  const b = (newContent ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i++]);
    } else {
      added.push(b[j++]);
    }
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  const cap = (arr) => (arr.length > maxLines ? { lines: arr.slice(0, maxLines), more: arr.length - maxLines } : { lines: arr, more: 0 });
  return { removed: cap(removed), added: cap(added) };
}

/** Compute the file content an edit tool call would produce, without writing anything. */
export function simulateEditContent(current, tool, args) {
  switch (tool) {
    case 'writeFile':
      return args?.content ?? null;
    case 'appendToFile':
      return current + ((args?.content ?? '') ? `\n${args.content}` : '');
    case 'insertAtLine': {
      const line = Number(args?.line);
      const lines = current.split('\n');
      if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) return null;
      lines.splice(line - 1, 0, args?.content ?? '');
      return lines.join('\n');
    }
    case 'editFile': {
      let content = current;
      const oldStrings = args?.oldStrings || (args?.oldString ? [args.oldString] : []);
      const newStrings = args?.newStrings || (args?.newString ? [args.newString] : []);
      if (!Array.isArray(oldStrings) || !Array.isArray(newStrings) || oldStrings.length !== newStrings.length) return null;
      for (let k = 0; k < oldStrings.length; k++) {
        const idx = content.indexOf(oldStrings[k]);
        if (idx === -1) return null; // exact-match only — mirrors tools.js's primary edit path
        content = content.slice(0, idx) + newStrings[k] + content.slice(idx + oldStrings[k].length);
      }
      return content;
    }
    default:
      return null;
  }
}

/** Best-effort full preview for a gated file-tool call. Returns null on any failure. */
export async function computeFileEditPreview(projectRoot, tool, args) {
  try {
    if (!projectRoot || !FILE_TOOLS.has(tool) || !args?.path) return null;
    const target = path.resolve(projectRoot, args.path);
    if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) return null;

    let current = '';
    try {
      current = await fs.readFile(target, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    if (current.split('\n').length > MAX_SOURCE_LINES) return null;

    const next = simulateEditContent(current, tool, args);
    if (next === null) return null;
    if (next.split('\n').length > MAX_SOURCE_LINES) return null;
    if (current === next) return null;

    const { removed, added } = diffLines(current, next);
    if (removed.lines.length === 0 && added.lines.length === 0) return null;
    return {
      path: args.path,
      removed: removed.lines,
      added: added.lines,
      removedMore: removed.more,
      addedMore: added.more,
      mode: current === '' ? 'create' : undefined,
    };
  } catch {
    return null;
  }
}
