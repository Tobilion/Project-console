// Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): the interactive-tool registry backing the
// "Tools" card grid. Server-driven by design — a later phase can report per-tool
// availability ("PDF Tools disabled, pdf-lib not installed") over the REST surface without
// restructuring the client. The `icon` value is a lucide icon name resolved client-side
// (the web client owns the icon mapping, the server owns the data).
export const TOOL_PANELS = [
  {
    id: 'calculator',
    name: 'Calculator',
    description: 'Step-through arithmetic with a live result display',
    icon: 'calculator',
    available: true,
    chatHint: 'calculate 15% of 80',
  },
  {
    id: 'pdf-tools',
    name: 'PDF Tools',
    description: 'Merge, split, extract text or pages, and watermark PDFs',
    icon: 'file-text',
    available: true,
    chatHint: 'merge these pdfs into combined.pdf',
  },
{
    id: 'reminders',
    name: 'Reminders',
    description: 'Personal reminders — Today / Upcoming / All, free-form natural-language dates',
    icon: 'list-checks',
    available: true,
    chatHint: 'remind me tomorrow at 9am to renew my license',
  },
  {
    id: 'file-tools',
    name: 'File Tools',
    description: 'Browse, search for files by name or content, find duplicates, and tidy this folder',
    icon: 'folder-search',
    available: true,
    chatHint: 'find files matching invoice',
  },
  {
    id: 'notes',
    name: 'Notes',
    description: 'Quick-capture scratch notes — add, read back, and search them',
    icon: 'sticky-note',
    available: true,
    chatHint: 'note: buy milk',
  },
];

export function getToolPanels() {
  return TOOL_PANELS;
}

export function getToolPanel(id) {
  return TOOL_PANELS.find((p) => p.id === id) || null;
}