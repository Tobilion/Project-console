import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeFileAtomicSync } from '../atomicWrite.js';
import { resolveData } from '../dataPath.js';

const HISTORY_FILE = resolveData('notification-history.json');
const MAX_HISTORY = 500;

let history = [];

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      history = parsed.slice(0, MAX_HISTORY);
    }
  } catch {
    history = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    writeFileAtomicSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {
    // best-effort
  }
}

loadHistory();

export function getNotificationHistory() {
  return history.slice();
}

export function recordNotificationItem(projectId, projectName, event, title, body, extra = null) {
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    projectId,
    projectName,
    event,
    title,
    body,
    timestamp: Date.now(),
    dismissed: false,
    // E-2 (2026-09-09): optional caller-supplied reference (e.g. a reminder's schedule id
    // so the fired-toast can offer Snooze). Additive — existing 5-arg callers are untouched.
    ...(extra && typeof extra === 'object' ? extra : null),
  };
  history.unshift(item);
  if (history.length > MAX_HISTORY) {
    history = history.slice(0, MAX_HISTORY);
  }
  persist();
  return item;
}

export function dismissNotificationItem(id) {
  const item = history.find((h) => h.id === id);
  if (!item) return false;
  item.dismissed = true;
  persist();
  return true;
}

export function dismissAllNotificationItems() {
  let changed = false;
  for (const item of history) {
    if (!item.dismissed) {
      item.dismissed = true;
      changed = true;
    }
  }
  if (changed) persist();
  return changed;
}

export function clearNotificationHistoryItems() {
  history = [];
  persist();
  return true;
}
