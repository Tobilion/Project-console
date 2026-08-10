# Project Console

**Local Project Engine** — a local, offline command dispatcher and AI assistant for managing multiple software projects from a single web interface. Everything runs on your machine: zero external API calls (beyond an opt-in Ollama Cloud model, which still proxies through your local Ollama daemon) and zero data leaves your computer.

---

## Features

### Command dispatcher (works without AI)

- **Intent matching**: every message is resolved through a multi-stage pipeline — embedding similarity (all-MiniLM-L6-v2), literal pre-checks for known trap phrases, fuzzy matching, keyword rules, a trained NLP classifier, and a bounded local-model classification call for novel phrasings. 83 intents with ~2,300 example phrases, split across `server/intents/*.js` and merged in `intentsData.js`.
- **Self-learning**: confirmed phrases are promoted into the permanent example set automatically as the console is used (near-miss logging → `learningEngine.js`), persisted across restarts, and used to retrain both the embedding matcher and the NLP classifier.
- **Chit-chat**: greeting, status, gratitude, farewell, acknowledgment, and joke replies with varied templates — no LLM call involved. Greetings/status are enriched with live state (console port, projects indexed, running dev server + URL, uncommitted-file count) and what the console remembers about the project. With AI mode on, greeting/status also ask the active model for a tailored reply (bounded timeout, falls back to the canned reply on any error).
- **Read-only code Q&A**: detected API routes (Express/Flask/FastAPI/Django), file import/imported-by relationships, monorepo sub-package detection, TODO/FIXME scanning, largest files, recent file activity, session info, running processes.
- **Git actions**: push, commit, pull, fetch, stash (list/pop), branch creation, tagging, diff, log, remote info, checkpoint commits, ahead/behind status. Safe/read-only operations run immediately; anything that mutates state asks for confirmation first. Hard reset and force operations are deliberately not available.
- **Non-AI file operations**: "create a file called X with the text '...'", "append to X the text '...'", "read file X" — parsed with regex, gated behind the same confirm-before-write flow as any risky command.
- **Parameterized commands**: a `console.config.json` command entry can declare `{placeholder}` params (e.g. `watch --interval {interval}`); the console asks for missing values in chat and substitutes them safely (shell metacharacters rejected regardless of the entry's own pattern). Entries can also declare `requires: [paths]` (checked before running, with setup guidance if missing) and a `followUp` field to ask a plain question before the command starts.
- **"how do I run this"**: answers with every run command the project's docs mention (numbered, source-labelled) plus every exact `console.config.json` command entry. When asked to run something, command selection follows a trust order: config entries > `package.json` scripts > documented README/CLAUDE.md command > `Play *.bat` launcher > language-based guess. Site-flavored asks ("run the site") and server-flavored asks ("run the server") prefer whichever documented command actually serves the web app.
- **Multi-intent queries**: "show structure and run tests" is split on conjunctions and both intents are handled. Pronoun resolution uses the last 5 turns ("it", "the main file").
- **"Open in..." actions**: open a project in VS Code, Cursor, the OS file explorer, a terminal, GitHub (from the origin remote), the live dev site, or a specific file — each with honest fallbacks when a CLI tool isn't installed.

### AI assistant (opt-in)

- **Opt-in by default off**: flipping the toggle sends every message in that session to an Ollama model. On toggle-on, the console checks connectivity and picks a sensible default model; you can always override it.
- **Model selection**: any model from your local Ollama instance, or an Ollama Cloud model (`:cloud`-suffixed) for heavier requests — cloud models proxy through the same local daemon (`ollama signin` + internet required, no separate API key).
- **Mode picker**: Default / Search / Deep Research / Reason modes modify the system prompt for different behaviors.
- **Tool-call loop**: the AI can call sandboxed tools — `readFile`, `writeFile`, `editFile` (single- or multi-hunk, all-or-nothing), `findFiles`, `insertAtLine`, `appendToFile`, `searchCode`, `listFiles`, `getProjectInfo`, `getGitStatus`, `undoLastChange`, `saveMemory`, `executeCommand`, `listProcesses`, `stopProcess`, `probeUrl`, `runTests`, `webSearch`, `deepResearch` — with up to 6 rounds of tool calls (`MAX_TOOL_ROUNDS` env var to override).
- **Token streaming**: responses stream token-by-token; `<tool_call>` JSON blocks are intercepted server-side. Reasoning-capable models get `think: true`, so internal deliberation is kept separate from the actual answer (surfaced as a live trace under the thinking indicator). If a reply claims a completed mutating action with no evidence a tool actually ran, an explicit correction is sent.
- **Gated tools**: `writeFile`, `editFile`, `insertAtLine`, `appendToFile`, risky `executeCommand`, `runTests`, and `stopProcess` always require explicit user approval; `runTests`/`stopProcess` can never be auto-approved by any policy or session grant. Per-project permissions policy via `console.tools.json` (`ask` / `allow-after-first-ask` / `deny` per tool; `executeCommand` can never leave `ask`). An "Approve this task" button pre-grants the non-risky file tools for that session + project.
- **File upload**: real files can be attached in the AI input bar for analysis.
- **Project context injection**: the AI's system prompt includes the project's main doc (CLAUDE.md/README, ~6000 chars), entry-point code snippets, a whole-project repo map (top-level exports/functions/classes per file, import/imported-by relationships), detected API routes, monorepo structure, and persistent memory for that project.
- **Web search / deep research**: DuckDuckGo-based, no API key required (`GET /api/search?q=` and `GET /api/deep-research?q=`), SSRF-guarded.
- **File-edit diff previews**: confirm cards for file edits show a before/after line diff so you see exactly what will change.

### Persistent memory

- **Cross-session AI memory**: `<project>/.console/memory.md` — a capped (200 entries) list of durable facts the AI saves via the `saveMemory` tool, available across separate chat sessions. Two-tier gating: routine facts save immediately; anything sensitive or inferred requires approval. Entries are sanitized (no markdown/code dumps) and deduplicated.
- **Per-session history**: messages live in `<project>/.console/sessions/<id>.json` inside the project they're about; `.console/chat-log.md` is a human-readable append-only transcript. `.console/` is auto-gitignored. A central index (`data/conversations/index.json`) holds only lookup metadata. Sessions are permanently locked to the project they were created for.
- **Usage-pattern memory**: `<project>/.console/project-memory.json` tracks command frequency, file-edit frequency, and repeated questions; crossing a threshold offers to save the pattern as a quick trigger, a CLAUDE.md note, or a topic section — via an in-chat confirmation card. `review memory` shows current patterns.

### Self-tuning (learned confidence model)

- A small logistic-regression model (plain-JS gradient descent, no library, no GPU) is trained on real accept/reject outcomes from the confirmation flows. Once enough labeled examples exist (12+), it recommends per-intent confidence floors that auto-apply on startup; below that, a fixed heuristic applies (zero behavior change for a fresh install). It runs independently of AI mode. Status any time with `telemetry review`.
- Near-miss suggestions auto-promote when high-confidence (5+ occurrences, ≥80% acceptance); `review learning` + `approve suggestions` for the rest. AI exchanges are distilled into trigger-mode suggestions (`review distillations` / `apply all distillations`).

### Project discovery & indexing

- Scans the base directory for project folders containing `console.config.json`, a project doc (CLAUDE.md, README.md, an `ABOUT-*.md` file, UNIVERSAL_CONTEXT.md), or a `package.json`.
- **Code-only fallback**: a folder with none of the above is still recognized if it has real source files in any of ~15 languages, a recognized config file (`Cargo.toml`, `go.mod`, `requirements.txt`, etc.), or a real `.git` directory — with an auto-generated summary of its detected stack.
- **Script auto-derivation**: `package.json` scripts become runnable entries automatically, each gated on `node_modules` existing first. Hand-authored entries always win on collision.
- **Codebase indexing**: on project select, builds a directory tree, detects languages/entry points, reads key config files, detects frameworks (React, Express, Flask, Django, Spring Boot, Laravel, Vite, etc.), and builds a repo map of exports/functions/classes (TypeScript compiler API for JS/TS/TSX, regex fallback for other languages) plus import relationships, API routes, and monorepo detection.
- **Live reload**: `console.config.json` changes on disk hot-reload the matcher and classifier.
- **`npx local-project-console init`**: generates a tailored `console.config.json` for any project from stack markers (npm scripts, Python/Flask/Django, Rust/Cargo, Go modules).

### Safety

- **Sandboxed file tools**: all file/git tools resolve only within the active project's directory — path-escape attempts (including symlink tricks) are rejected.
- **Risky-command confirmation**: destructive commands require explicit UI approval with one-time security tokens.
- **Git checkpoints**: before any risky command runs, a `console-checkpoint:` commit creates a rollback point.
- **Blocklist + allowlist**: dangerous patterns (`rm -rf /`, force-push, `shutdown`, fork bombs) are rejected outright; only approved executables (`npm`, `node`, `git`, `python`, `npx`, `vite`, etc.) can run.
- **WebSocket origin check**: non-local origins are rejected.
- **SSRF protection**: web search/deep research only reach safe external hosts; `probeUrl` is restricted to localhost/private http(s).
- **Host binding**: defaults to `127.0.0.1` (local only). Set `HOST=0.0.0.0` for LAN access — there is no authentication, so don't do that on an untrusted network.

---

## Requirements

- Node.js 18+ (developed on Node 24)
- npm (or bun)
- Optional: [Ollama](https://ollama.com/download/windows) for AI mode — local models, or `ollama signin` for Ollama Cloud

The embedding model (all-MiniLM-L6-v2, ~23MB) downloads automatically on first use and caches at `.cache/xenova/`.

---

## Getting started

### Global (npx)

From any project folder on any machine with Node.js:

```powershell
npx local-project-console
```

This downloads and launches the console in your browser, scanning the current directory for projects. To generate a tailored `console.config.json` for the current project (or a specific one):

```powershell
npx local-project-console init
npx local-project-console init C:\path\to\project
```

### Local development

```powershell
npm install
npm run dev     # tsx server/index.js, http://127.0.0.1:3000
npm run lint    # tsc --noEmit
```

The server auto-falls back through ports 3000–3009 if 3000 is taken; the frontend and CLI client discover whichever port it actually bound to.

### Windows launcher

Double-click `start.bat` in the root folder — it installs dependencies if needed, offers Web UI or CLI Chat mode, and launches the server.

### Background daemon (no terminal window)

```powershell
.\scripts\start-daemon.ps1     # starts hidden, polls until ready, writes port to logs/daemon.port
.\scripts\stop-daemon.ps1      # stops by killing the process on the port
.\scripts\add-to-startup.ps1   # launches the console on login
```

---

## Usage

### Web UI

The UI is dark-first with an additive light theme (sliding sun/moon pill in the header; follows your OS preference on first load, remembered in `localStorage`). The welcome screen includes a 4-step guided tour (Take the Tour button) covering project selection, AI mode, and key commands. The header shows the live dev-server count, and the Dashboard button opens a per-project status grid (uncommitted files, recent commits, dev URLs, running commands).

### CLI chat (no browser)

```powershell
node server/cli-client.js --dir "C:\path\to\project"   # jump straight to a project
node server/cli-client.js --project "<name>"           # or by name/folder
```

Without `--dir`/`--project` you get an interactive arrow-key picker (numbered fallback in non-interactive terminals). Type `projects` in chat to switch projects or rescan.

### AI setup

1. Install Ollama and pull a model: `ollama pull qwen2.5-coder:7b`
2. For Ollama Cloud (no download): `ollama signin`, then pick a `:cloud` model from the dropdown
3. Toggle AI ON in the chat header

---

## Configuration

### `console.config.json` (per project)

Command entries and canned answers the dispatcher can run without AI:

```json
{
  "commands": {
    "run": {
      "trigger": "run the site",
      "action": "python main.py serve"
    },
    "watch": {
      "trigger": "watch network",
      "action": "python main.py watch --interval {interval}",
      "params": [{ "name": "interval", "prompt": "Interval in minutes?", "pattern": "\\d+" }],
      "requires": ["venv/Scripts/python.exe"],
      "requiresMessage": "Run the venv setup first."
    }
  },
  "chatReplies": {
    "greeting": ["Welcome back!"],
    "status": ["All systems normal."]
  }
}
```

Entry fields: `trigger` (phrase that routes to the entry), `action` (shell command, `{param}` placeholders supported), `params` (name/prompt/pattern — asked in chat when missing), `requires` (paths checked before running), `followUp` (ask another entry's param before starting), `response` (a canned answer instead of a command).

### `console.tools.json` (per project)

Custom AI-mode tools and per-tool permissions:

```json
{
  "tools": [{ "name": "deploy", "description": "Deploy the site", "command": "npm run deploy", "risky": true }],
  "permissions": { "writeFile": "allow-after-first-ask" }
}
```

`permissions` accepts `ask` / `allow-after-first-ask` / `deny` per tool. Invalid values are dropped with a warning at scan time and can never crash project loading.

### `data/user-profile.json`

App-global identity (name/title/custom role) edited from the ⚙ Settings modal; powers the personalized hero greeting and chat placeholders.

---

## Chat commands (reference)

| Command | What it does |
|---|---|
| `run the site` / `run the project` | Detects project type, suggests the right run command |
| `how do I run this` | Lists every documented + configured run command |
| `where is the link` / `link?` | Shows the running dev server URL |
| `stop server` / `kill server` | Stops a running dev server |
| `is the server running` | Probes recorded/candidate dev URLs (liveness) |
| `scan for servers` | Live/dead table of every project's dev servers |
| `check git status` / `git log` / `git diff` / etc. | Read-only git introspection |
| `push this to github with comment "..."` | Checkpoint + commit + push |
| `checkpoint my work` | Explicit save-point commit |
| `create a file called X with the text "..."` | Non-AI file create (confirm-gated) |
| `find the config file` / `where is main.py` | Locate files in the project |
| `open in vs code` / `open in terminal` / `open in cursor` | Open the project in external tools |
| `open main.py` / `open the config file` | Open a specific file |
| `review learning` | See near-miss suggestions |
| `approve suggestions` | Promote suggested phrases into the matcher |
| `telemetry review` / `telemetry stats` | Match statistics + learned-model status |
| `threshold set <intent> <floor>` | Override an intent's confidence floor |
| `check collisions` | Find overlapping intent embeddings |
| `review distillations` / `apply all distillations` | Turn AI learnings into trigger-mode entries |
| `review memory` | Usage patterns (frequent commands/files/questions) |
| `telemetry clear` | Reset telemetry for the current project |
| `help` / `what can you do` | Full command guide |

---

## Architecture

```
server/
├── index.js              — Orchestrator: routes, WS init, project discovery; startup auto-tune sweeps
├── state.js              — Shared mutable state + confirmation TTL sweeps
├── matcher.js            — matchInput() pipeline: multi-intent → semantic → NLP → local router → fallback
├── semanticMatcher.js    — Embedding + Fuse.js matching + PRE_SEMANTIC_OVERRIDES literal rules
├── localRouter.js        — Bounded single-call local-model classification (last resort, AI-toggle independent)
├── intentsData.js        — Merges 83 intents (~2,300 phrases) from server/intents/*
├── nlpEngine.js          — Trained NLP.js classifier; retrains from confirmed near-miss promotions
├── tools.js              — Sandboxed file/git/memory/process/test tools + resolveToolGate approval point
├── executor.js           — Shell command spawner, URL detection, port retry, buffered output streaming
├── ollama.js             — REST client for localhost:11434 (local + Cloud models)
├── ollamaContext.js      — AI system-prompt builder: tool defs, modes, repo map, memory injection
├── aiQuery.js            — AI-mode tool loop (streaming, cancellation, gated tool calls)
├── projectScanner.js     — Project discovery (container + single-folder scans)
├── codebaseIndexer.js    — Directory tree, language/entry-point detection, repo map, routes
├── conversationStore.js  — Session CRUD + .console/ management + gitignore helper
├── memoryStore.js        — Cross-session AI memory (.console/memory.md)
├── confidenceModel.js    — Learned confidence model (logistic regression)
├── learningEngine.js     — Near-miss → suggestion generation, phrase injection
├── distillation.js       — AI exchange analysis → trigger-mode config suggestions
├── projectMemory.js      — Usage-pattern tracking + CLAUDE.md augmentation
├── routes/               — projectRoutes, sessionRoutes, searchRoutes, monitoringRoutes
├── wsHandlers/           — connection.js shim + per-domain leaves, builtin intent handlers, matchedEntry
├── intents/              — Per-domain intent phrase files
└── scripts/              — Daemon launchers + check-* harnesses

src/                      — React 19 + Vite frontend
├── hooks/useConsole.ts   — State composition + stable WS message router
├── App.tsx               — Render root, folder picker, WebSocket init, fullscreen chat
├── components/           — Terminal, WelcomeScreen, SidebarDrawer, Dashboard, ProcessDock, CommandDeck
└── types.ts              — Shared type definitions

bin/cli.js                — npm binary entry point (npx local-project-console)
server/cli-client.js      — Interactive CLI chat mode (no browser) with server auto-discovery
start.bat                 — Windows launcher (Web UI / CLI Chat modes)
scripts/                  — Daemon launchers (start/stop/add-to-startup)
```

---

## Development

```powershell
npm run lint                # tsc --noEmit
npm run check-intents       # static exact/near-duplicate phrase scanner
npm run check-matcher       # matching-pipeline regression battery (68+ inputs)
npm run check-indexer       # codebase indexer regression battery
npm run check-tools         # sandbox/gate/tool regression battery
npm run check-handlers      # intent-handler coverage + dispatch checks
npm run check-ws-cases      # frontend WS message-case regression battery
npm run build               # vite build + esbuild server bundle → dist/
```

Cross-platform note: `start.bat` is Windows-only; on macOS/Linux run `npm run dev` directly. The server, sandboxed file tools, and safety blocklist are all `process.platform`-aware.

---

## Author & License

Created by **Tobi**. Released under the [MIT License](LICENSE) — free to use, modify, and redistribute.
