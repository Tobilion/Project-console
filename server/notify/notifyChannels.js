// Phase 2 notification channels (2026-08-10). Two pluggable senders, both best-effort and
// non-fatal: sendDesktopNotification shells out to PowerShell for a Windows toast (no new npm
// dependency; degrades silently when the OS/WinRT doesn't show it), sendWebhook POSTs JSON to a
// user-configured URL through the same isSafeExternalUrl SSRF guard the web-search fetch uses.
// Neither channel ever throws — notify.js reports { ok, ... } per channel instead.

import { spawn } from 'child_process';
import { isSafeExternalUrl } from '../urlSafety.js';

const WEBHOOK_TIMEOUT_MS = 8000;

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Quote a literal for insertion into a PowerShell single-quoted string (doubling quotes). */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Best-effort Windows desktop toast via the WinRT ToastNotificationManager. The PowerShell
 * 5.1 WinRT projection works without any installed module; the toast may still silently no-op
 * on Windows 11 unless an AppUserModelID is registered for the app — acceptable per "degrade
 * silently, never crash" — and the script catches its own errors so even a broken projection
 * exits 0 without pretending it displayed anything.
 */
export function sendDesktopNotification(title, body) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'desktop notifications are Windows-only' });
  }
  const xml =
    `<toast><visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>` +
    `</binding></visual></toast>`;
  const script =
    'try { ' +
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ' +
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; ' +
    `$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml(${psQuote(xml)}); ` +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('local-project-console').Show((New-Object Windows.UI.Notifications.ToastNotification $x)) " +
    '} catch {}';
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
      child.on('error', () => resolve({ ok: false, reason: 'powershell could not be started' }));
      child.on('close', () => resolve({ ok: true }));
    } catch {
      resolve({ ok: false, reason: 'desktop notification failed to spawn' });
    }
  });
}

/**
 * POST a JSON payload to a user-configured webhook. Re-validates the URL through
 * isSafeExternalUrl at SEND time (not just at configuration time) — a rule or a config file
 * edited by hand must not get a free pass to an internal address. Outbound POSTs to
 * localhost/private targets are deliberately blocked; this makes local webhook endpoints
 * untestable by design, and that is the point of the guard.
 */
export async function sendWebhook(url, payload) {
  const outcome = await guardedWebhookPost(url, payload);
  return { ok: outcome.ok, status: outcome.status, reason: outcome.reason };
}

/**
 * Round-6 audit (2026-08-24): webhook tester for the Notifications panel's Postman-style
 * request builder. Same guarded fetch as sendWebhook (SSRF re-check + redirect manual +
 * timeout), plus the timing/size details a response panel shows: status code, round-trip
 * milliseconds, response body bytes. Never throws; every failure becomes an outcome record.
 */
export async function testWebhookUrl(url) {
  const t0 = Date.now();
  const outcome = await guardedWebhookPost(url, { event: 'test', message: 'Test notification from Project Console', sentAt: new Date().toISOString() });
  return {
    ok: outcome.ok,
    status: outcome.status ?? null,
    timeMs: Date.now() - t0,
    sizeBytes: outcome.sizeBytes ?? 0,
    reason: outcome.reason ?? null,
  };
}

async function guardedWebhookPost(url, payload) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` };
  }
  if (!isSafeExternalUrl(parsed)) {
    return { ok: false, reason: 'internal/private addresses are blocked by the SSRF guard' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // redirect: 'manual' — only the URL that passed isSafeExternalUrl may be reached. A
      // configured endpoint that 302s now fails (res.ok false) instead of the fetch silently
      // following the Location to a host that was never validated (audit 2026-08-24; same
      // discipline as the fixed GET fetches in webSearch/packRegistry/toolProcess).
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const body = await res.arrayBuffer().catch(() => null);
    return { ok: res.ok, status: res.status, sizeBytes: body ? body.byteLength : 0 };
  } catch (err) {
    return {
      ok: false,
      reason: err && err.name === 'TimeoutError' ? 'timed out' : (err && err.message) || String(err),
    };
  }
}