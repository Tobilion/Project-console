// Central data-directory resolver (2026-08-29).
// The desktop shell persists user state outside the install directory so a reinstall
// never wipes the profile. main.cjs sets CONSOLE_DATA_DIR to app.getPath('userData')
// (e.g. %APPDATA%\Project Console) and spawns the server with that env. Plain dev
// runs have no env and fall back to the repo's ./data dir — zero behaviour change.
import path from 'path';

export function getDataDir() {
  const dir = process.env.CONSOLE_DATA_DIR;
  if (dir && typeof dir === 'string' && dir.trim()) return path.resolve(dir.trim());
  return path.resolve('data');
}

export function resolveData(...segments) {
  return path.join(getDataDir(), ...segments);
}
