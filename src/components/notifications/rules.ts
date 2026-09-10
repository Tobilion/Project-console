// Notifications rule model (2026-09-10, split out of NotificationsPanel.tsx): the
// watch-rule/history shapes, the per-event display maps, and the plain-language
// sentence helpers. Pure data + pure functions — no JSX, no fetching.

export interface NotificationHistoryItem {
  id: string;
  projectId: string;
  projectName: string;
  event: string;
  title: string;
  body: string;
  timestamp: number;
  dismissed: boolean;
}

// Phase 15 (UPGRADE-ROADMAP.md, 2026-08-12): IFTTT/Zapier-style rule cards
// ("When <event> in <folder>, notify me").
export interface WatchRule {
  id: string;
  folder: string;
  event: 'file-changed' | 'file-added' | 'folder-stale';
  days: number | null;
  projectName: string | null;
  createdAt: number;
  enabled: boolean;
  lastFiredAt?: number;
}

export interface TestResult {
  ok: boolean;
  status: number | null;
  timeMs: number;
  sizeBytes: number;
  reason: string | null;
}

export const EVENT_COLORS: Record<string, string> = {
  'file-changed': 'var(--color-accent-blue)',
  'file-added': 'var(--color-accent-green)',
  'folder-stale': 'var(--color-accent-orange)',
};

export const EVENT_LABEL: Record<string, string> = {
  'file-changed': 'file changes',
  'file-added': 'a new file appears',
  'folder-stale': 'no changes for N days',
};

export function ruleSentence(r: WatchRule): string {
  if (r.event === 'folder-stale') {
    return `When ${r.folder} hasn't changed in ${r.days} days, notify me`;
  }
  return `When ${EVENT_LABEL[r.event]} in ${r.folder}, notify me`;
}

export function lastFiredText(r: WatchRule): string {
  if (!r.lastFiredAt) return 'never fired';
  return `last fired ${new Date(r.lastFiredAt).toLocaleString()}`;
}
