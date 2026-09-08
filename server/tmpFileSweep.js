// Orphaned *.tmp file detection + cleanup (Phase B.2/K-10 dedup, 2026-09-08). Extracted from
// server/sessionIndex.js's A-6 boot sweep so server/doctor.js can reuse the exact same logic
// for its "Orphaned temp files" check and its --fix auto-remediation, instead of doctor
// re-implementing the sweep or importing sessionIndex.js directly (which would pull in
// logger.js/pino — real dependencies doctor deliberately avoids per its "must still work when
// the server can't boot" contract). Plain fs/path only, zero further imports.
import fs from 'fs/promises';
import path from 'path';
import { LEGACY_STORE_DIR } from './sessionPaths.js';

// Recent tmp files from a concurrent atomic writer (writeIndex, appendMessage) are still in
// use; anything older than this is abandoned (a crashed process, an interrupted rename).
export const TMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;

function sweepDirs(projectRoots) {
  return [LEGACY_STORE_DIR, ...projectRoots.filter(Boolean).map((r) => path.join(r, '.console', 'sessions'))];
}

async function collectStaleTmpFiles(projectRoots) {
  const stale = [];
  for (const dir of sweepDirs(projectRoots)) {
    try {
      const files = await fs.readdir(dir);
      const now = Date.now();
      for (const f of files) {
        if (!f.endsWith('.tmp')) continue;
        try {
          const full = path.join(dir, f);
          const stat = await fs.stat(full);
          if (now - stat.mtimeMs > TMP_SWEEP_MAX_AGE_MS) stale.push(full);
        } catch {
          // File vanished between readdir and stat (another sweeper/writer) — not our problem.
        }
      }
    } catch {
      // Directory doesn't exist (project has no sessions yet, or LEGACY_STORE_DIR not created) —
      // nothing to sweep there.
    }
  }
  return stale;
}

/** Dry-run: how many orphaned .tmp files exist right now, without touching any of them. */
export async function countOrphanedTmpFiles(projectRoots = []) {
  return (await collectStaleTmpFiles(projectRoots)).length;
}

/** Deletes every orphaned .tmp file found and returns how many were removed. */
export async function sweepOrphanedTmpFiles(projectRoots = []) {
  const stale = await collectStaleTmpFiles(projectRoots);
  let removed = 0;
  for (const full of stale) {
    try {
      await fs.unlink(full);
      removed++;
    } catch {
      // Already gone, or a permissions issue — not fatal to the sweep as a whole.
    }
  }
  return removed;
}
