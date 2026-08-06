import fs from 'fs';
import fsp from 'fs/promises';

// Write a file atomically: write to a sibling .tmp then rename over the target. On the same
// volume rename is atomic, so a crash mid-write can never leave a torn file at the target
// path — and every reader in this codebase treats a torn JSON file as "no data", which would
// silently reset all learned state (thresholds, model, learned phrases) on the next start.
export function writeFileAtomicSync(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

// Async variant for the fs/promises modules (conversation store paths). Unique tmp name per
// call so two overlapping writers can never clobber each other's tmp file before the rename.
// A failed rename falls back to a direct write; a failure of BOTH propagates so callers can
// decide whether to surface it (session meta writes log it and keep going).
export async function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, data);
  try {
    await fsp.rename(tmpPath, filePath);
  } catch {
    // Rename over an existing file can fail on some platforms if the target is briefly locked.
    await fsp.writeFile(filePath, data);
  }
}
