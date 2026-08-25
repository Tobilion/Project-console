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
    id: 'folder-explorer',
    name: 'Folder Explorer',
    description: 'Browse ANY folder on disk — list or grid view, folder-in-folder navigation, open files in your IDE',
    icon: 'folder-open',
    available: true,
    chatHint: 'browse C:\\Users\\you\\Documents',
    // Phase T2 fix: users call it a "file explorer" (Windows File Explorer habit) — the
    // Ctrl+K palette must match that phrasing, not just the id-derived "folder explorer".
    keywords: ['file explorer', 'files', 'browse', 'explore', 'folders', 'navigate'],
  },
  {
    id: 'notes',
    name: 'Notes',
    description: 'Quick-capture scratch notes — add, read back, and search them',
    icon: 'sticky-note',
    available: true,
    chatHint: 'note: buy milk',
  },
  {
    id: 'csv-tools',
    name: 'Spreadsheet',
    description: 'Sum, average, count, and filter CSV files in this project',
    icon: 'table',
    available: true,
    chatHint: 'sum column sales in data.csv',
  },
  {
    id: 'clipboard',
    name: 'Clipboard',
    description: 'Clipboard history and saved snippets (history is opt-in)',
    icon: 'clipboard-copy',
    available: true,
    chatHint: 'show clipboard history',
  },
  {
    id: 'backup',
    name: 'Backup',
    description: 'Zip a folder and browse past backups (Time Machine-style list)',
    icon: 'archive',
    available: true,
    chatHint: 'backup this folder',
  },
  {
    id: 'notifications',
    name: 'Notifications',
    description: 'File-watch rules and delivery channels — IFTTT-style rule cards',
    icon: 'bell',
    available: true,
    chatHint: 'notify me when files change in Downloads',
  },
  {
    id: 'knowledge-base',
    name: 'Documents',
    description: 'Search PDFs, Word docs, and notes by meaning (offline index)',
    icon: 'book-open',
    available: true,
    chatHint: 'search my documents for pricing',
  },
  {
    id: 'marketplace',
    name: 'Pack Marketplace',
    description: 'Browse and install tool packs from a registry you configure',
    icon: 'store',
    available: true,
    chatHint: 'browse pack registry',
  },
  {
    // Round-6 audit (2026-08-24): Aider-style whole-project map visibility. The repo map
    // (per-file top-level signatures + imports + reverse "used by") previously only reached
    // the AI system prompt; this panel renders the same structure the prompt sees.
    id: 'repo-map',
    name: 'Repo Map',
    description: 'The whole-project map: every file\'s top-level symbols, imports, and reverse dependencies',
    icon: 'map',
    available: true,
    chatHint: 'show the repo map',
  },
];

export function getToolPanels() {
  return TOOL_PANELS;
}

export function getToolPanel(id) {
  return TOOL_PANELS.find((p) => p.id === id) || null;
}