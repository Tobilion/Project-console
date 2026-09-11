// Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): the chat-side openers for the shared interactive
// tool panels. Each entry's `opensPanel` field is the wire-contract tag: when such an intent
// matches, builtinTools.js sends the server answer with an `openPanel` field on the same
// `answer` payload so the web client switches to that panel. The CLI deliberately ignores
// `openPanel` (Phase 1.5's permanent CLI/web capability gap) — the answer text stays self-
// sufficient, naming the chat equivalent the CLI user can type instead.
export const TOOL_PANEL_INTENTS = {
  'system.tools.open_calculator': {
    opensPanel: 'calculator',
    examples: [
      'open calculator', 'open the calculator', 'open tools', 'open the tools',
    ],
  },
  'system.tools.open_pdf_tools': {
    opensPanel: 'pdf-tools',
    examples: [
      'open pdf tools', 'open the pdf tools', 'open pdf tools panel',
    ],
  },
  'system.tools.open_reminders': {
    opensPanel: 'reminders',
    examples: [
      'open reminders', 'open the reminders', 'open reminders panel', 'open the reminders panel',
    ],
  },
  'system.tools.open_file_tools': {
    opensPanel: 'file-tools',
    examples: [
      'open file tools', 'open the file tools', 'open file tools panel',
    ],
  },
  'system.tools.open_notes': {
    opensPanel: 'notes',
    examples: [
      'open notes', 'open the notes', 'open notes panel',
    ],
  },
  'system.tools.open_csv_tools': {
    opensPanel: 'csv-tools',
    examples: [
      'open spreadsheet', 'open the spreadsheet', 'open csv tools', 'open the csv tools',
    ],
  },
  'system.tools.open_clipboard': {
    opensPanel: 'clipboard',
    examples: [
      'open clipboard', 'open the clipboard', 'open clipboard panel',
    ],
  },
  'system.tools.open_backup': {
    opensPanel: 'backup',
    examples: [
      'open backup', 'open backups', 'open the backup panel',
    ],
  },
  'system.tools.open_notifications': {
    opensPanel: 'notifications',
    examples: [
      'open notifications', 'open the notifications', 'open notifications panel',
    ],
  },
  'system.tools.open_documents': {
    opensPanel: 'knowledge-base',
    examples: [
      'open documents', 'open the documents', 'open knowledge base', 'open document search',
    ],
  },
  'system.tools.open_marketplace': {
    opensPanel: 'marketplace',
    examples: [
      'open marketplace', 'open the marketplace', 'open pack marketplace', 'open the pack store',
    ],
  },
  // Round-6 audit (2026-08-24): repo-map opener — the panel is the visual counterpart of the
  // whole-project map the AI prompt receives.
  'system.tools.open_repo_map': {
    opensPanel: 'repo-map',
    examples: [
      'open repo map', 'open the repo map', 'show the repo map', 'show me the repo map',
    ],
  },
  'system.tools.open_folder_explorer': {
    opensPanel: 'folder-explorer',
    examples: [
      'open folder explorer', 'open the folder explorer', 'open file explorer', 'open the file explorer',
      'browse a folder', 'browse folders', 'explore folders',
    ],
  },
};