import fs from 'fs/promises';
import path from 'path';
import { ensureGitignored } from './conversationStore.js';
import { getTuning } from './tuningStore.js';

// User-authored scratch notes, stored at <project>/.console/notes.md — a THIRD store,
// deliberately distinct from memoryStore.js (AI-authored durable facts in memory.md) and
// projectMemoryStore.js (JSON usage patterns). notes.md is user text only: never written by
// the AI, never injected into the AI system prompt unless the user explicitly asks for it
// read back. Same .console/ + gitignore treatment as memory.md.
const NOTES_DIR = '.console';
const NOTES_FILE = 'notes.md';
// F-5(1) (2026-09-10): recycle bin — deleted notes move here (same line format as
// notes.md) instead of vanishing, so a delete is always recoverable until the user
// explicitly empties the trash. No format migration: old installs simply start with
// an absent (empty) trash file.
const TRASH_FILE = 'notes.trash.md';

const MAX_ENTRIES = 200;
const MAX_ENTRY_CHARS = 1000;

// B.3 (2026-09-09): the entry cap is a live tuning knob (Settings → Advanced → Tuning);
// the exported const above stays the documented default (see tuningStore.js).
function maxEntries() {
  return getTuning('MAX_NOTES_ENTRIES', MAX_ENTRIES);
}

// Per-project promise chain serializing appendNote's read-modify-write (same reasoning as
// memoryStore.js's lock: two concurrent writes would both read the base file and last-writer-
// wins would drop an entry).
const noteWriteChains = new Map();

function withNoteLock(projectPath, fn) {
  const prev = noteWriteChains.get(projectPath) || Promise.resolve();
  const next = prev.then(fn, fn);
  noteWriteChains.set(projectPath, next);
  return next;
}

function notesPath(projectPath) {
  return path.join(projectPath, NOTES_DIR, NOTES_FILE);
}

function trashPath(projectPath) {
  return path.join(projectPath, NOTES_DIR, TRASH_FILE);
}

function parseNoteLines(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return [];
  return trimmed.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^- (.*?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?$/);
    return { text: m ? m[1] : line, date: m && m[2] ? m[2] : null, raw: line };
  });
}

// Twin-safe index lookup shared by deleteNote (live list) and restoreTrash (trash
// list): a dated input matches exactly one dated line; a dateless input matches by
// text alone. Returns { removeIdx } on a hit, { removeIdx: -1 } on a miss, or
// { ambiguous: [dated candidate strings] } when several lines share the text —
// callers render their own message from the candidates but must never remove.
function findNoteIndex(lines, target) {
  const stripAuthor = (l) => l.replace(/^- /, '').replace(/\s*· by .+$/, '');
  const stripDate = (l) => l.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '');
  const datedHits = [];
  const datelessHits = [];
  lines.forEach((line, idx) => {
    const noAuthor = stripAuthor(line);
    if (normalize(noAuthor) === target) datedHits.push(idx);
    else if (normalize(stripDate(noAuthor)) === target) datelessHits.push(idx);
  });
  if (datedHits.length === 1) return { removeIdx: datedHits[0] };
  if (datedHits.length === 0 && datelessHits.length === 1) return { removeIdx: datelessHits[0] };
  const ambiguous = datedHits.length > 1 ? datedHits : datelessHits;
  if (ambiguous.length > 1) {
    return { ambiguous: ambiguous.map((i) => stripAuthor(lines[i])) };
  }
  return { removeIdx: -1 };
}

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Raw file content, or '' if no notes yet. */
export async function readNotes(projectPath) {
  try {
    return await fs.readFile(notesPath(projectPath), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Parsed notes, oldest first: [{ text, date }]. */
export async function listNotes(projectPath) {
  const content = (await readNotes(projectPath)).trim();
  if (!content) return [];
  return parseNoteLines(content).map(({ text, date }) => ({ text, date }));
}

/** Parsed trash contents, oldest first: [{ text, date }]. Empty when never deleted. */
export async function listTrash(projectPath) {
  let content = '';
  try {
    content = await fs.readFile(trashPath(projectPath), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return parseNoteLines(content).map(({ text, date }) => ({ text, date }));
}

/** Replace one note's text in place (F-6: the panel's save-on-blur used to APPEND
 *  the edited text as a fresh line, orphaning the old version). Twin-safe via
 *  findNoteIndex (ambiguity refuses, same as delete/restore); refuses when the new
 *  text duplicates ANOTHER line (appendNote would skip it as a dupe) and no-ops when
 *  nothing changed. The line's date/author suffix is preserved — only the text body
 *  is swapped. Returns { success, data } with the new text on success. */
export async function replaceNoteText(projectPath, oldText, newText) {
  const target = normalize(oldText || '');
  const trimmed = (newText || '').trim();
  if (!target) return { success: false, error: 'Nothing to replace — pick a note first.' };
  if (!trimmed) return { success: false, error: 'The replacement text is empty — nothing saved.' };
  if (trimmed.length > MAX_ENTRY_CHARS) {
    return { success: false, error: `Note is too long (${MAX_ENTRY_CHARS} char max) — split it up.` };
  }

  return withNoteLock(projectPath, async () => {
    const filePath = notesPath(projectPath);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return { success: false, error: 'No notes here yet.' };
      throw err;
    }
    const lines = content.split('\n').filter((l) => l.trim());
    const found = findNoteIndex(lines, target);
    if (found.ambiguous) {
      const options = found.ambiguous.map((s) => `"${s}"`).join(', ');
      return { success: false, error: `${found.ambiguous.length} notes match (${options}) — include the date to edit just one.` };
    }
    if (found.removeIdx === -1) return { success: false, error: 'No note matched that text.' };

    const stripAuthor = (l) => l.replace(/^- /, '').replace(/\s*· by .+$/, '');
    const stripDate = (l) => l.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '');
    const textOf = (l) => normalize(stripDate(stripAuthor(l)));
    if (textOf(lines[found.removeIdx]) === normalize(trimmed)) {
      return { success: true, data: 'No changes.' };
    }
    if (lines.some((l, idx) => idx !== found.removeIdx && textOf(l) === normalize(trimmed))) {
      return { success: false, error: 'That text already exists as another note — nothing changed.' };
    }

    const raw = lines[found.removeIdx];
    const m = raw.match(/^(- )(.*?)((?:\s+\(\d{4}-\d{2}-\d{2}\))?(?:\s*· by .+)?)$/);
    lines[found.removeIdx] = m ? `- ${trimmed}${m[3]}` : `- ${trimmed} (${new Date().toISOString().slice(0, 10)})`;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await ensureGitignored(projectPath);
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
    return { success: true, data: trimmed };
  });
}

/** Permanently drop every trashed note. Returns { success, count }. */
export async function emptyTrash(projectPath) {
  return withNoteLock(projectPath, async () => {
    const trashed = await listTrash(projectPath);
    await fs.mkdir(path.dirname(trashPath(projectPath)), { recursive: true });
    await ensureGitignored(projectPath);
    await fs.writeFile(trashPath(projectPath), '', 'utf-8');
    return { success: true, count: trashed.length };
  });
}

/** Move one trashed note back to the live list (same twin-safe match as deleteNote).
 *  Refuses when the live list already holds that exact line, so a restore can never
 *  silently twin a note that was re-created after the delete. */
export async function restoreTrash(projectPath, noteText) {
  const target = normalize(noteText || '');
  if (!target) return { success: false, error: 'Nothing to restore — give me the note text.' };

  return withNoteLock(projectPath, async () => {
    let trashContent = '';
    try {
      trashContent = await fs.readFile(trashPath(projectPath), 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return { success: false, error: 'The recycle bin is empty.' };
      throw err;
    }
    const trashLines = trashContent.split('\n').filter((l) => l.trim());
    const found = findNoteIndex(trashLines, target);
    if (found.ambiguous) {
      const options = found.ambiguous.map((s) => `"${s}"`).join(', ');
      return { success: false, error: `${found.ambiguous.length} deleted notes match (${options}) — include the date to restore just one.` };
    }
    if (found.removeIdx === -1) return { success: false, error: 'No deleted note matched that text.' };

    const rawLine = trashLines[found.removeIdx];
    let liveContent = '';
    try {
      liveContent = await fs.readFile(notesPath(projectPath), 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const liveLines = liveContent.split('\n').filter((l) => l.trim());
    if (liveLines.some((l) => normalize(l) === normalize(rawLine))) {
      return { success: false, error: 'That note is already back in your notes — nothing to restore.' };
    }
    liveLines.push(rawLine);
    const keptTrash = trashLines.filter((_, idx) => idx !== found.removeIdx);

    await fs.mkdir(path.dirname(notesPath(projectPath)), { recursive: true });
    await ensureGitignored(projectPath);
    await fs.writeFile(notesPath(projectPath), (liveLines.length ? liveLines.join('\n') + '\n' : ''), 'utf-8');
    await fs.writeFile(trashPath(projectPath), (keptTrash.length ? keptTrash.join('\n') + '\n' : ''), 'utf-8');
    return { success: true, data: rawLine.replace(/^- /, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '') };
  });
}

/** Append one user-authored note. Exact-duplicate lines (whitespace/case-normalized) are
 *  skipped; the list is capped at MAX_ENTRIES, oldest dropped first. Phase 19: `createdBy`
 *  defaults to "local" (single-user notes are unchanged). */
export async function appendNote(projectPath, content, createdBy = 'local') {
  const trimmed = (content || '').trim();
  if (!trimmed) return { success: false, error: 'Nothing to note — write some text after "note:".' };
  if (trimmed.length > MAX_ENTRY_CHARS) {
    return { success: false, error: `Note is too long (${MAX_ENTRY_CHARS} char max) — split it up.` };
  }

  return withNoteLock(projectPath, async () => {
    const filePath = notesPath(projectPath);
    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const lines = existing.split('\n').filter((l) => l.trim());
    const target = normalize(trimmed);
    const isDuplicate = lines.some((l) => normalize(l.replace(/^- /, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '')) === target);
    if (isDuplicate) {
      return { success: true, data: 'Already noted (duplicate skipped).' };
    }

    const date = new Date().toISOString().slice(0, 10);
    const author = createdBy && createdBy !== 'local' ? ` · by ${createdBy}` : '';
    lines.push(`- ${trimmed} (${date})${author}`);
    const capped = lines.slice(-maxEntries());

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await ensureGitignored(projectPath);
    await fs.writeFile(filePath, capped.join('\n') + '\n', 'utf-8');
    return { success: true, data: `Note added: ${trimmed}`, id: target };
  });
}

/** Delete one user-authored note by exact text. Returns { success, data } — the note's
 *  pre-delete text on success, an error message when nothing matched. Exact-normalized
 *  matching (same normalize() appendNote uses) so the panel can round-trip a note's text
 *  back to a reliable delete key. F-5(1): the removed line moves to notes.trash.md
 *  (recycle bin) instead of vanishing — restore it from the panel, chat, or REST until
 *  the trash is emptied. */
export async function deleteNote(projectPath, noteText) {
  const target = normalize(noteText || '');
  if (!target) return { success: false, error: 'Nothing to delete — give me the note text.' };

  return withNoteLock(projectPath, async () => {
    const filePath = notesPath(projectPath);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return { success: false, error: 'No notes here yet.' };
      throw err;
    }

    const lines = content.split('\n').filter((l) => l.trim());
    // F-5(2) (2026-09-09): two match strengths — dated input matches one dated line
    // exactly, dateless input with several hits is an ambiguity error, never a silent
    // partial delete. Shared with restoreTrash via findNoteIndex (same contract both
    // directions); only the message wording differs per caller.
    const found = findNoteIndex(lines, target);
    if (found.ambiguous) {
      const options = found.ambiguous.map((s) => `"${s}"`).join(', ');
      return { success: false, error: `${found.ambiguous.length} notes match "${noteText}" (${options}) — include the date to delete just one, e.g. "delete note: ${found.ambiguous[0]}".` };
    }
    const removeIdx = found.removeIdx;

    if (removeIdx === -1) return { success: false, error: 'No note matched that text.' };

    const stripAuthor = (l) => l.replace(/^- /, '').replace(/\s*· by .+$/, '');
    const stripDate = (l) => l.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '');
    const removedLine = lines[removeIdx];
    const removed = stripDate(stripAuthor(removedLine));
    const kept = lines.filter((_, idx) => idx !== removeIdx);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await ensureGitignored(projectPath);
    await fs.writeFile(filePath, (kept.length ? kept.join('\n') + '\n' : ''), 'utf-8');
    // Recycle, don't vanish: append the raw line (date + author intact) to the trash.
    let trashContent = '';
    try {
      trashContent = await fs.readFile(trashPath(projectPath), 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const trashLines = trashContent.split('\n').filter((l) => l.trim());
    trashLines.push(removedLine);
    await fs.writeFile(trashPath(projectPath), trashLines.join('\n') + '\n', 'utf-8');
    return { success: true, data: removed };
  });
}
