import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from './atomicWrite.js';

// Phase T2 (2026-08-14): the editor/IDE registry — which editors exist on this machine
// (name + launch command) and the per-extension default mapping ("open main.py in the
// editor" opens PyCharm when .py -> pycharm). Persisted to gitignored data/editors.json
// (machine-specific paths/commands must never land in the git-tracked user-profile.json;
// same treatment as schedules/notifications/tuning). Env-overridable for the harness
// (EDITORS_FILE), like WATCH_RULES_FILE/SCHEDULES_FILE.
const EDITORS_FILE = process.env.EDITORS_FILE || path.resolve('data/editors.json');

// Seed set of well-known editors. `command` is the executable invoked with the file/folder
// path as its argument (PATH-resolved at spawn time, same as `code`); a user can edit
// commands or add their own editors via the settings UI. The .html default is the reserved
// pseudo-editor 'browser' (handled by open_html, never spawned).
export const DEFAULT_EDITORS = [
  { id: 'vscode', name: 'VS Code', command: 'code' },
  { id: 'cursor', name: 'Cursor', command: 'cursor' },
  { id: 'pycharm', name: 'PyCharm', command: 'pycharm64' },
  { id: 'idea', name: 'IntelliJ IDEA', command: 'idea64' },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm64' },
  { id: 'sublime', name: 'Sublime Text', command: 'subl' },
  { id: 'notepadpp', name: 'Notepad++', command: 'notepad++' },
  { id: 'visualstudio', name: 'Visual Studio', command: 'devenv' },
  { id: 'androidstudio', name: 'Android Studio', command: 'studio64' },
];

export const DEFAULT_EXT_DEFAULTS = {
  '.py': 'pycharm',
  '.java': 'idea',
  '.js': 'vscode',
  '.jsx': 'vscode',
  '.ts': 'vscode',
  '.tsx': 'vscode',
  '.c': 'vscode',
  '.cpp': 'vscode',
  '.h': 'vscode',
  '.cs': 'visualstudio',
  '.kt': 'androidstudio',
  '.html': 'browser',
  '.md': 'vscode',
  '.json': 'vscode',
  '.css': 'vscode',
};

const DEFAULT_STATE = {
  editors: DEFAULT_EDITORS,
  defaults: DEFAULT_EXT_DEFAULTS,
};

let state = { editors: [...DEFAULT_EDITORS], defaults: { ...DEFAULT_EXT_DEFAULTS } };

function sanitizeEditors(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id || '').trim().replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    const name = String(e.name || '').trim();
    const command = String(e.command || '').trim();
    // 'browser' is the reserved pseudo-editor for .html — never a spawnable command.
    if (!id || id === 'browser' || !name || !command) continue;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, name, command });
  }
  return out;
}

function sanitizeDefaults(raw, editors) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  const ids = new Set(editors.map((e) => e.id));
  ids.add('browser');
  for (const [ext, editorId] of Object.entries(raw)) {
    if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) continue;
    if (!ids.has(String(editorId))) continue;
    clean[ext.toLowerCase()] = String(editorId);
  }
  return clean;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(EDITORS_FILE), { recursive: true });
    writeFileAtomicSync(EDITORS_FILE, JSON.stringify(state, null, 2));
  } catch {
    // best-effort only — same convention as devUrlStore.js
  }
}

/** Sync-load from disk. Call once at server startup (before any open_with dispatch). */
export function loadEditors() {
  try {
    if (!fs.existsSync(EDITORS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(EDITORS_FILE, 'utf8'));
    const editors = sanitizeEditors(parsed?.editors);
    if (editors) {
      state = {
        editors,
        defaults: sanitizeDefaults(parsed?.defaults, editors),
      };
    }
  } catch {
    // corrupt file — keep the seed defaults
  }
}

export function getEditorsState() {
  return { editors: [...state.editors], defaults: { ...state.defaults } };
}

/** Applies + persists a full replacement of the editor list and/or the extension map. */
export function setEditors(raw) {
  if (raw?.editors !== undefined) {
    const editors = sanitizeEditors(raw.editors);
    if (editors) state.editors = editors;
  }
  if (raw?.defaults !== undefined) {
    state.defaults = sanitizeDefaults(raw.defaults, state.editors);
  }
  persist();
  return getEditorsState();
}

/** Find an editor by id or by a loose name match ("pycharm" / "PyCharm" / "IntelliJ"). */
export function resolveEditor(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return state.editors.find((e) => e.id === q)
    || state.editors.find((e) => e.name.toLowerCase() === q)
    || state.editors.find((e) => e.name.toLowerCase().includes(q))
    || null;
}

/** The configured editor for a file extension, or null when unmapped (caller falls back). */
export function defaultEditorFor(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  if (!ext) return null;
  const id = state.defaults[ext];
  if (!id) return null;
  if (id === 'browser') return { id: 'browser', name: 'Browser', command: null };
  return state.editors.find((e) => e.id === id) || null;
}
