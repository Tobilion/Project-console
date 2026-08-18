// Phase T (2026-08-14): project-scoped REST URLs are tab-aware — the server resolves
// /api/projects/:id/* inside the requesting tab's workspace when ?tab= is present (see
// state.js tabWorkspaces). Panels thread the active tab id through this helper so their
// file/CSV/PDF/backup fetches hit the same folder the tab is showing, never another tab's
// scan root (same-named folders collide on the slug id across roots).
export function projectApi(path: string, tabId?: string | null): string {
  if (!tabId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}tab=${encodeURIComponent(tabId)}`;
}
