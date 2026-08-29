// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): OS clipboard history + server-side clipboard
// write. Everything is opt-in via data/user-profile.json (clipboardHistory: poll the OS
// clipboard; clipboardPersist: ALSO write history to disk — a separate, bigger privacy
// commitment). When the polling setting is OFF there is zero background behavior — no
// processes, no OS calls. Persisted history lives in the gitignored data/ dir.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readProfile } from './routes/profileRoutes.js';
import { resolveData } from './dataPath.js';
import { getTuning } from './tuningStore.js';

const HISTORY_FILE = process.env.CLIPBOARD_HISTORY_FILE || resolveData('clipboard-history.json');
const MAX_ENTRIES = 25; // Windows Clipboard History caps at 25 — a readable list, not a dump

// In-memory ring buffer of recent clipboard texts, most-recent-first. Not persisted unless
// the user ALSO opts into clipboardPersist (see persistToDisk below).
let history = [];
let pollTimer = null;
let pollingInFlight = false;

// Async spawn with a 5s kill-timeout. spawnSync used to block the event loop here — with the
// 2.5s default poll cadence a hung Get-Clipboard froze the whole server for up to 5s (audit
// 2026-08-17). Buffers are collected as strings so `encoding` quirks of spawn vs spawnSync
// never matter.
function runAsync(cmd, args, inputText = null) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, 5000);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    if (inputText != null) {
      // stdin can EPIPE when the child dies early — never let that become an unhandled error.
      child.stdin.on('error', () => {});
      child.stdin.write(inputText);
      child.stdin.end();
    }
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout });
    });
  });
}

async function readClipboard() {
  try {
    if (process.platform === 'win32') {
      const r = await runAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard']);
      return r.ok ? r.stdout : null;
    }
    if (process.platform === 'darwin') {
      const r = await runAsync('pbpaste', []);
      return r.ok ? r.stdout : null;
    }
    const r = await runAsync('sh', ['-c', 'command -v xclip && xclip -selection clipboard -o || command -v xsel && xsel --clipboard -o']);
    return r.ok ? r.stdout : null;
  } catch {
    return null;
  }
}

async function writeClipboard(text) {
  try {
    if (process.platform === 'win32') {
      // Base64-encode so arbitrary text (quotes, newlines, unicode) survives the PS string arg.
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      const r = await runAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`]);
      return r.ok;
    }
    if (process.platform === 'darwin') {
      const r = await runAsync('pbcopy', [], text);
      return r.ok;
    }
    const r = await runAsync('xclip', ['-selection', 'clipboard'], text);
    return r.ok;
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

async function pollOnce() {
  // A hung clipboard command must never overlap the next tick (the 2.5s poll cadence is
  // shorter than the 5s kill-timeout) — skip rather than queue up OS processes.
  if (pollingInFlight) return;
  pollingInFlight = true;
  try {
    const profile = readProfile();
    if (!profile.clipboardHistory) return;
    const text = await readClipboard();
    if (!text || !text.trim()) return;
    const trimmed = text.trim();
    // Dedupe immediate repeats: the same value polled twice in a row is one entry, not two.
    if (history[0] === trimmed) return;
    history = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, MAX_ENTRIES);
    if (profile.clipboardPersist) persistToDisk();
  } finally {
    pollingInFlight = false;
  }
}

/** Start polling the OS clipboard. Called on boot + whenever the profile setting flips on. */
export function startClipboardPolling() {
  const profile = readProfile();
  if (!profile.clipboardHistory) return;
  if (pollTimer) return; // already running
  loadFromDisk();
  pollOnce().catch(() => {});
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, getTuning('CLIPBOARD_POLL_MS', 2500));
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
export async function copyToOsClipboard(text) {
  const ok = await writeClipboard(text);
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

/** Remove one history entry by index (0 = newest) — the per-row clear the panel's audit
 *  asked for; the in-memory splice + optional persist mirror clearClipboardHistory. */
export function removeClipboardItem(idx) {
  if (idx < 0 || idx >= history.length) return false;
  history.splice(idx, 1);
  if (readProfile().clipboardPersist) persistToDisk();
  return true;
}

/** Server-boot hook: keep polling state in sync with the profile. */
export function syncClipboardPolling() {
  if (readProfile().clipboardHistory) startClipboardPolling();
  else stopClipboardPolling();
}
