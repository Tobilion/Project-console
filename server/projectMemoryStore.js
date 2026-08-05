import fs from 'fs';
import path from 'path';

// projectMemory JSON storage (Phase 4a split, 2026-08-04 — previously sharing the
// memoryStore.js filename with the memory.md AI-memory store, which clobbered that module's
// exports and broke the saveMemory tool; the memory.md store now lives at memoryStore.js
// again, and this is the JSON store's own home). Tracks per-project usage telemetry
// (commands run, files edited, repeated questions) that drives the Layer-4 adaptive memory
// nudges in memoryThresholdChecks.js.
const MEMORY_FILENAME = 'project-memory.json';

function memoryPath(projectPath) {
  return path.join(projectPath, '.console', MEMORY_FILENAME);
}

export function loadMemory(projectPath) {
  const fp = memoryPath(projectPath);
  try {
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  } catch {}
  return createDefaultMemory();
}

function createDefaultMemory() {
  return {
    commands: {},
    editedFiles: {},
    repeatedQuestions: {},
    candidateAdditions: [],
    lastUpdated: Date.now(),
  };
}

export function saveMemory(projectPath, memory) {
  const dir = path.join(projectPath, '.console');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  memory.lastUpdated = Date.now();
  fs.writeFileSync(memoryPath(projectPath), JSON.stringify(memory, null, 2));
}

// Batched async write queue — coalesces rapid trackCommand/trackFileEdit/trackQuestion
// calls (which often happen in quick succession during AI tool-call loops) into a single
// disk write, then flushes after a 200ms quiet period.
const memoryWriteQueue = new Map();
let memoryFlushTimer = null;

export function queueMemoryWrite(projectPath, mutator) {
  if (!memoryWriteQueue.has(projectPath)) {
    memoryWriteQueue.set(projectPath, loadMemory(projectPath));
  }
  const mem = memoryWriteQueue.get(projectPath);
  mutator(mem);
  mem.lastUpdated = Date.now();
  if (!memoryFlushTimer) {
    memoryFlushTimer = setTimeout(() => {
      memoryFlushTimer = null;
      for (const [p, m] of memoryWriteQueue) {
        memoryWriteQueue.delete(p);
        saveMemory(p, m);
      }
    }, 200);
  }
}
