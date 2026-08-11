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
    description: 'Merge, split, compress and convert PDFs by dropping files',
    icon: 'file-text',
    available: true,
    chatHint: 'none yet — the PDF trigger commands land in a later update',
  },
];

export function getToolPanels() {
  return TOOL_PANELS;
}

export function getToolPanel(id) {
  return TOOL_PANELS.find((p) => p.id === id) || null;
}