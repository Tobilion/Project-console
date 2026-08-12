// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): OS clipboard history + server-side clipboard
// write. Everything is opt-in via data/user-profile.json (clipboardHistory: poll the OS
// clipboard; clipboardPersist: ALSO write history to disk — a separate, bigger privacy
// commitment). When the polling setting is OFF there is zero background behavior — no
// processes, no OS calls. Persisted history lives in the gitignored data/ dir.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readProfile } from './routes/profileRoutes.js';
import { getTuning } from './tuningStore.js';

const HISTORY_FILE = path.join(process.cwd(), 'data', 'clipboard-history.json');
const MAX_ENTRIES = 25; // Windows Clipboard History caps at 25 — a readable list, not a dump

// In-memory ring buffer of recent clipboard texts, most-recent-first. Not persisted unless
// the user ALSO opts into clipboardPersist (see persistToDisk below).
let history = [];
let pollTimer = null;

function readClipboard() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 ? r.stdout : null;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 ? r.stdout : null;
    }
    const xclip = spawnSync('sh', ['-c', 'command -v xclip && xclip -selection clipboard -o || command -v xsel && xsel --clipboard -o'], { encoding: 'utf8', timeout: 5000 });
    return xclip.status === 0 ? xclip.stdout : null;
  } catch {
    return null;
  }
}

function writeClipboard(text) {
  try {
    if (process.platform === 'win32') {
      // Base64-encode so arbitrary text (quotes, newlines, unicode) survives the PS string arg.
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`], { encoding: 'utf8', timeout: 5000 });
      return true;
    }
    if (process.platform === 'darwin') {
      spawnSync('pbcopy', [], { input: text, encoding: 'utf8', timeout: 5000 });
      return true;
    }
    const r = spawnSync('xclip', ['-selection', 'clipboard'], { input: text, encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function persistToDisk() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ entries: history }, null, 2), 'utf-8');
  } catch {
    // best-effort — a failed persist is not worth taking the polling loop down with it
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (Array.isArray(parsed?.entries)) history = parsed.entries.slice(0, MAX_ENTRIES);
  } catch {
    // corrupt file — fresh start
  }
}

function pollOnce() {
  const profile = readProfile();
  if (!profile.clipboardHistory) return;
  const text = readClipboard();
  if (!text || !text.trim()) return;
  const trimmed = text.trim();
  // Dedupe immediate repeats: the same value polled twice in a row is one entry, not two.
  if (history[0] === trimmed) return;
  history = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, MAX_ENTRIES);
  if (profile.clipboardPersist) persistToDisk();
}

/** Start polling the OS clipboard. Called on boot + whenever the profile setting flips on. */
export function startClipboardPolling() {
  const profile = readProfile();
  if (!profile.clipboardHistory) return;
  if (pollTimer) return; // already running
  loadFromDisk();
  pollOnce();
  pollTimer = setInterval(pollOnce, getTuning('CLIPBOARD_POLL_MS', 2500));
  pollTimer.unref();
}

/** Stop polling (setting flipped off, or shutdown). In-memory history is kept unless the
 *  persist setting is also off — the buffer clears on restart either way. */
export function stopClipboardPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Copy text to the OS clipboard server-side (Set-Clipboard/pbcopy/xclip). */
export function copyToOsClipboard(text) {
  const ok = writeClipboard(text);
  if (ok && readProfile().clipboardHistory) {
    const trimmed = text.trim();
    if (history[0] !== trimmed) history = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, MAX_ENTRIES);
    if (readProfile().clipboardPersist) persistToDisk();
  }
  return ok;
}

export function getClipboardHistory() {
  return [...history];
}

export function clearClipboardHistory() {
  history = [];
  if (readProfile().clipboardPersist) persistToDisk();
}

/** Server-boot hook: keep polling state in sync with the profile. */
export function syncClipboardPolling() {
  if (readProfile().clipboardHistory) startClipboardPolling();
  else stopClipboardPolling();
}
