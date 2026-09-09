// F-8 (2026-09-09): OS-level file-association discovery for the "Open with…" chooser.
// The curated editorsStore registry only knows hand-registered editors, so "open with"
// could never offer e.g. Photoshop or VLC. This module enumerates what the OS itself
// would offer for a file's extension and merges it with the curated list at the call
// sites (browseRoutes GET /api/browse/apps + POST /api/browse/open-with's `osApp`).
//
// Windows (implemented + live-verified on this machine): UserChoice ProgId first (the
// real Win10+ default, overrides assoc), then `assoc ext` -> `ftype ProgId` for the
// default handler, plus the Explorer OpenWithList (HKCU .../FileExts/<ext>/OpenWithList)
// entries resolved via `where`. AppX package ids (`...!App`, e.g. Store Notepad) are
// skipped — they are not spawnable executables. Stale ProgIds with no ftype open command
// (live example on this machine: txtfilelegacy) degrade to "no default", never an error.
// Non-Windows platforms return empty (verified nowhere — see the B.4 clipboard-paths
// precedent: untested platform branches stay explicitly empty rather than half-working).
// Results cache per extension for the process lifetime (associations effectively never
// change under a running console); importers never execute client-supplied strings —
// open-with re-derives the entry server-side from the app NAME on every call.

import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

const cache = new Map();

function runCmd(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim());
    });
  });
}

/** Split an ftype open-command template into { exe, args }. Pure — unit-tested directly.
 *  `"C:\a\app.exe" /open "%L"` -> { exe: 'C:\a\app.exe', args: ['/open', '%L'] };
 *  `C:\a\app.exe %1 %*` -> { exe: 'C:\\a\\app.exe', args: ['%1'] } (%* is dropped). */
export function parseFtypeTemplate(template) {
  const raw = String(template || '').trim();
  if (!raw) return null;
  // Strip a leading `ProgId=` assignment (`ftype` echoes `Python.File="C:\..."`).
  const eq = raw.match(/^[^=\s]+\s*=\s*(.+)$/);
  const cmd = (eq ? eq[1] : raw).trim();
  const m = cmd.match(/^"([^"]+)"\s*(.*)$/) || cmd.match(/^(\S+)\s*(.*)$/);
  if (!m) return null;
  const args = m[2].split(/\s+/).filter((a) => a && a !== '%*' && a.toUpperCase() !== '%*');
  return { exe: m[1], args };
}

/** Expand %VAR% segments from process.env (ftype templates use %ProgramFiles(x86)% etc.). */
export function expandEnvVars(s) {
  return String(s || '').replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
}

/** Resolve an exe name to a full path via the platform locator, or null. */
async function resolveOnPath(exe) {
  if (!exe || /[!]/.test(exe)) return null;
  if (/[\\/]/.test(exe)) {
    try {
      return fs.existsSync(exe) ? exe : null;
    } catch {
      return null;
    }
  }
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const out = await runCmd(locator, [exe]);
  if (!out) return null;
  const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  return first || null;
}

/** Substitute the file into an ftype arg template (%L/%1, any case); append when absent.
 *  A fully-quoted placeholder (`"%L"`) substitutes to the BARE path — spawn() passes argv
 *  literally (no cmd quote-stripping), so keeping the quotes would hand the app a path
 *  with literal quote characters in it (live-caught 2026-09-09: py.exe receiving
 *  `"C:\x\f.py"` verbatim). Exported for the open-with route + unit tests. */
export function argsWithFile(args, file) {
  let placed = false;
  const out = (args || []).map((a) => {
    if (/%[l1]/i.test(a)) {
      placed = true;
      return a.replace(/"?%[l1]"?/gi, file);
    }
    return a;
  });
  if (!placed) out.push(file);
  return out;
}

async function regValue(hiveKey, valueName) {
  const out = await runCmd('reg', ['query', hiveKey, '/v', valueName]);
  if (!out) return null;
  const m = out.match(/REG_\S+\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

async function friendlyName(progId, exePath) {
  // HKCR\<ProgId> default value is often human ("VLC MP3 File"); fall back to the exe name.
  try {
    const v = await regValue(`HKCR\\${progId}`, '(Default)');
    if (v) return v;
  } catch { /* fall through */ }
  return path.basename(exePath, path.extname(exePath));
}

async function ftypeHandler(progId) {
  // ProgIds come from our own registry reads (never the client), but keep the charset
  // tight anyway — the value is interpolated into `cmd /c ftype <progId>`.
  if (!progId || /[!]/.test(progId) || !/^[A-Za-z0-9_.]+$/.test(progId)) return null;
  const line = await runCmd('cmd', ['/c', `ftype ${progId}`]);
  if (!line) return null;
  const parsed = parseFtypeTemplate(line);
  if (!parsed) return null;
  const exe = expandEnvVars(parsed.exe);
  const resolved = await resolveOnPath(exe);
  if (!resolved) return null;
  return {
    name: await friendlyName(progId, resolved),
    exe: resolved,
    args: parsed.args.map(expandEnvVars),
  };
}

async function getWindowsHandlers(ext) {
  const found = [];
  const seenExe = new Set();
  const consider = async (progId) => {
    const h = await ftypeHandler(progId);
    if (h && !seenExe.has(h.exe.toLowerCase())) {
      seenExe.add(h.exe.toLowerCase());
      found.push(h);
    }
    return h;
  };
  // 1. UserChoice ProgId — the real Win10+ default.
  let defaultApp = null;
  try {
    const choice = await regValue(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, 'ProgId');
    if (choice) defaultApp = await consider(choice);
  } catch { /* fall through to assoc */ }
  // 2. assoc fallback (`assoc .py` -> `Python.File`).
  if (!defaultApp) {
    const assocOut = await runCmd('cmd', ['/c', `assoc ${ext}`]);
    const assocProg = assocOut && assocOut.match(/=\s*(.+)$/)?.[1]?.trim();
    if (assocProg) defaultApp = await consider(assocProg);
  }
  // 3. OpenWithList extras (single-letter values; MRUList/AppX ids skipped).
  try {
    const listOut = await runCmd('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithList`]);
    if (listOut) {
      for (const line of listOut.split(/\r?\n/)) {
        const m = line.match(/^\s+[a-z]\s+REG_\S+\s+(.+)$/i);
        if (!m) continue;
        const exeName = m[1].trim();
        if (!exeName || /[!]/.test(exeName)) continue;
        const resolved = await resolveOnPath(exeName);
        if (resolved && !seenExe.has(resolved.toLowerCase())) {
          seenExe.add(resolved.toLowerCase());
          found.push({
            name: path.basename(resolved, path.extname(resolved)),
            exe: resolved,
            args: [],
          });
        }
      }
    }
  } catch { /* extras are best-effort */ }
  const openWith = found.filter((h) => h !== defaultApp);
  return { defaultApp, openWith };
}

/** OS handlers for a file: { defaultApp: {name,exe,args}|null, openWith: [{name,exe,args}] }.
 *  The LIST endpoint strips this to names only; the open-with POST re-derives the entry
 *  server-side from the name so client strings are never executed. */
export async function associatedAppsFor(absPath) {
  const ext = path.extname(String(absPath || '')).toLowerCase();
  // Same charset editorsStore.js enforces for extension keys — anything else (spaces,
  // unicode, empty) has no meaningful OS association to look up.
  if (!/^\.[a-z0-9]{1,10}$/.test(ext)) return { defaultApp: null, openWith: [] };
  if (cache.has(ext)) return cache.get(ext);
  const result = process.platform === 'win32'
    ? await getWindowsHandlers(ext)
    : { defaultApp: null, openWith: [] };
  cache.set(ext, result);
  return result;
}

/** Test hook — drop the per-ext cache (the harness redirects nothing here; lookup is live). */
export function clearOsAppsCache() {
  cache.clear();
}
