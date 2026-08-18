import type { ReactNode } from 'react';

// Phase T2 (2026-08-14): the tour system — named sections, each a sequence of steps shown
// in TourOverlay. Two rendering modes per section (chosen in the picker / via settings):
//  - card: the classic modal-card steps (icon/title/body) — works from any view;
//  - guided: card steps that also drive the app (view) and spotlight a real element
//    (target = a `data-tour` attribute on a control; TourOverlay scrolls it into view and
//    draws a ring). Steps without a target render as plain cards inside the guided tour.
// Completion badges persist to localStorage 'console.toursTaken' (inline style, like
// pinned projects).
export interface TourStep {
  icon: ReactNode;
  title: string;
  body: string;
  /** Guided mode: the app view this step needs active (the overlay switches to it first). */
  view?: 'tools' | 'dashboard' | 'chat' | 'general';
  /** Guided mode: a data-tour id to spotlight (scrolls into view + ring). */
  target?: string;
}

export interface TourSection {
  id: string;
  label: string;
  description: string;
  steps: TourStep[];
}

export const TOUR_SECTIONS: TourSection[] = [
  {
    id: 'welcome',
    label: 'Welcome',
    description: 'The basics — what this app is and where everything lives.',
    steps: [
      {
        icon: '✦',
        title: 'Welcome to Project Console',
        body: 'Your local, offline command center for every project on your machine. Browse any folder, run commands, check git status, and ask questions — all without leaving this window. AI mode is off by default; you control when it activates.',
      },
      {
        icon: '◇',
        title: 'Projects & Navigation',
        body: 'Every discovered project appears in the grid (or the sidebar list). Click any card to open a chat scoped to that project — sessions, commands, and file access all stay inside its folder.',
        view: 'general',
      },
      {
        icon: '☰',
        title: 'The Sidebar',
        body: 'The left rail holds the project list, your chat sessions, and the scan box — point it at any directory on your machine. The star pins a project to the top.',
        view: 'chat',
        target: 'sidebar',
      },
      {
        icon: '✓',
        title: "You're All Set",
        body: 'The Dashboard button shows live status for every project at a glance. Everything works offline, nothing leaves your machine.',
      },
    ],
  },
  {
    id: 'general',
    label: 'General mode',
    description: 'The tools-first workspace for non-code folders — files, notes, PDFs, reminders.',
    steps: [
      {
        icon: '▦',
        title: 'General Workspace',
        body: 'General mode is the tools-first landing: a card grid of interactive panels instead of git/npm commands. Switch between Developer and General with the header tabs.',
        view: 'general',
      },
      {
        icon: '▦',
        title: 'Include Every Folder',
        body: 'Settings → "Include every folder as a project" makes General mode show EVERY subfolder of the scan root — even folders with no code at all (they classify as General). Off by default so junk stays hidden.',
        view: 'general',
        target: 'tools-button',
      },
      {
        icon: '◫',
        title: 'Folder Explorer',
        body: 'The Folder Explorer panel browses ANY folder on disk — paste a path, descend into subfolders, and switch between Lines (list) and Objects (grid) views with the toggle at the bottom. Open files in your IDE from the row menu.',
        view: 'tools',
        target: 'tool-folder-explorer',
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools panels',
    description: 'The shared panel surface — every utility behind one card grid.',
    steps: [
      {
        icon: '▦',
        title: 'Tools Grid',
        body: 'Click Tools in the header (or type "open calculator" / "open pdf tools" in chat) for the interactive panels: Calculator, PDF Tools, Reminders, File Tools, Folder Explorer, Notes, Spreadsheet, Clipboard, Backup, Notifications, Documents, and Pack Marketplace.',
        view: 'tools',
        target: 'tools-button',
      },
      {
        icon: '▦',
        title: 'Panels from Chat',
        body: 'Every panel has a chat-native equivalent. Typing "open file tools" opens the panel AND shows a CLI-usable answer — the terminal stays the single source of truth for confirms and results.',
        view: 'chat',
      },
      {
        icon: '▦',
        title: 'PDF Tools & More',
        body: 'Merge, split, watermark, extract text. Or organize folders with File Tools, query CSVs with Spreadsheet, jot notes, set reminders — all offline, all confirm-gated where they mutate.',
        view: 'tools',
        target: 'tool-pdf-tools',
      },
    ],
  },
  {
    id: 'developer',
    label: 'Developer mode',
    description: 'The dev workspace — git, npm, run commands, diagnostics.',
    steps: [
      {
        icon: '⌘',
        title: 'Developer Workspace',
        body: 'Developer mode is chat-first: trigger-mode commands (git push, run the site, run the tests) work without AI. Toggle it from the header tabs.',
        view: 'chat',
      },
      {
        icon: '⌘',
        title: 'Typed Commands',
        body: 'Type an exact command line ("python main.py serve", "ng serve") and it runs directly — no matcher in the way. Risky commands always confirm first, with a checkpoint.',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '⌘',
        title: 'Open in Your IDE',
        body: '"open main.py with PyCharm", "open app.ts in IntelliJ", or "open X in the editor" for the per-extension default. "open X in the folder" reveals the file in your file explorer. Configure editors in Settings → Editors & IDEs.',
        view: 'chat',
        target: 'chat-input',
      },
    ],
  },
  {
    id: 'chat-ai',
    label: 'Chat & AI',
    description: 'The terminal, sessions, exports, and the optional AI assistant.',
    steps: [
      {
        icon: '◌',
        title: 'The Terminal',
        body: 'Every command, answer, and confirm card lives here. ↑/↓ recall history, Ctrl+K opens the command palette, Ctrl+R searches history.',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '◌',
        title: 'Sessions',
        body: 'Chats are per project and persist in the sidebar. Click a project to start a fresh chat scoped to it; the session lock keeps conversations tied to their folder.',
        view: 'chat',
        target: 'sidebar',
      },
      {
        icon: '◌',
        title: 'AI Assistant',
        body: 'Toggle AI ON for natural-language work: ask questions about code, read/write files, run commands. Every write or risky action asks for approval first — the AI never acts without your say-so.',
        view: 'chat',
        target: 'ai-toggle',
      },
    ],
  },
  {
    id: 'tabs',
    label: 'Tabs & Folders',
    description: 'Chrome-style tabs — each tab scans its own folder.',
    steps: [
      {
        icon: '▭',
        title: 'Project Tabs',
        body: 'The tab strip above the main view works like a browser: each tab owns its own scan folder, project list, and open chat. Click a tab to switch — its projects and chat come back exactly as you left them.',
        view: 'chat',
        target: 'tab-strip',
      },
      {
        icon: '▭',
        title: 'Duplicate Tab',
        body: 'Hit "New tab" to duplicate the current tab — the first tab keeps its folder while the new one scans somewhere else. Two folders, side by side, one console.',
        view: 'chat',
        target: 'tab-new',
      },
      {
        icon: '▭',
        title: 'Tab Persistence',
        body: 'Your tab layout (which folder each tab points at) survives reloads — the server re-scans each stored root on startup.',
        view: 'chat',
        target: 'tab-strip',
      },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Profile, editors, explorer defaults, tours, and advanced tuning.',
    steps: [
      {
        icon: '⚙',
        title: 'User Profile',
        body: 'The gear opens your profile: name, title, accent color, sandbox mode, clipboard options, scan-all-folder inclusion, and the Folder Explorer default view.',
        view: 'chat',
        target: 'settings-button',
      },
      {
        icon: '⚙',
        title: 'Editors & IDEs',
        body: 'Add or remove editors (name + launch command) and pick per-extension defaults — .py opens PyCharm, .java opens IntelliJ, .html opens the browser, and so on.',
        view: 'chat',
        target: 'settings-button',
      },
      {
        icon: '⚙',
        title: 'Advanced Tuning',
        body: 'Power users can override matcher/executor constants live via the Developer/Advanced section — the defaults are tuned for most setups, so change them only if you know what they do.',
        view: 'chat',
        target: 'settings-button',
      },
    ],
  },
];

export function getTourSection(id: string): TourSection | null {
  return TOUR_SECTIONS.find((s) => s.id === id) || null;
}

export function readToursTaken(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('console.toursTaken') || '{}');
  } catch { return {}; }
}

export function markTourTaken(id: string) {
  const taken = readToursTaken();
  taken[id] = true;
  try { localStorage.setItem('console.toursTaken', JSON.stringify(taken)); } catch {}
}
