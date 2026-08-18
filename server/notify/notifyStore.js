// Notification rules persistence (Phase 2). Everything lives in data/notifications.json —
// gitignored, debounced, best-effort, exactly the treatment schedules.json/dev-urls.json get.
// A webhook URL is a bearer secret (anyone with it can POST to the connected service), so it
// deliberately does NOT live in the git-tracked data/user-profile.json. Defaults are ALL OFF:
// zero behavior change until the user opts in via `notify me when <event>` / `webhook add`.

import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../atomicWrite.js';
import { NOTIFY_EVENTS, NOTIFY_EVENT_KEYS } from './notifyEvents.js';

const NOTIFY_FILE = path.join(process.cwd(), 'data', 'notifications.json');

// The event map is seeded from the catalog (audit 2026-08-17): it used to hardcode three
// events, so every event added to NOTIFY_EVENTS later (collision-found, the Phase 15
// file-watch set, reminder-fired) was invisible to `list notifications` and — worse — was
// DROPPED on reload, because loadNotifyRules only copied keys already present in the seed.
// Building it from NOTIFY_EVENT_KEYS keeps rules and catalog drift-free by construction.
const allEventsDisabled = () => Object.fromEntries(NOTIFY_EVENT_KEYS.map((k) => [k, false]));

let rules = {
  events: allEventsDisabled(),
  webhookUrls: [],
  desktop: false,
};
let saveTimer = null;

function persist() {
  try {
    fs.mkdirSync(path.dirname(NOTIFY_FILE), { recursive: true });
    writeFileAtomicSync(NOTIFY_FILE, JSON.stringify(rules, null, 2));
  } catch {
    // best-effort only — a failed persist means rules survive until next restart
  }
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 500);
}

/** Load persisted rules into memory. Call once at server startup (never after a live rule
 *  change raced the load — invoked before any connection arrives). */
export function loadNotifyRules() {
  try {
    if (!fs.existsSync(NOTIFY_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.events && typeof parsed.events === 'object') {
      for (const key of NOTIFY_EVENT_KEYS) {
        if (typeof parsed.events[key] === 'boolean') rules.events[key] = parsed.events[key];
      }
    }
    if (Array.isArray(parsed.webhookUrls)) {
      rules.webhookUrls = parsed.webhookUrls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    }
    if (typeof parsed.desktop === 'boolean') rules.desktop = parsed.desktop;
  } catch {
    // corrupt file — keep fresh defaults
  }
}

/** The live rules object (read-only for callers; mutate through the functions below). */
export function getRules() {
  return rules;
}

export function isEventEnabled(event) {
  return !!rules.events[event];
}

/** Enable/disable an event. Enabling implies the desktop channel for that event — "notify me
 *  when X" is the opt-in gesture, and desktop is the channel that needs no further setup. */
export function setEventEnabled(event, enabled) {
  rules.events[event] = enabled;
  if (enabled) rules.desktop = true;
  schedulePersist();
}

export function setDesktopChannel(enabled) {
  rules.desktop = !!enabled;
  schedulePersist();
}

export function getWebhooks() {
  return rules.webhookUrls.slice();
}

/** Add a webhook URL. The caller validates safety; this only dedupes and persists. */
export function addWebhook(url) {
  if (rules.webhookUrls.some((u) => u === url)) return false;
  rules.webhookUrls.push(url);
  schedulePersist();
  return true;
}

/** Remove a webhook by exact URL string (1-based list index also accepted for the UI list). */
export function removeWebhook(urlOrIndex) {
  const asIndex = /^\d+$/.test(String(urlOrIndex)) && Number(urlOrIndex) >= 1 ? Number(urlOrIndex) - 1 : -1;
  if (asIndex >= 0 && asIndex < rules.webhookUrls.length) {
    const [removed] = rules.webhookUrls.splice(asIndex, 1);
    schedulePersist();
    return removed;
  }
  const idx = rules.webhookUrls.findIndex((u) => u === urlOrIndex);
  if (idx === -1) return null;
  const [removed] = rules.webhookUrls.splice(idx, 1);
  schedulePersist();
  return removed;
}