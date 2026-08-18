import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { state } from './state.js';
import { readProfile, writeProfile, sanitizeProfile } from './routes/profileRoutes.js';
import { loadModel, saveModel } from './modelStore.js';
import { getTuningState, resetTuning, setTuning } from './tuningStore.js';
import { getThresholdOverrides, replaceThresholdOverrides } from './telemetryThresholds.js';
import { writeFileAtomicSync } from './atomicWrite.js';
import { validateToolEntry } from './pluginTools.js';

// Phase 6 (2026-08-11): portable workspace export/import — the counterpart to the pack
// installer (which moves tools between machines) that moves a user's whole SETUP: profile,
// learned confidence model, threshold overrides, and — per project, explicitly opted in —
// `.console/memory.md` and `console.tools.json`. Deliberately a local-file feature only:
// no cloud, no network dependency, matching the app's offline-first design.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EXPORT_DIR = path.resolve('data', 'workspace-exports');

export const BUNDLE_FORMAT = 'project-console-workspace';
const BUNDLE_VERSION = 1;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
// Per-project memory is capped at 200 entries server-side, but guard anyway so a hand-edited
// memory.md can never balloon the bundle into an unwieldy single file.
const MAX_MEMORY_BYTES = 5 * 1024 * 1024;
const MAX_TOOLS_BYTES = 2 * 1024 * 1024;

function consoleVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readSmallFile(filePath, maxBytes) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Core bundle with NO project content — profile, model, tuning and threshold overrides.
 *  Project files are attached separately (they need the user's opt-in). */
export function collectCoreBundle() {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    consoleVersion: consoleVersion(),
    sections: {
      profile: readProfile(),
      confidenceModel: loadModel(),
      tuning: getTuningState().overrides,
      thresholds: getThresholdOverrides(),
      projects: [],
    },
  };
}

/** Projects in the scan cache that actually have exportable content (memory.md and/or
 *  console.tools.json) — the opt-in candidates shown to the user before finalizing. */
export function exportableProjectCandidates() {
  return state.activeProjectsCache.filter((p) => {
    const memoryPath = path.join(p.path, '.console', 'memory.md');
    const toolsPath = path.join(p.path, 'console.tools.json');
    return fs.existsSync(memoryPath) || fs.existsSync(toolsPath);
  }).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    path: p.path,
    hasMemory: fs.existsSync(path.join(p.path, '.console', 'memory.md')),
    hasTools: fs.existsSync(path.join(p.path, 'console.tools.json')),
  }));
}

/** Attaches the opted-in projects' memory.md + console.tools.json to a core bundle.
 *  Unknown ids are ignored (the candidate list is the source of truth). */
export function attachProjectFiles(bundle, candidateList, selectedIds) {
  const selected = new Set(selectedIds);
  const attached = [];
  for (const cand of candidateList) {
    if (!selected.has(cand.id)) continue;
    const entry = { id: cand.id, name: cand.name };
    if (cand.hasMemory) {
      entry.memoryMd = readSmallFile(path.join(cand.path, '.console', 'memory.md'), MAX_MEMORY_BYTES);
    }
    if (cand.hasTools) {
      const raw = readSmallFile(path.join(cand.path, 'console.tools.json'), MAX_TOOLS_BYTES);
      if (raw !== null) {
        try {
          entry.toolsJson = JSON.parse(raw);
        } catch {
          entry.toolsJson = null;
        }
      }
    }
    attached.push(entry);
  }
  bundle.sections.projects = attached;
  return attached;
}

/** Writes the bundle to data/workspace-exports/workspace-<timestamp>.json and returns
 *  { filePath, fileName } for the answer (path + download link). */
export function writeWorkspaceBundle(bundle) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const fileName = `workspace-${stamp}.json`;
  const filePath = path.join(EXPORT_DIR, fileName);
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
  return { filePath, fileName };
}

/**
 * Reads + validates a bundle file. Returns { bundle } or { error }. Refuses anything that
 * isn't a plain workspace bundle: wrong format marker, unparseable JSON, oversize file.
 */
export function readWorkspaceBundle(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { error: `No such file: ${filePath}` };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { error: `Not a file: ${filePath}` };
    if (stat.size > MAX_BUNDLE_BYTES) return { error: `Bundle too large (${Math.round(stat.size / 1024 / 1024)} MB > 50 MB limit)` };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { error: `"${filePath}" isn't a JSON object` };
    if (parsed.format !== BUNDLE_FORMAT) return { error: `"${filePath}" isn't a project-console workspace bundle (format "${parsed.format}")` };
    if (parsed.version !== BUNDLE_VERSION) return { error: `Unsupported workspace bundle version ${parsed.version} (this console supports ${BUNDLE_VERSION})` };
    if (!parsed.sections || typeof parsed.sections !== 'object') return { error: 'Bundle has no sections — it looks truncated or hand-edited' };
    return { bundle: parsed };
  } catch (err) {
    return { error: `Couldn't read "${filePath}": ${err.message}` };
  }
}

function applyProfile(section) {
  if (!section || typeof section !== 'object') return false;
  // Merge onto the current profile through the route's sanitizer (key allowlist + per-field
  // validation) instead of verbatim replacement — a hand-edited or hostile bundle must not
  // be able to write arbitrary keys into user-profile.json (audit 2026-08-17).
  const merged = sanitizeProfile(section, readProfile());
  writeProfile(merged);
  return true;
}

function applyModel(section) {
  if (!section || typeof section !== 'object') return false;
  saveModel(section);
  return true;
}

function applyTuning(section) {
  if (!section || typeof section !== 'object') return false;
  const overrides = Object.fromEntries(
    Object.entries(section).filter(([, v]) => typeof v === 'number'),
  );
  if (Object.keys(overrides).length === 0) return false;
  resetTuning();
  setTuning(overrides);
  return true;
}

function applyThresholds(section) {
  if (!section || typeof section !== 'object') return false;
  const floors = Object.fromEntries(
    Object.entries(section).filter(([, v]) => typeof v === 'number'),
  );
  if (Object.keys(floors).length === 0) return false;
  replaceThresholdOverrides(floors);
  return true;
}

function applyProjectFiles(entry) {
  const project = state.activeProjectsCache.find((p) => p.id === entry.id);
  if (!project) {
    return { id: entry.id, name: entry.name, skipped: 'project not on this machine (rescan before importing)' };
  }
  const consoleDir = path.join(project.path, '.console');
  const notes = [];
  if (typeof entry.memoryMd === 'string') {
    fs.mkdirSync(consoleDir, { recursive: true });
    // Atomic writes so a torn write can never leave a half-written memory.md / manifest
    // (audit 2026-08-17 — the import used plain writeFileSync).
    writeFileAtomicSync(path.join(consoleDir, 'memory.md'), entry.memoryMd);
    notes.push('memory.md');
  }
  if (entry.toolsJson && typeof entry.toolsJson === 'object') {
    // Validate every tool entry against the exact schema the manifest parser uses — an
    // invalid entry must be skipped, not imported into a manifest that then fails to load.
    const tools = Array.isArray(entry.toolsJson.tools) ? entry.toolsJson.tools : [];
    const invalid = tools.filter((t, i) => !validateToolEntry(t, i).valid);
    if (invalid.length > 0) {
      notes.push(`console.tools.json skipped (${invalid.length} invalid tool entr${invalid.length === 1 ? 'y' : 'ies'})`);
    } else if (tools.length > 0 || entry.toolsJson.permissions !== undefined) {
      const manifest = { tools, permissions: entry.toolsJson.permissions };
      writeFileAtomicSync(path.join(project.path, 'console.tools.json'), JSON.stringify(manifest, null, 2) + '\n');
      notes.push('console.tools.json');
    }
  }
  if (notes.length === 0) {
    return { id: entry.id, name: entry.name, skipped: 'no readable content in bundle entry' };
  }
  return { id: entry.id, name: entry.name, notes };
}

/**
 * Applies every section of a validated bundle. Returns { applied, skipped } where `applied`
 * lists section names and `skipped` lists per-project entries that could not be placed.
 * Import is deliberately section-granular: a corrupt section is skipped, never fatal.
 */
export function applyWorkspaceBundle(bundle) {
  const sections = bundle.sections || {};
  const applied = [];
  if (applyProfile(sections.profile)) applied.push('profile');
  if (applyModel(sections.confidenceModel)) applied.push('confidence model');
  if (applyTuning(sections.tuning)) applied.push('tuning overrides');
  if (applyThresholds(sections.thresholds)) applied.push('intent thresholds');
  const skipped = [];
  if (Array.isArray(sections.projects)) {
    for (const entry of sections.projects) {
      const result = applyProjectFiles(entry);
      if (result.notes) applied.push(`project "${result.name}" (${result.notes.join(', ')})`);
      else skipped.push(result);
    }
  }
  return { applied, skipped };
}
