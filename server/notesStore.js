import fs from 'fs/promises';
import path from 'path';
import { ensureGitignored } from './conversationStore.js';

// User-authored scratch notes, stored at <project>/.console/notes.md — a THIRD store,
// deliberately distinct from memoryStore.js (AI-authored durable facts in memory.md) and
// projectMemoryStore.js (JSON usage patterns). notes.md is user text only: never written by
// the AI, never injected into the AI system prompt unless the user explicitly asks for it
// read back. Same .console/ + gitignore treatment as memory.md.
const NOTES_DIR = '.console';
const NOTES_FILE = 'notes.md';

const MAX_ENTRIES = 200;
const MAX_ENTRY_CHARS = 1000;

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
  return content.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^- (.*?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?$/);
    return { text: m ? m[1] : line, date: m && m[2] ? m[2] : null };
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
    const capped = lines.slice(-MAX_ENTRIES);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await ensureGitignored(projectPath);
    await fs.writeFile(filePath, capped.join('\n') + '\n', 'utf-8');
    return { success: true, data: `Note added: ${trimmed}` };
  });
}
