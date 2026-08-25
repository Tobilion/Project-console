// Per-project view persistence helpers (2026-08-24, split out of App.tsx): the workspace
// tab (Developer/General) and the last-open tool panel are plain JSON maps keyed by
// projectId, stored inline in localStorage — same convention as the pinned-projects rail in
// SidebarDrawer. Malformed/stale entries are ignored and simply re-derived from the
// project's server-side state.

// Phase 1 per-project workspace tab persistence. A plain JSON map of projectId ->
// 'dev' | 'general'.
export const WORKSPACE_TAB_KEY = 'console.workspaceTabByProject';
export function readWorkspaceTabs(): Record<string, 'dev' | 'general'> {
  try {
    const raw = localStorage.getItem(WORKSPACE_TAB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

// Phase 1.5 per-project last-open tool panel. A plain JSON map of projectId -> tool panel id
// ('' = grid). Restored into the Tools surface's selection when the project changes; the
// Tools view itself only opens on an explicit gesture (header button or the chat's
// `openPanel` instruction).
export const TOOL_PANEL_KEY = 'console.toolPanelByProject';
export function readToolPanels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TOOL_PANEL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}