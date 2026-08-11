import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeFileAtomicSync } from './atomicWrite.js';

const NEAR_MISS_DIR = path.join(process.cwd(), 'data', 'near-misses');

function ensureDir() {
  if (!fs.existsSync(NEAR_MISS_DIR)) {
    fs.mkdirSync(NEAR_MISS_DIR, { recursive: true });
  }
}

function logFilePath(projectId) {
  return path.join(NEAR_MISS_DIR, `${projectId}.jsonl`);
}

/**
 * Append a near-miss record. Returns the line number (1-indexed) so the caller
 * can later update the entry when the user confirms or rejects the action.
 */
export function logNearMiss(projectId, entry) {
  ensureDir();
  const record = {
    id: entry.id || crypto.randomUUID(),
    timestamp: Date.now(),
    input: entry.input,
    resolvedCommand: entry.resolvedCommand || null,
    description: entry.description || null,
    source: entry.source || 'guess', // 'guess' | 'fallback'
    accepted: null, // null = pending, true = user confirmed, false = user rejected
    intentSuggestion: entry.intentSuggestion || null,
    ...entry,
  };
  const line = JSON.stringify(record) + '\n';
  const filePath = logFilePath(projectId);
  const fd = fs.openSync(filePath, 'a');
  fs.writeSync(fd, line);
  fs.closeSync(fd);
  return record.id;
}

/** Update a near-miss entry's accepted status (called from handleConfirmResponse). */
export function updateNearMiss(projectId, id, updates) {
  const filePath = logFilePath(projectId);
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    try {
      const record = JSON.parse(lines[i]);
      if (record.id === id) {
        Object.assign(record, updates);
        lines[i] = JSON.stringify(record);
        break;
      }
    } catch {}
  }
  writeFileAtomicSync(filePath, lines.join('\n') + '\n');
}

/** Read all near-miss entries for a project. */
export function readNearMisses(projectId) {
  const filePath = logFilePath(projectId);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Clear near-miss log for a project (called after suggestions are applied). */
export function clearNearMisses(projectId) {
  const filePath = logFilePath(projectId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/** List every project id that has a near-miss log on disk (for startup auto-apply sweeps). */
export function listNearMissProjectIds() {
  ensureDir();
  try {
    return fs.readdirSync(NEAR_MISS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}
