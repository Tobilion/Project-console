// untrackedProcess.js — resolve and stop a dev-server process the console does NOT track
// (started outside the console, or before a restart). Deliberately dependency-free: imports only
// node builtins, so any entry point can use it without pulling in the server graph. Every
// function is best-effort and never throws — a failed lookup degrades to "couldn't find it",
// never a crash.
import { spawnSync } from 'child_process';

/** Extract the port from an http(s) URL string, or null. */
export function portFromUrl(url) {
  try {
    const p = new URL(url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort lookup of the process listening on `port` and its command line. Windows:
 * Get-NetTCPConnection -> OwningProcess -> Get-CimInstance. POSIX: lsof. Returns
 * { pid, commandLine } or null. Never throws.
 */
export function resolveProcessOnPort(port) {
  if (!port) return null;
  try {
    if (process.platform === 'win32') {
      const conn = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
      ], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      const pid = Number((conn.stdout || '').trim());
      if (!pid) return null;
      const proc = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
      ], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      return { pid, commandLine: (proc.stdout || '').trim() };
    }
    const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8', timeout: 5000 });
    const pid = Number((lsof.stdout || '').trim().split('\n')[0]);
    if (!pid) return null;
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
    return { pid, commandLine: (ps.stdout || '').trim() };
  } catch {
    return null;
  }
}

/**
 * Kill a process tree by pid. Windows: synchronous taskkill /f /t (the same tree-kill the tracked
 * stop path uses — killing the wrapper alone orphans the real server). POSIX: SIGTERM the process
 * group, then the process. Returns true when the kill was issued without error.
 */
export function killProcessByPid(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/f', '/t', '/pid', String(pid)], { windowsHide: true, stdio: 'ignore' });
      return r.status === 0;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    return true;
  } catch {
    return false;
  }
}

/** True when a command line looks like a dev/background server (a hint for the confirm card). */
export function looksLikeDevServer(commandLine) {
  if (!commandLine) return false;
  return /(vite|next|astro|webpack|tsx|node|npm|yarn|pnpm|python|http\.server|serve|server)/i.test(commandLine);
}
