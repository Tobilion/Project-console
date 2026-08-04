// Phase 3a (2026-08-04): shared telemetry file operations, extracted as a cycle-breaking leaf.
// Owned disk access to data/telemetry/*.jsonl and the per-project model/threshold files.
// Both confidenceModel.js and intentTelemetry.js import here instead of importing each other,
// which is what closes the intentTelemetry <-> confidenceModel import cycle.
import fs from 'fs';
import path from 'path';

export const TELEMETRY_DIR = path.join(process.cwd(), 'data', 'telemetry');

export function filePath(projectId) {
  return path.join(TELEMETRY_DIR, `${projectId}.jsonl`);
}

export function ensureDir() {
  if (!fs.existsSync(TELEMETRY_DIR)) {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  }
}

// List every project that has a telemetry log (used by confidenceModel's global retrain).
export function listTelemetryProjectIds() {
  ensureDir();
  try {
    return fs.readdirSync(TELEMETRY_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}

// Read + parse one project's telemetry log as an array of records.
export function readTelemetry(projectId) {
  const fp = filePath(projectId);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Append pre-stringified newline-delimited records (the write-queue batches raw objects, then
// hands them here). Single fs.appendFileSync call.
export function appendTelemetry(projectId, records) {
  const fp = filePath(projectId);
  ensureDir();
  const lines = records.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(fp, lines);
}

// Rewrite one record (matched by id) with merged updates, in place.
export function updateTelemetryEntry(projectId, id, updates) {
  const fp = filePath(projectId);
  if (!fs.existsSync(fp)) return;
  let changed = false;
  const lines = readTelemetry(projectId);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].id === id) {
      Object.assign(lines[i], updates);
      changed = true;
      break;
    }
  }
  if (changed) fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// Delete a project's telemetry log.
export function clearTelemetry(projectId) {
  const fp = filePath(projectId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}
