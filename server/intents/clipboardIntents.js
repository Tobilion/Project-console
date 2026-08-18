// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): clipboard + snippet intents — all tagged
// `opensPanel: 'clipboard'` where they have a panel equivalent. The history intents answer
// honestly when the opt-in clipboardHistory setting is off (the panel explains the same).
export const CLIPBOARD_INTENTS = {
  'clipboard.show': {
    opensPanel: 'clipboard',
    examples: [
      'show clipboard history', 'what is on my clipboard history', 'clipboard history',
    ],
  },
  'clipboard.copy_item': {
    opensPanel: 'clipboard',
    examples: [
      'copy clipboard item 2', 'recopy clipboard item 1',
    ],
  },
  'clipboard.clear': {
    examples: [
      'clear clipboard history',
    ],
  },
  'clipboard.remove_item': {
    opensPanel: 'clipboard',
    examples: [
      'remove clipboard item 2', 'delete clipboard item 1',
    ],
  },
  'snippet.save': {
    opensPanel: 'clipboard',
    examples: [
      'save this as a snippet: welcome', 'save last output as snippet deploy-cmd',
      'save a snippet named ssh-keys',
    ],
  },
  'snippet.show': {
    opensPanel: 'clipboard',
    examples: [
      'show my snippets', 'list my snippets',
    ],
  },
  'snippet.copy': {
    opensPanel: 'clipboard',
    examples: [
      'copy snippet welcome', 'use snippet deploy-cmd',
    ],
  },
  'snippet.delete': {
    opensPanel: 'clipboard',
    examples: [
      'delete snippet welcome', 'remove snippet old-notes',
    ],
  },
};
