// Phase 3 (2026-08-04): persistence of the trained confidence model, extracted from
// confidenceModel.js. Owns the model file path + the in-process cache; confidenceModel.js
// owns the training/prediction logic and imports load/save from here.
import fs from 'fs';
import path from 'path';
import { TELEMETRY_DIR, ensureDir } from './telemetryFile.js';
import { writeFileAtomicSync } from './atomicWrite.js';

const MODEL_FILE = path.join(TELEMETRY_DIR, 'confidence-model.json');

let cachedModel = null;

export function loadModel() {
  if (cachedModel) return cachedModel;
  try {
    if (fs.existsSync(MODEL_FILE)) {
      cachedModel = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));
      return cachedModel;
    }
  } catch {}
  return null;
}

export function saveModel(model) {
  ensureDir();
  writeFileAtomicSync(MODEL_FILE, JSON.stringify(model, null, 2));
  cachedModel = model;
}
