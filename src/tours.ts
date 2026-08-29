import type { ReactNode } from 'react';

// Phase T2 (2026-08-14): the tour system — named sections, each a sequence of steps shown
// in TourOverlay. Two rendering modes per section (chosen in the picker / via settings):
//  - card: the classic modal-card steps (icon/title/body) — works from any view;
//  - guided: card steps that also drive the app (view + optional panel) and spotlight a real
//    element (target = a `data-tour` attribute on a control; TourOverlay scrolls it into view
//    and draws a ring). Steps without a target render as plain cards inside the guided tour.
// Completion badges persist to localStorage 'console.toursTaken' (inline style, like
// pinned projects).
export interface TourStep {
  icon: ReactNode;
  title: string;
  body: string;
  /** Guided mode: the app view this step needs active (the overlay switches to it first). */
  view?: 'tools' | 'dashboard' | 'chat' | 'general' | 'commandRef';
  /** Guided mode: open this Tools panel before spotlighting (only when view is 'tools'). */
  panel?: string;
  /** Guided mode: a data-tour id to spotlight (scrolls into view + ring). */
  target?: string;
}

export interface TourSection {
  id: string;
  label: string;
  description: string;
  steps: TourStep[];
}

export interface TourGroup {
  id: string;
  label: string;
  description: string;
  sectionIds: string[];
}

export const TOUR_GROUPS: TourGroup[] = [
  {
    id: 'orient',
    label: 'Get Oriented',
    description: 'Welcome, finding projects, tabs & sidebar',
    sectionIds: ['welcome', 'discovery', 'tabs'],
  },
  {
    id: 'work',
    label: 'Do Work',
    description: 'Chat, developer vs general, tools & knowledge',
    sectionIds: ['chat-ai', 'developer', 'general', 'tools'],
  },
  {
    id: 'power',
    label: 'Power Features',
    description: 'Personal tools, PDFs, automation & ops',
    sectionIds: ['productivity', 'office', 'settings'],
  },
];

export const TOUR_SECTIONS: TourSection[] = [
  {
    id: 'welcome',
    label: 'Welcome',
    description: 'The shell — what this app is and how the header + tabs hold everything together.',
    steps: [
      {
        icon: '✦',
        title: 'Welcome to Project Console',
        body: 'Your local, offline command center for every project on your machine. Every message goes through a deterministic matching pipeline first — no AI or network is required to run tests, check git, or ask what a project does. AI is an opt-in layer on top that uses the same confirm cards and safety checks as you typing directly. Nothing leaves your machine unless you choose a cloud model or a remote pack registry.',
      },
      {
        icon: '◇',
        title: 'The Header Is the Switchboard',
        body: 'The top bar is always visible. Left side is the brand and live badges: how many dev servers are green, which port the console itself is on (:3000-3019), and an “Indexing…” pulse when a project is being scanned. The pill in the middle is Developer vs General — it only filters which commands are suggested, never what you can run. Right side holds Home, Command Deck (Ctrl+K), Command Reference (book), Dashboard, Tools, Profile, Tours, and Theme.',
        view: 'general',
        target: 'tools-button',
      },
      {
        icon: '▭',
        title: 'Tabs Are Workspaces',
        body: 'The strip below the header is Chrome-like: each tab owns its own scan folder, project list, and open chat. “New tab” duplicates the current tab so the first keeps its folder while the new one scans somewhere else. Ctrl+Tab / Ctrl+Shift+Tab cycles them. The tab label shows the folder name — or the active project name when that tab has one selected — so you can tell at a glance which workspace you are in.',
        view: 'chat',
        target: 'tab-strip',
      },
      {
        icon: '☰',
        title: 'Welcome Screen vs Chat',
        body: 'Until you pick a project you land on the welcome screen: a stats strip (files, dirs, langs, entry points), three hero actions (New Chat, Quick Start Guide, Take the Tour), and the Bento grid of discovered projects. Click any project card and the same area becomes the chat thread — same column, same width, no navigation jump. Home (house icon) always brings you back to welcome without losing your tabs or chats.',
        view: 'general',
      },
      {
        icon: '✓',
        title: "You Are Offline-First",
        body: 'Everything you just saw works without internet: discovery, file tools, PDFs, the matcher, and local Ollama models. The only features that need network are web search/deep research, cloud models (suffix :cloud), and remote pack installs — and they all proxy through your local daemon. Shortcuts: “?” shows all shortcuts, Ctrl+K opens the command palette from anywhere.',
      },
    ],
  },
  {
    id: 'discovery',
    label: 'Finding Projects',
    description: 'How a folder becomes a project, how to open one, and Bento cards.',
    steps: [
      {
        icon: '⌕',
        title: 'The Scan Box',
        body: 'The sidebar’s top row is the scan box: a text input that holds the current scan path, a magnifying-glass button that opens the native folder picker (Chromium only), and Scan. Paste any absolute path — e.g. C:\\Users\\tobi\\Projects — and hit Scan. The browser can never give a real absolute path by itself (a hard File API limit), so pasting the full path is the supported way to jump anywhere on disk. Name-only picks resolve against the current root or its parent.',
        view: 'chat',
        target: 'scan-input',
      },
      {
        icon: '▦',
        title: 'What Counts as a Project',
        body: 'The scanner walks the base dir and keeps a subfolder when it finds console.config.json, a CLAUDE.md/README.md/ABOUT-*.md, a package.json, or — with no docs at all — real source in ~19 languages, a recognized config file (Cargo.toml, go.mod, requirements.txt, etc.), or a real .git dir. PDF-only folders with no code are kept too but classify as General (see the workspace pill). Turn on Settings → “Include every folder” to list every subfolder even with zero signals — off by default so junk stays hidden.',
        view: 'chat',
        target: 'bento-grid',
      },
      {
        icon: '◈',
        title: 'Bento Cards',
        body: 'Each discovered project renders as a Bento card: folder name, truncated path tooltip, count of context docs and trigger entries. The active project gets a blue left-border accent. The per-card workspace toggle (hidden until hover) lets you add/remove that project from the multi-project workspace chip in the terminal header — useful when you want to ask questions that span two projects. Click the card body to open a fresh chat locked to that folder.',
        view: 'general',
        target: 'bento-grid',
      },
      {
        icon: '↗',
        title: 'Opening Is Locking',
        body: 'Clicking a project card creates a new session whose session.projectId and session.projectPath are permanently tied to that folder (see conversationStore.js). Every later message in that chat resolves file reads, command execution, and tool calls inside that folder via realpath containment — even symlinks cannot escape. Switching projects always starts a fresh chat; “linkSessionToProject” exists but nothing calls it by design — history stays per-folder.',
        view: 'chat',
      },
      {
        icon: '⧉',
        title: 'Finding It Later',
        body: 'Two other ways to jump: the Dashboard (grid icon in header) shows every project with git/dev-server health and an Open-in-chat button that reuses the existing chat for that project; and the Command Deck (Ctrl+K) has a Projects section — typing “netpulse” there filters to that project instantly, with a preview pane showing its path and a one-click open.',
        view: 'chat',
        target: 'sidebar',
      },
    ],
  },
  {
    id: 'tabs',
    label: 'Tabs & Sidebar',
    description: 'Chrome-style tabs, the sidebar rail, and chat history.',
    steps: [
      {
        icon: '▭',
        title: 'Project Tabs',
        body: 'Each tab stores scanPath + activeProjectId + activeSessionId + view + activeToolPanel (see useConsoleTabs.ts). The list persists to localStorage console.tabs, and on reload the server re-scans each tab’s stored root concurrently so a workspace of 4 tabs doesn’t pay N serial scans. Closing the last tab always leaves a fresh default tab (id null) — the pre-tab “global workspace” — so there is always at least one place to chat.',
        view: 'chat',
        target: 'tab-strip',
      },
      {
        icon: '＋',
        title: 'Duplicate & Close',
        body: '“New tab” is a duplicate: it inherits the current tab’s scan folder and the current top-level view plus open tool panel (useConsoleTabs.duplicateTab). That means you can have the Folder Explorer open on C:\\Data in tab A while tab B scans C:\\Projects, side by side. Middle-click on a tab or its × closes it; closing the active tab activates the tab to its left (Chrome/VS Code behavior), and the server workspaces for closed tabs are GC’d on next fetch.',
        view: 'chat',
        target: 'tab-new',
      },
      {
        icon: '☰',
        title: 'The Sidebar Rail',
        body: 'The left rail is 240px bg-overlay with 5 blocks from top to bottom: scan box → New Chat (scoped to the active project or General when no project) → Chats header → chat list → Projects header → project list → AI footer. Collapse it with the chevron and it shrinks to a 48px icon rail (scan / new chat / projects / brain) so the chat thread gets the full width. Your collapsed preference is not persisted — it resets on reload by design.',
        view: 'chat',
        target: 'sidebar',
      },
      {
        icon: '◫',
        title: 'Chats: General | Projects',
        body: 'The chat list is split into two tabs: General holds chats with no projectId (or the reserved __general__ pseudo-project at data/general-workspace/), Projects holds everything else. Filter the visible tab by title — the search is client-side, no server round-trip. Each row shows the chat title, its project name or workspacePath folder, and hover actions: pencil to rename inline (Enter to commit, Esc to cancel) and trash to delete. The maximize button opens the full Chat History overlay.',
        view: 'chat',
        target: 'sidebar',
      },
      {
        icon: '★',
        title: 'Projects List & Chat History',
        body: 'Below chats, pinned projects float to the top (yellow star, accent exception). Each row has a pin toggle and a workspace toggle. Long lists scroll with thin scrollbars. The Chat History overlay (maximize or chat top bar) shows all chats across tabs in the same General|Projects tabs, with search and delete — clicking a row transparently switches to the tab that owns that chat’s workspacePath, opening a fresh tab if none owns it (openWorkspaceTab).',
        view: 'chat',
        target: 'chats-list',
      },
    ],
  },
  {
    id: 'chat-ai',
    label: 'Chat & AI',
    description: 'The terminal thread, sessions, exports, AI modes, and the tool loop.',
    steps: [
      {
        icon: '◌',
        title: 'The Terminal Thread',
        body: 'Every command, answer, and confirm card lives here as a single scroll column (flex-1 overflow-y-auto). New output auto-scrolls only when you are already near the bottom, so reading older output isn’t yanked down. Inline cards are prompt-specific: a confirm_prompt for risky shell commands (5-min TTL), a tool_confirm_prompt for AI file writes (with a before/after LCS diff preview), and a memory_suggestion card. Esc rejects a pending card. “Load earlier” paginates the persisted NDJSON log when the in-memory buffer is smaller than the session file.',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '↕',
        title: 'Input: History & Completion',
        body: '↑/↓ recalls per-project command history (stored in localStorage lpc:history:<project.id>, capped 200, deduped). Tab completes against KNOWN_COMMANDS; Ctrl+R opens a filterable history overlay filtered by substring. Submit is blocked while a confirm card is pending (isBlocked). While the AI is thinking or a server command is pending, the placeholder says so and the input is disabled. Fullscreen centers the thread to a max-w-3xl readable column and adds a top-right Exit affordance.',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '⬇',
        title: 'Exports & Session Menu',
        body: 'The terminal header’s download icons and the gear session menu export the same thing three ways: Markdown and JSON come from GET /api/sessions/:id/export?format=md|json (uncapped NDJSON, never the 200-message cap), and PDF is built client-side from that JSON via jspdf with ASCII-mapped glyphs. There is also a per-project “Export project chat log” that downloads .console/chat-log.md directly. All downloads are plain GETs — no temp files on the server.',
        view: 'chat',
        target: 'terminal-header',
      },
      {
        icon: '◐',
        title: 'AI On: Models & Modes',
        body: 'The AI toggle in the input bar is off by default — that is the sole opt-in gesture (the old double-gate consent_request was removed). On toggle-on it probes /api/ollama/status and prefers a cloud model when reachable, else a local one, unless you already chose. Local models (ollama pull qwen2.5-coder:7b) run offline; cloud models (:cloud suffix) still proxy through the local daemon after ollama signin — no separate provider integration. Mode picker (Default/Coding/Tutor/Creative/Consultant/Structured) only changes the system-prompt preamble.',
        view: 'chat',
        target: 'ai-toggle',
      },
      {
        icon: '⬡',
        title: 'AI Tool Loop & Gating',
        body: 'When AI is on, the model can call up to 6 rounds of tools: readFile, writeFile, editFile (multi-hunk all-or-nothing, whitespace-normalized), findFiles, insertAtLine, appendToFile, searchCode (RE2), listFiles, getProjectInfo, getGitStatus, undoLastChange, saveMemory, executeCommand, probeUrl, runTests, webSearch, deepResearch — all sandboxed to the active project. Writes, risky executeCommand, runTests and stopProcess are ALWAYS_CONFIRM_TOOLS — no session grant or console.tools.json allow-after-first-ask can waive them. “Approve this task” pre-grants only the non-risky file tools for that session+project. Every write is syntax-checked and journaled so revert action <id> still works.',
        view: 'chat',
        target: 'ai-toggle',
      },
    ],
  },
  {
    id: 'developer',
    label: 'Developer mode',
    description: 'Git, npm, run commands, typed bypass, checkpoints, and auto-start.',
    steps: [
      {
        icon: '⌘',
        title: 'Developer Is Suggestion-Only',
        body: 'Developer vs General is a suggestion filter (see WORKSPACE_DEV_ONLY_INTENTS in intentRegistry.js), never a hard gate. Dev intents (git, run, diagnostics, code search) are hidden from suggestion chips and did-you-mean when in a General folder, but typing “git push” there still matches and runs identically. The last-used tab per project is remembered in localStorage console.workspaceTabByProject, and switching via the pill sends “switch to developer/general mode” through normal chat so the server’s help filtering matches immediately.',
        view: 'chat',
      },
      {
        icon: '⌘',
        title: 'Trigger Commands (No AI)',
        body: 'These phrases need no AI: git status/log/diff/branch/checkpoint/push/commit/deploy (checkpoint + push), npm install/build/run, “run the site on port N” (rewrites the script’s --port flag or falls back to PORT env), “where is the link / link?” (probed dev URL), “stop the server” (kills only tracked processes via stopTrackedProcess with Windows taskkill verification). Risky ones ask on a confirm card with a 5-min token, create a console-checkpoint commit via a -F tempfile (cmd.exe ignores \\" escaping), and journal with actionIds for the undo toast.',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '⌘',
        title: 'Typed Commands Bypass the Matcher',
        body: 'Type an exact shell line (“python main.py serve”, “ng serve”, “git status -sb”) and it runs directly — no intent routing. Single-token commands require the allowlist (toolAllow.js: npm, node, git, python, npx, vite, ng, flutter, dart, cargo, go, mvn, dotnet, ruby, php, …). Multi-token lines also try PATH plus the project’s node_modules/.bin (so a project-local ng works). Natural input like “find duplicate files” is kept away from the real Windows find.exe via a natural-lang guard (typedCommand.js).',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '⌘',
        title: 'Open In Your IDE',
        body: '“open main.py with PyCharm”, “open app.ts in IntelliJ”, or “open X in the editor” for the per-extension default. “open X in the folder” reveals the file in Explorer/Finder. The registry lives in data/editors.json (seeded with 9 editors — VS Code, Cursor, PyCharm, IntelliJ, WebStorm, Sublime, Notepad++, VS, Android Studio — plus .py→pycharm, .java→idea, .html→browser, etc.). Edit them in Settings → Editors & IDEs (per-extension Default column). The Folder Explorer also double-clicks a file into its OS default app.',
        view: 'chat',
        target: 'chat-input',
      },
      {
        icon: '⌘',
        title: 'Safety Net: History & Auto-Start',
        body: 'Every mutating step journals a pre-image to .console/action-history.jsonl (cap 2000). “show history / recent actions N / revert action <id>” replays it — file_* restores content or deletes, file_move moves back, backups/ deletes the zip outside the project. The destructive answer’s Undo toast (8s, batch revert in one card) and the ProcessDock History tab use the same reverts. “auto-start this project” stores the launch phrase and re-matches it on every boot via taskQueue (skips when the site already answers, stagger 20s), and intent collisions are checked at boot for drift alarms.',
        view: 'chat',
      },
    ],
  },
  {
    id: 'general',
    label: 'General mode',
    description: 'The tools-first workspace for non-code folders — what “General” means.',
    steps: [
      {
        icon: '▦',
        title: 'General Is Tools-First',
        body: 'Switching the header pill to General makes the main view land on the Tools card grid (useAppViewState.ts General-tools-first) instead of chat — chat stays one click away via the grid’s close/back or the header Tools toggle. Project cards in General hide git/npm/dev-server panels and actions (no fake data invented) and show the chosen panels plus Open in chat / Copy path / history. With no project picked, General lands on chat instead so you can talk before choosing a folder.',
        view: 'general',
      },
      {
        icon: '▦',
        title: 'Include Every Folder',
        body: 'Settings → “Include every folder as a project” (data/user-profile.json scanAllFolders) makes discovery keep every immediate subfolder even with zero code/git/config — each classifies as General with a synthesized fallback config. Off by default so junk stays hidden. After toggling, hit Scan to apply; the watcher re-scans automatically and the container scan’s hasRootPdf / single-root escape respects it.',
        view: 'general',
        target: 'tools-button',
      },
      {
        icon: '◫',
        title: 'The __general__ Pseudo-Project',
        body: 'With no project selected, chat still works — it resolves to the reserved id __general__ (GENERAL_PROJECT_ID) rooted at data/general-workspace/ (console-owned, gitignored). REST calls hit /api/projects/__general__/… and sessions lock to that id exactly like a real project (handleExecute’s session lock checks projectPath too, so same-named folders on different roots can’t collide). The General workspace is chat + Tools; personal panels still function there.',
        view: 'general',
      },
      {
        icon: '⚙',
        title: 'What Still Works in General',
        body: 'All personal tools are workspace-agnostic: Notes, Reminders, Folder Explorer, Spreadsheet, Clipboard, Backup, Documents, PDF tools — they never check workspaceType. general.files intents (find/tidy/duplicates/duplicates_delete) are deliberately NOT in WORKSPACE_DEV_ONLY_INTENTS so “tidy this folder” runs from any tab. Dev commands typed in a General folder still execute — they just won’t be suggested until you flip to Developer.',
        view: 'tools',
        target: 'tools-button',
      },
      {
        icon: '↔',
        title: 'Switching Without Losing Place',
        body: 'Flipping the pill writes console.config.json workspaceType (atomic) and broadcasts project_updated so the server help/didYouMean filtering updates. The tab’s view snapshot (registerViewSync in useAppViewState) remembers where you were — flip Developer→General→Developer and chat returns exactly where it was, not the dashboard. Dashboard per-card rendering uses the entry’s own workspaceType, falling back to the dashboard prop only for stale caches.',
        view: 'general',
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools & Knowledge',
    description: 'The Tool grid, Folder Explorer, File Tools, Repo Map, and Documents.',
    steps: [
      {
        icon: '▦',
        title: 'Tools Grid',
        body: 'The Tools view is server-driven via GET /api/tool-panels (ToolPanelRegistry) — the server decides which of the 13 panels are available without a client update, and the retry button re-fetches after a failure. Each card shows icon, name, one-line description, and an “unavailable” badge when env misses a dependency. The same panels open from chat via “open calculator / open pdf tools” (the answer carries additive openPanel, the CLI just prints the note). Ask mode never blocks opening a panel — it only blocks mutating tool calls.',
        view: 'tools',
        target: 'tools-grid',
      },
      {
        icon: '▦',
        title: 'Folder Explorer (Deep)',
        body: 'The most used General panel: browse any absolute path on disk (not project-scoped) with breadcrumbs + back/forward/up/home/refresh. Middle search bar filters the current listing by name (client-side, ESC clears). Toggle at the bottom is Lines (list rows: name/size/date) vs Objects (icon tiles sm/md/lg). Double-click or Enter on a file opens it in the OS default app via POST /api/browse/open; per-file menu offers Open in editor, Open with… (editor chooser), Reveal, Copy path, Open in browser (.html). View/size/path persist to localStorage.',
        view: 'tools',
        panel: 'folder-explorer',
        target: 'folder-explorer-panel',
      },
      {
        icon: '▦',
        title: 'File Tools (Deep)',
        body: 'Finder-style, but project-scoped (needs an active project): Search & Browse (name+content, .html Preview in an iframe via static/*), Tidy plan (moves loose root files into Images/Documents/etc or YYYY/MM, shows plan → confirm → journals file_move), and Duplicates (MD5-by-size groups, newest wins, keep-newest delete). Tidy and duplicates_delete are confirm-gated with checkpoint + journaling so revert action <id> undoes either. GET /api/projects/:id/files|search-files|tidy-plan|duplicates back it.',
        view: 'tools',
        panel: 'file-tools',
        target: 'file-tools-panel',
      },
      {
        icon: '▦',
        title: 'Repo Map',
        body: 'The codebase-index viewer: every file’s top-level exports/functions/classes, imports, and reverse “used by” edges, plus detected API routes and monorepo sub-packages — exactly the structure injected into the AI system prompt. Search the map, pick a file, see its symbol list. Served by GET /api/projects/:id/repo-map from the cached codebaseIndex; build is on-demand via POST /api/projects/:id/index. Pure read-only — a complement to the matcher’s repo-map injection and the symbol-graph slice.',
        view: 'tools',
        panel: 'repo-map',
        target: 'repo-map-panel',
      },
      {
        icon: '▦',
        title: 'Documents Knowledge Base',
        body: 'Offline semantic search over the project’s PDFs, .docx (via mammoth), and .md/.txt notes via the same embedding index as code search (<project>/.console/code-index.json, chunked ~40 lines, background builds via taskQueue, in-memory brute-force cosine at ask time). “search my documents for X” or “what did i write about the budget” returns file:line citations; with AI on, a synthesized answer renders above the raw chunks — the chunks are always the fallback, never suppressed. Panels: Tools > Documents shows status (unavailable/indexing/ready).',
        view: 'tools',
        panel: 'knowledge-base',
        target: 'knowledge-base-panel',
      },
      {
        icon: '▦',
        title: 'From Panel to Chat (Single Source of Truth)',
        body: 'A panel never writes behind chat’s back. Folder Explorer “Open in PyCharm” sends “open main.py with PyCharm” into chat; PdfToolsPanel Merge sends “merge alpha.pdf and beta.pdf into combined.pdf”; File Tools Tidy sends the tidy trigger — so confirm cards, journaling, and the undo toast stay in the terminal as the one observable truth. The dashboard’s Run/Stop/Push buttons do the same. If the CLI can’t render a panel, it gets the same answer text without openPanel.',
        view: 'tools',
      },
    ],
  },
  {
    id: 'productivity',
    label: 'Personal Tools',
    description: 'Notes, Reminders, Clipboard & snippets, Backup.',
    steps: [
      {
        icon: '✎',
        title: 'Notes (Apple Notes-style)',
        body: 'Tools > Notes is a 2-column split (240px list rail + editable surface). Notes live per-project at .console/notes.md (capped 200, deduped, per-project write lock) — deliberately separate from AI memory.md (AI-authored) and project-memory.json (JSON usage patterns). Chat: “note: buy milk” appends immediately, no confirm; “show my notes / search my notes for wifi” lists/filters. Selection + filter persist per project in localStorage console.notesSelection.<id>. The AI never reads or writes your notes unless you paste them.',
        view: 'tools',
        panel: 'notes',
        target: 'notes-panel',
      },
      {
        icon: '⏰',
        title: 'Reminders (Apple Reminders-style)',
        body: 'Tools > Reminders sections Today/Upcoming/All/No Date, with quick-add and checkbox-complete that cancels via cancel reminder. Chat: “remind me tomorrow at 9am to call accounting” / “every friday at 5pm” / “in 3 days”. Free-form dates are parsed by chrono-node plus weekday/daily/interval branches parsed BEFORE chrono so the scheduler gets a concrete recurrence type. Fires via the same 15s scheduler tick as schedules (setInterval, unref’d), delivering to the creating session → any session → data/schedule-log.md, with an optional notify toast/ webhook.',
        view: 'tools',
        panel: 'reminders',
        target: 'reminders-panel',
      },
      {
        icon: '⎘',
        title: 'Clipboard & Snippets',
        body: 'Tools > Clipboard has pinned snippets (top) over an OS clipboard history stack. Text blocks persist globally to data/snippets.json; history is an in-memory 25-entry ring (deduped, polling Get-Clipboard/pbpaste/xclip every CLIPBOARD_POLL_MS). Two separate opt-ins in Profile → Advanced: “Track clipboard history” (poll) and “Persist clipboard history to disk” (data/clipboard-history.json — bigger privacy commitment, own toggle). All writes are server-side Set-Clipboard via PowerShell 5.1/base64 so CLI copies for real; copy_to_clipboard WS is display-only. Chat: “show clipboard history / copy snippet welcome / save this as a snippet: …”.',
        view: 'tools',
        panel: 'clipboard',
        target: 'clipboard-panel',
      },
      {
        icon: '⧉',
        title: 'Backup (Time Machine-style)',
        body: 'Tools > Backup lists data/backups/<name>-<timestamp>.zip reverse-chronologically with Download + Reveal. Chat: “backup this folder” or “export this project as a zip” / “list backups” (intents tagged opensPanel: backup). The zip is archiver@7 (v8 is a breaking rewrite), capped 50MB, skips IGNORE_DIRS (node_modules/.git/.console/dist). Creating a zip is read-only w.r.t. the source and needs no confirm, but it journals a file_write existed:false so revert action <id> deletes it — the revert special-cases the backups/ prefix to delete the real zip in data/backups even though the path is outside the project.',
        view: 'tools',
        panel: 'backup',
        target: 'backup-panel',
      },
      {
        icon: '◎',
        title: 'The Persistence Contract',
        body: 'Notes go to .console/notes.md, Reminders to the same data/schedules.json as schedules (via reminderParser), Clipboard to data/snippets.json + optional data/clipboard-history.json, Backup zips to data/backups. All four are gitignored except notes/memory which sit inside .console (and .console is auto-gitignored on first session). Backup and Reminders mutations go through the normal WS chat path, so the terminal still journals and can revert; Notes appends are immediate and unconditional — your scratch pad, not a risky action.',
        view: 'tools',
      },
    ],
  },
  {
    id: 'office',
    label: 'PDF & Spreadsheet',
    description: 'The offline office toolkit: PDF verbs, CSV deterministic engine, and uploads.',
    steps: [
      {
        icon: '◰',
        title: 'PDF Toolkit',
        body: 'Tools > PDF Tools covers every handler in builtinPdfTools: merge these pdfs into combined.pdf (multi-select chips), split report.pdf at page 5 or into one file per page, extract text from report.pdf (read-only preview, no confirm), extract pages 2-5 … into excerpt.pdf, watermark report.pdf with confidential (stamps every page). All writes are confirm-gated + journaled (revert deletes them) and never overwrite an existing output (a binary pre-image can’t be journaled, so overwrite would be unrevertable). Caps: 200 files, 10 merge inputs, 150MB, 2000 pages. Panel composes the exact chat trigger strings.',
        view: 'tools',
        panel: 'pdf-tools',
        target: 'pdf-tools-panel',
      },
      {
        icon: '⎙',
        title: 'Spreadsheet (CSV) — Deterministic',
        body: 'Tools > Spreadsheet picks a CSV + column and runs a dependency-free quoted-field parser (2MB/20k-row caps): sum/average column X in Y, count rows in Y where X <op> v, filter Y where X <op> v (ops: equals/contains/greater than/less than). read-only by design — no filter-to-file write exists (a future one must go through confirm + action-history). Results render as a sortable zebra table with sticky headers. Chat: the same four intent shapes with identical validation via isSafeParamValue for column/file names.',
        view: 'tools',
        panel: 'csv-tools',
        target: 'csv-tools-panel',
      },
      {
        icon: '⬆',
        title: 'Uploads & File Scoping',
        body: 'Both panels support drag-drop uploads: POST /api/projects/:id/pdf-upload (50MB, basename-sanitized via createResolveSafe, never overwrites) and POST /api/projects/:id/csv-upload (2MB). Scope is the active project — PDFs/CSVs are listed via GET /api/projects/:id/pdf-files|csv-files and served via /file?path= with the same escape rejection as file tools (reveal uses POST /api/projects/:id/reveal to open in Finder/Explorer). Bare verb-only input like “merge pdfs” opens the panel; real filenames execute in chat.',
        view: 'tools',
        panel: 'pdf-tools',
        target: 'pdf-tools-panel',
      },
      {
        icon: '⚠',
        title: 'Matcher Guards',
        body: 'PDF verbs are common words — “merge this branch into main” must not become a PDF merge. Pre-semantic overrides pin a pdf verb (merge/combine/join, split, extract, watermark) PLUS a pdf mention (.pdf, the word pdf, “pdf file”) before embedding, so only .pdf-bearing shapes hit the panel; non-pdf senses stay embedding-driven. Spreadsheet had the same problem with “.csv + where-values carry no embedding weight” — the pin keeps them reliable. Check-matcher PDF + CSV battery lives in matcherBatteries.js.',
        view: 'chat',
      },
      {
        icon: '✓',
        title: 'Limits You Can Count On',
        body: 'PDF text extraction uses pdf-parse v2 (lazy guarded import — if @napi-rs/canvas is missing, text degrades but build/split/watermark keep working). CSV strips $/%/commas for numeric ops. Both panels show live status from the server (count, caps) and answer with chat-equivalent phrasing so CLI users get the same capability without the grid. If an upload or output name would overwrite, the server refuses with a plain answer.',
        view: 'tools',
      },
    ],
  },
  {
    id: 'settings',
    label: 'Operations & Settings',
    description: 'Dashboard, dock, deck, reference, automation, profile, editors, and tuning.',
    steps: [
      {
        icon: '◧',
        title: 'Dashboard & Live Sites',
        body: 'Header → Dashboard (polls /api/dashboard every 5s + immediate on dashboard_update) shows two tabs: Projects (filter field, dirty/running sort, expand a card to see Open in chat / Commit & push or Push / Open site / Copy path + git panels) and Live Sites (every tracked devUrl, live vs recorded-not-answering). The URL is probed at cache build; stale colliding URLs (e.g. console took :3001) are dropped + forgotten, and console-self (:3000-3019 port equals console’s own) is flagged. “View logs” jumps to the dock’s Logs tab filtered to that project.',
        view: 'dashboard',
        target: 'dashboard-grid',
      },
      {
        icon: '⎗',
        title: 'Process Dock & Action History',
        body: 'Inside Terminal, the dock is bottom-collapsible: narrow bar = one chip per running process (command short + port + stop square); expanded = three tabs: Logs (live output, ring-buffer replay ~2000 lines, auto-scrolls only when near bottom, copy, out-of-band amber dot when a non-selected project grows), Projects overview (every discovered project, running vs idle rows), History (action history via GET /api/projects/:id/action-history, revert button that sends revert action <id> through chat — never a bypass). Logs and History are per-tab (tabId threaded).',
        view: 'chat',
        target: 'process-dock',
      },
      {
        icon: '⌖',
        title: 'Command Deck (Ctrl+K) & Command Reference',
        body: 'Ctrl+K deck is Raycast-style: Navigation (Home/Dashboard/New Chat/Fullscreen/Sidebar), Actions (theme, profile, workspace pill, AI toggle, exports, dock tabs), every Tool panel, every chat intent (curated + auto-generated via commandCatalog — canned chit-chat excluded), Sessions, Projects. Tokenized relevance (label > hint > keywords > group) + Levenshtein typo + space-stripped concatenation (“gitstatus”), Recent/Frequent/Time-decayed frequency caps, two panes (rows = grouped headers + right-aligned category, preview = metadata panel). Command Reference (book icon) is the same catalog as a category sidebar + searchable list with shell copy buttons.',
        view: 'chat',
        target: 'deck-button',
      },
      {
        icon: '⏱',
        title: 'Schedules, Notifications, Watch & Auto-Start',
        body: 'Schedules (schedule every 10m / daily at 09:30 / on file save|git commit) persist to data/schedules.json and tick every 15s (lastFiredAt, chokidar for file/git, allowlist: only read-only intents). Delivery: open session → any session → data/schedule-log.md. Notifications are opt-in per event (dev-server-crash, schedule-find, task-done, collision-found, file-changed/added, folder-stale, reminder-fired) via desktop toast (PowerShell WinRT) or webhooks (SSRF-guarded). Watch rules (notify me when files change in <folder>) are notification-only, persisted to data/watch-rules.json, one watcher per folder + daily stale sweep. Auto-start (auto-start this project [with phrase]) boots the dev server on startup, probe-first to avoid double-serve, 20s stagger via taskQueue.',
        view: 'chat',
      },
      {
        icon: '⚙',
        title: 'Profile, Editors, Explorer & Theme',
        body: 'Gear → User Profile: name/title/role (hero greeting + chat placeholders), accent-blue picker (inline --color-accent-blue override — only accent-blue is customizable, teal/orange/green/red are semantic and untouched), sandbox toggle (“Sandbox risky commands” — promise (a) env allowlist + cwd pin, not a container, never weakens confirms), clipboard opt-ins, Include every folder, explorer Lines vs Objects default, Editors & IDEs registry (POST /api/editors — add/remove + per-extension default select), Tours replay, Advanced Tuning (live /api/tuning overrides for FUSE/mar gin etc.), Ask (read-only) vs Default permission mode (Ask makes AI tool calls answer “blocked” instead of prompting).',
        view: 'chat',
        target: 'settings-button',
      },
      {
        icon: 'ℹ',
        title: 'Shortcuts & Health',
        body: 'Press “?” outside an input to see the shortcuts overlay (from ShortcutsOverlay, discoverable instead of memorized). “health check / is my console healthy” probes Ollama reachability, embedding state, disk space, and zombie processes. “check for updates / update console” hits registry.npmjs.org with a 4s abort (offline → silent null); desktop app skips it (electron-updater is the channel). The guided tour completion badges (localStorage console.toursTaken) and the “Reset onboarding / retake tour” button in Profile are the only tour persistence.',
        view: 'chat',
        target: 'settings-button',
      },
    ],
  },
];

export function getTourSection(id: string): TourSection | null {
  return TOUR_SECTIONS.find((s) => s.id === id) || null;
}

export function getTourGroup(id: string): TourGroup | null {
  return TOUR_GROUPS.find((g) => g.id === id) || null;
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
