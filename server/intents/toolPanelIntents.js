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
};