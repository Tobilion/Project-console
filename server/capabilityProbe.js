// Installed-tool capability probe (2026-08-24, differentiation item): a lightweight
// one-time-per-boot check of which developer CLIs actually exist on PATH. Trigger-mode
// suggestions consult it (e.g. "yarn is installed — yarn run X works too") so the console
// surfaces the tooling the machine really has instead of assuming npm-only.
//
// Design: probe ONCE per boot and cache forever (the PATH doesn't change mid-run); every
// check is a bounded `where`/`which` lookup that resolves nothing on absence. Never throws,
// never blocks: callers read a boolean or null.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const LOOKUP = IS_WIN ? 'where' : 'which';

// The CLIs the console's own suggestions can meaningfully mention. Kept narrow on purpose —
// presence is only surfaced where the console has a matching suggestion shape.
const PROBED_CLIS = ['npm', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'node', 'git', 'docker', 'flutter', 'dart', 'cargo', 'go'];

/** Boot-cached presence map: { npm: true, yarn: false, ... }. Resolves once, never re-probes. */
let presencePromise = null;
export function probeInstalledClis() {
  if (!presencePromise) {
    presencePromise = (async () => {
      const result = {};
      await Promise.all(PROBED_CLIS.map(async (cli) => {
        try {
          await execFileAsync(LOOKUP, [cli], { timeout: 3000, windowsHide: true });
          result[cli] = true;
        } catch {
          result[cli] = false;
        }
      }));
      return result;
    })();
  }
  return presencePromise;
}

/** Async boolean for one CLI: true when present on PATH, false when absent or probing failed. */
export async function hasInstalledCli(name) {
  try {
    const map = await probeInstalledClis();
    return !!map[name];
  } catch {
    return false;
  }
}