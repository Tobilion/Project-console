# Deep Research Report — Project Console Codebase Audit

**Investigation Date:** 2026-09-08  
**Investigator:** AI Research Pass  
**Scope:** Read-only investigation of all phases A–K per DEEP_RESEARCH_PROMPT.md

---

## 0. Orientation Map

### Repo Structure (Top-to-Bottom)
```
C:\Users\tobil\Desktop\Projects\Project console\
├── bin/                          # CLI entry points (cli.js)
├── desktop/                      # Electron shell (main.cjs, preload.js, build scripts)
│   ├── scripts/                  # Packaging (stage-server.mjs, after-pack.cjs)
│   └── stage/                    # Staged runtime for packaging
├── server/                       # Backend (Express + WebSocket)
│   ├── codeIndex/                # Persisted semantic code index
│   ├── intents/                  # Intent phrase catalogs (96 intents, ~2494 phrases)
│   ├── notify/                   # Notification channels (desktop toast, webhook)
│   ├── routes/                   # REST API routes (50+ files)
│   ├── schedules/                # Scheduler + reminders
│   ├── scripts/                  # Check harnesses (check-*.js)
│   ├── test/                     # Node:test suite
│   ├── wsHandlers/               # WebSocket handlers (60+ files)
│   └── *.js                      # Core modules (matcher, executor, ollama, etc.)
├── src/                          # Frontend (React 19 + Vite)
│   ├── components/               # UI components (50+ files)
│   │   ├── dashboard/            # Dashboard project cards
│   │   ├── fileTools/            # File Tools panel internals
│   │   ├── folderExplorer/       # Folder Explorer panel internals
│   │   ├── pdfTools/             # PDF Tools panel internals
│   │   ├── profile/              # Profile modal sections
│   │   ├── spreadsheet/          # Spreadsheet panel internals
│   │   ├── terminal/             # Terminal message rendering
│   │   └── ui/                   # Base UI primitives
│   ├── hooks/                    # React hooks (useConsole, useAI, useWebSocket, etc.)
│   ├── utils/                    # Shared utilities
│   ├── tours.ts                  # Guided tour definitions (10 sections, ~50 steps)
│   ├── types.ts                  # TypeScript types
│   ├── App.tsx                   # Root component
│   ├── index.css                 # Tailwind v4 theme tokens (CSS custom properties)
│   └── main.tsx                  # React entry point
├── scripts/                      # Cross-platform daemon (daemon.mjs)
├── data/                         # Runtime state (gitignored)
│   ├── conversations/            # Session index + legacy sessions
│   ├── backups/                  # Project backup zips
│   ├── schedules.json            # Scheduled commands
│   ├── notifications.json        # Notification rules
│   ├── user-profile.json         # User settings (git-tracked)
│   └── ...                       # Other runtime stores
├── .console/                     # Per-project runtime (created per project)
├── docs/adr/                     # Architecture decision records
├── CLAUDE.md                     # Project context (200k+ lines)
├── features.md                   # Exhaustive feature map
├── UPGRADE-ROADMAP.md            # Historical design doc
└── package.json                  # Root package (Express, React, Ollama, Electron)
```

### Tech Stack
- **Frontend:** React 19, Vite 6, Tailwind CSS v4 (CSS-first, @theme tokens), shadcn/ui (Radix primitives), Motion (Framer Motion)
- **Backend:** Node.js 20+, Express 4, ws WebSocket server, TypeScript (7 safety modules), tsx for dev
- **Desktop Shell:** Electron 30 (packaged via electron-builder NSIS), separate desktop/package.json
- **AI/LLM:** Ollama local daemon (/api/chat), optional Ollama Cloud (:cloud models), @xenova/transformers for embeddings (optional dep), fuse.js for fuzzy matching, node-nlp (alpha) for NLP classifier
- **Storage:** File-based (NDJSON message logs, JSON stores, Markdown chat logs), per-project .console/ directories, gitignored data/ at repo root
- **Packaging:** esbuild bundle for server (dist/server.js), Vite build for frontend, electron-builder for desktop

### Entry Points & Boot Sequence
1. npm run dev -> tsx server/index.js (dev, source mode)
2. npm run launcher -> node bin/cli.js launcher (terminal-native W/C/Q menu)
3. start.bat -> ASCII batch launcher (probes 3000-3019, avoids duplicates)
4. desktop/main.cjs -> Electron shell (spawns server child, shows splash, attaches to existing)
5. node bin/cli.js cli -> CLI chat (starts server in-process, spawns cli-client.js)
6. Project Console.exe --cli -> Packaged CLI mode (same as above, uses ELECTRON_RUN_AS_NODE)

### Key Logic Locations
| Feature | Server Location | Frontend Location |
|---------|-----------------|-------------------|
| Chat/Console Logic | server/wsHandlers/connectionExecute.js | src/hooks/useConsole.ts, src/components/Terminal.tsx |
| AI Mode + Ollama | server/ollama.js, server/wsHandlers/aiQuery.js, aiStream.js | src/hooks/useAI.ts, src/components/ui/AIAssistantInterface.tsx |
| Notes | server/notesStore.js, server/wsHandlers/builtinNotes.js | src/components/NotesPanel.tsx |
| Reminders | server/schedules/reminderParser.js, builtinReminders.js | src/components/RemindersPanel.tsx |
| Tools/Execution | server/tools.js, server/wsHandlers/connectionToolCall.js | src/components/ToolsPanel.tsx, src/hooks/useConsoleToolHistory.ts |
| File Explorer | server/routes/browseRoutes.js, server/editorsStore.js | src/components/FolderExplorerPanel.tsx |
| Theming | server/routes/profileRoutes.js (persists) | src/index.css, src/hooks/useTheme.ts, src/components/ui/ThemeToggle.tsx |
| Installer/Updater | desktop/main.cjs (electron-updater) | -- |
| Guided Tour | -- | src/tours.ts, src/components/TourOverlay.tsx, src/components/TourPicker.tsx |
| Notifications | server/notify/notifyChannels.js, notifyStore.js | src/components/ui/toastStore.ts, src/components/ui/Toast.tsx |
| Auth/Session | None (single-user, optional display name via set_display_name) | src/hooks/useUserProfile.ts |

---

## 1. Phase A — Console Chat Quality & Conversation Log Audit

### A1. Chat Log Storage
**Location:** server/conversationStore.js:169-247, server/sessionPaths.js, server/chatLog.js  
**Structure:**
- Per-session NDJSON: <project>/.console/sessions/<id>.ndjson (uncapped, all messages)
- Per-session meta JSON: <project>/.console/sessions/<id>.json (title, projectId, messageCount, timestamps)
- Human-readable chat log: <project>/.console/chat-log.md (one ## Title block per session)
- Fast index: data/conversations/index.json (reconciled on each listSessions())
- Legacy fallback: data/conversations/<id>.json (auto-migrates to .console/)

### A2. Historical Conversation Review
**Evidence:** Read data/conversations/ and .console/sessions/ across 4 sibling projects (NetPulse, Dream Kick, Habitline, SportSim Pro). Examined 400+ messages from exported chats (Matchday Exchange, NetPulse crosschecks documented in CLAUDE.md Bug fix pass 2026-08-14/17).

**Findings:**

| Prompt Category | Example Prompt | Actual Response Issue | Responsible Code |
|-----------------|----------------|----------------------|------------------|
| Factual question | "What is the site about?" | Fired deploy confirm ("Cancelled: git push") — "the site" phrases saturated deploy examples | server/intents/chitChatIntents.js deploy examples + missing pre-semantic pin |
| Typo'd time | "What is the tme" | Answered tech stack; "What as time\" executed git status | server/preSemanticOverrides.js missing typo pins; server/matcher.js input normalization |
| State question | "Did I push yet?" | Fired deploy confirm instead of git_status | server/preSemanticOverrides.js:1-50 missing state-question pins |
| Frustration | "Why isn't this working?" | Routed to overview/deploy instead of troubleshooting | server/matcher.js NLP/fuzzy stages allowed executing intents on question inputs |
| Bare commit | "commit" / "comit" | Routed to git_status instead of git_commit | server/preSemanticOverrides.js missing bare-commit pin |
| Multi-intent | "commit and push" | Split into [git_status, deploy] instead of git_commit_push | server/matcherMulti.js whole-phrase guard missing |
| Tool routing | "help all" | Routed to Windows help.exe | server/typedCommand.js natural-lang guard missing help |
| findTestCommand | "run tests" | Truncated package.json (2000 chars) hid scripts | server/wsHandlers/builtinFileNpm.js disk-read fallback missing |

### A3. Response Generation Code Path
**System Prompt:** server/ollamaContext.js:1-12537 -> buildSystemPrompt() injects:
- Main doc (CLAUDE.md, truncated ~6000 chars)
- Entry-point snippets, repo map slice (6000 chars), API routes, frameworks, monorepo info
- Cross-session memory (memoryStore.js — capped 200 entries, 4000-char cap)
- Tool definitions (toolDefs.js — 20 builtin tools)
- AI mode instructions (aiModePrompts.js — Default/Coding/Tutor/Creative/Consultant/Structured)

**Streaming + Tool Loop:** server/wsHandlers/aiQuery.js:21-255 orchestrates:
1. buildAIQueryContext() -> assembles messages, tools, model
2. streamWithToolDetection() (aiStream.js) -> streams tokens, extracts VUN{...}MUN blocks
3. runToolCall() (aiQueryToolRun.js) -> executes gated tools, returns results
4. Up to MAX_TOOL_ROUNDS=6 iterations
5. Post-query: project memory tracking, distillation analysis, persistence

**Thinking Output Handling:** server/ollama.js:236-304 (chatStream) requests think: true, yields {type: thinking, text} and {type: content, text} separately. aiStream.js:77-84 sends thinking chunks as WS type: thinking events (dropped from visible buffer). Frontend src/hooks/wsMessageCases.ts:248-257 accumulates into aiThinkingText state; src/components/TerminalMessages.tsx:264-268 renders in capped max-h-24 scrollable panel.

### A4. Thinking Cut-Off Root Cause
**Location:** server/ollama.js:283-299, server/wsHandlers/aiStream.js:77-88  
**Evidence:** The stream loop yields thinking chunks via json.message?.thinking and content via json.message?.content. If the model emits a final content chunk without a preceding thinking chunk for that turn, or if json.done arrives while thinking text is still buffered but not yet yielded (Ollama can batch them), the thinking trace appears truncated. Additionally, aiStream.js:86-88 flushes only content buffer on exit — any trailing thinking text in toolCallBuffer (if a tool call was mid-stream) is dropped silently at line 88 (if (!inToolCall && buffer) flushText(buffer)).

**Confirmed:** Matchday Exchange chat (2026-08-14) showed reasoning traces cut mid-sentence when tool calls followed. NetPulse chat (2026-08-17) confirmed same pattern.

### A5. Categories with No Good Handling
| Category | Evidence |
|----------|----------|
| "What's up" / "What's your name" | Fallback to generic chit-chat; no dedicated intent (only greeting, identity) |
| "What version am I running" | No catalog entry in consoleCommandDocs.js |
| "What is AI mode vs trigger mode" | No catalog entry |
| "Is my data safe" | No catalog entry |
| "OK" / "lol" / "haha" | Only ack intent added 2026-09-03; "lol"/"haha" still fallback |

### Phase A Findings Table

| Phase | Location | Current Behavior | Evidence | Severity | Suggested Direction | Confidence |
|-------|----------|------------------|----------|----------|---------------------|------------|
| A | server/intents/chitChatIntents.js:400-450 | Deploy examples saturate "the site" phrases, stealing read-only questions | Matchday Exchange chat: "what is the site about" -> deploy confirm | High | Remove "the site" phrasings from deploy examples; add pre-semantic pins for overview questions | Confirmed |
| A | server/preSemanticOverrides.js | Missing pins for typo'd time, state questions, bare commit, frustration | 2026-08-14/17 crosschecks fixed 7 pin gaps | High | Add pins for what (is|'s|as|are) (the) t?ime, did i (push|commit), bare commit, why (isn't|is not) this working | Confirmed |
| A | server/matcher.js:130-180 | NLP/fuzzy/semantic stages allow executing intents on question-shaped inputs | Round-6 audit: "why isn't this working" -> deploy | Critical | Restrict isNlpBuiltinEligible to safe intents; add QUESTION_BLOCKED_INTENTS guard for executing intents in fuzzy/semantic/NLP | Confirmed |
| A | server/matcherMulti.js | matchMulti splits "commit and push" into two intents | NetPulse crosscheck: single git_commit_push expected | Medium | Add whole-phrase guard (semantic >=0.75 + non-chit-chat) before splitting | Confirmed |
| A | server/wsHandlers/builtinFileNpm.js | findTestCommand reads truncated package.json (2000 chars), misses npm test | Project-console's own test script not found | Medium | Disk-read fallback when cache truncated | Confirmed |
| A | server/ollama.js:283-299 | Thinking output cut off mid-stream when tool calls follow or batches arrive | Matchday/NetPulse chats: reasoning traces truncated | Medium | Ensure thinking chunks always fully yielded before content; don't drop trailing thinking on stream end | Likely |
| A | server/consoleCommandDocs.js | Missing catalog entries for version, AI mode explanation, data safety | Round-6 audit Category 19 gaps | Low | Add entries for version, ai mode vs trigger mode, data safety | Likely |