import fs from 'fs/promises';
import path from 'path';
import { ensureGitignored } from './conversationStore.js';

// Persistent, cross-session AI memory — a per-project plain-text file the AI itself writes to
// during AI-mode conversations (see the saveMemory tool in tools.js), so facts/preferences/
// project quirks survive across separate chat sessions instead of only living in one
// conversation's message history. Lives under .console/ next to sessions/chat-log.md (same
// gitignore treatment) so it's scoped to the project it's about, not a single global blob that
// blends unrelated projects together.
//
// NOTE (2026-08-04): this file was temporarily clobbered by commit 9740613 (Phase 4a), which
// overwrote it with projectMemory's JSON storage (project-memory.json + loadMemory/saveMemory/
// queueMemoryWrite — now in projectMemoryStore.js). That left the saveMemory tool and the
// memory.md system-prompt injection imports broken (server would not start). Restored verbatim
// from commit 623a2f7; the JSON store lives at its own path now.
const MEMORY_DIR = '.console';
const MEMORY_FILE = 'memory.md';

// Cap on what gets injected into the system prompt (mirrors ollamaContext.js's MAX_DOC_CHARS
// pattern for CLAUDE.md) — memory is meant to stay a short list of durable facts, not a growing
// log, so if it somehow exceeds this the most recent entries win rather than the oldest.
const MAX_PROMPT_CHARS = 4000;

// Hard cap on total entries so the file can't grow unbounded with no review — oldest entries are
// dropped first once this is exceeded. Generous enough that this should rarely actually bite.
const MAX_ENTRIES = 200;

function memoryPath(projectPath) {
  return path.join(projectPath, MEMORY_DIR, MEMORY_FILE);
}

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Raw file content, or '' if no memory has been saved for this project yet. */
export async function readMemory(projectPath) {
  try {
    return await fs.readFile(memoryPath(projectPath), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Formatted for injection into the AI system prompt. Returns null if there's nothing saved yet. */
export async function formatMemoryForPrompt(projectPath) {
  const content = (await readMemory(projectPath)).trim();
  if (!content) return null;
  if (content.length <= MAX_PROMPT_CHARS) return content;
  return `... (older entries truncated — read .console/memory.md via readFile for the full history)\n${content.slice(-MAX_PROMPT_CHARS)}`;
}

/**
 * Appends one memory entry — a short, durable fact/preference/project note — to this project's
 * memory file, creating it (and gitignoring .console/, if not already) on first use.
 *
 * Deduplicates near-identical lines (same text once whitespace/case is normalized) so re-saving
 * something the AI already remembered is a harmless no-op instead of bloating the file. Caps
 * total entries at MAX_ENTRIES, dropping the oldest first, so this stays a bounded "what the AI
 * knows about this project" list rather than an ever-growing log — that's what .console/chat-
 * log.md is already for.
 */
export async function appendMemoryEntry(projectPath, content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return { success: false, error: 'content is required.' };
  if (trimmed.length > 500) {
    return { success: false, error: 'content is too long for a single memory entry (500 char max) — save one concise fact at a time.' };
  }

  const filePath = memoryPath(projectPath);
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
    return { success: true, data: 'Already remembered (duplicate skipped).' };
  }

  const date = new Date().toISOString().slice(0, 10);
  lines.push(`- ${trimmed} (${date})`);
  const capped = lines.slice(-MAX_ENTRIES);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await ensureGitignored(projectPath);
  await fs.writeFile(filePath, capped.join('\n') + '\n', 'utf-8');
  return { success: true, data: `Remembered: ${trimmed}` };
}
