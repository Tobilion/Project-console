import fs from 'fs';
import path from 'path';
import { resolveData } from './dataPath.js';
import { writeFileAtomicSync } from './atomicWrite.js';

// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): named text snippets — "save this as a snippet:
// <name>". Global (not per-project): snippets are personal, like reminders. Persisted to
// gitignored data/snippets.json with the same atomic-write pattern every other runtime-state
// file uses. Same conceptual shape as notesStore.js (capped, deduped) but a distinct store:
// snippets are named, retrievable text blocks for copying, not a journal.
const SNIPPETS_FILE = process.env.SNIPPETS_FILE || resolveData('snippets.json');
const MAX_SNIPPETS = 100;
const MAX_SNIPPET_CHARS = 4000;

let snippets = null; // lazy-loaded [{ name, text, createdAt }]

function load() {
  if (snippets) return snippets;
  try {
    if (!fs.existsSync(SNIPPETS_FILE)) { snippets = []; return snippets; }
    const parsed = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf-8'));
    snippets = Array.isArray(parsed?.snippets) ? parsed.snippets : [];
  } catch {
    snippets = [];
  }
  return snippets;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(SNIPPETS_FILE), { recursive: true });
    writeFileAtomicSync(SNIPPETS_FILE, JSON.stringify({ snippets: load() }, null, 2));
  } catch {
    // best-effort
  }
}

export function listSnippets() {
  return [...load()];
}

/** Save a snippet. Returns { ok, data } — duplicate name overwrites (a snippet is a named
 *  block; re-saving the same name is the user updating it, not a surprise duplicate). */
export function saveSnippet(name, text) {
  const trimmedName = (name || '').trim();
  const trimmedText = (text || '').trim();
  if (!trimmedName) return { ok: false, error: 'Snippet name is required.' };
  if (!trimmedText) return { ok: false, error: 'Snippet text is required.' };
  if (trimmedText.length > MAX_SNIPPET_CHARS) {
    return { ok: false, error: `Snippet too long (${MAX_SNIPPET_CHARS} char max).` };
  }
  const list = load();
  const existing = list.find((s) => s.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    existing.text = trimmedText;
    existing.createdAt = existing.createdAt || Date.now();
  } else {
    if (list.length >= MAX_SNIPPETS) list.shift();
    list.push({ name: trimmedName, text: trimmedText, createdAt: Date.now() });
  }
  persist();
  return { ok: true, data: `Snippet "${trimmedName}" saved.` };
}

export function getSnippet(name) {
  const n = (name || '').trim().toLowerCase();
  return load().find((s) => s.name.toLowerCase() === n) || null;
}

export function deleteSnippet(name) {
  const n = (name || '').trim().toLowerCase();
  const list = load();
  const idx = list.findIndex((s) => s.name.toLowerCase() === n);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  persist();
  return removed;
}
