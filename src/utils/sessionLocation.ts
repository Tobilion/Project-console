// Session-location helpers (2026-08-24, split out of useConsole.ts): a chat may belong to
// ANOTHER tab's workspace (created while that tab was active). These helpers match a
// session's location (projectPath, or workspacePath for General chats that have no project)
// against each tab's scan root — clicking a chat must land on the folder + project it
// actually lives in. Pure functions: the tab state is passed in, so nothing here touches
// React or the console's shared state.

import type { ConsoleTab } from '../hooks/useConsoleTabs';

// True when an absolute path sits inside (or equals) a scan root — case-insensitive, separator-
// normalized prefix match on win32. Shared by findTabForSession and the orphan-workspace check.
export const pathInScanRoot = (path: string, root: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const r = norm(root).replace(/\/+$/, '');
  const q = norm(path);
  return q.startsWith(r + '/') || q === r;
};

/**
 * Returns the owning tab's id for a session location, or null when the DEFAULT tab owns it /
 * nothing owns it (caller disambiguates). The active tab's own workspace wins: a chat already
 * visible under the current tab must never redirect to a different tab that happens to share
 * the same scan root (duplicated tabs). Only falls through to other tabs when the active one
 * doesn't contain this path.
 */
export function findTabForSession(
  tabs: ConsoleTab[],
  activeTabId: string | null,
  projectPath?: string | null,
  workspacePath?: string | null,
): string | null {
  const path = projectPath || workspacePath;
  if (!path) return null;
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && active.scanPath && pathInScanRoot(path, active.scanPath)) return active.id;
  for (const t of tabs) {
    if (t.id === active?.id || !t.scanPath) continue;
    if (pathInScanRoot(path, t.scanPath)) return t.id;
  }
  return null;
}