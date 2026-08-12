# Project Console

**Local Project Engine** — a local, offline command dispatcher and AI assistant for managing multiple software projects from a single web interface. Everything runs on your machine: zero external API calls (beyond an opt-in Ollama Cloud model, which still proxies through your local Ollama daemon) and zero data leaves your computer.

---

## Features

### Command dispatcher (works without AI)

- **Intent matching**: every message is resolved through a multi-stage pipeline — embedding similarity (all-MiniLM-L6-v2), literal pre-checks for known trap phrases, fuzzy matching, keyword rules, a trained NLP classifier, and a bounded local-model classification call for novel phrasings. 83 intents with ~2,300 example phrases, split across `server/intents/*.js` and merged in `intentsData.js`.
- **Self-learning**: confirmed phrases are promoted into the permanent example set automatically as the console is used (near-miss logging → `learningEngine.js`), persisted across restarts, and used to retrain both the embedding matcher and the NLP classifier.
- **Chit-chat**: greeting, status, gratitude, farewell, acknowledgment, and joke replies with varied templates — no LLM call involved. Greetings/status are enriched with live state (console port, projects indexed, running dev server + URL, uncommitted-file count) and what the console remembers about the project. With AI mode on, greeting/status also ask the active model for a tailored reply (bounded timeout, falls back to the canned reply on any error).
- **Calculator**: safe arithmetic (`+ - * / ( )`, no eval) plus offline unit conversion (length/weight/volume/temperature), percentage/tip/tax phrases (`convert 5 km to miles`, `what is 15% of 80`, `whats 18% tip on 64.50`, `add 8.25% tax to 120`). The Calculator panel (Tools) is a live iOS-style widget — button presses are instant, `=` evaluates through the same server-side evaluator chat uses.
- **Read-only code Q&A**: detected API routes (Express/Flask/FastAPI/Django), file import/imported-by relationships, monorepo sub-package detection, TODO/FIXME scanning, largest files, recent file activity, session info, running processes.
- **Git actions**: push, commit, pull, fetch, stash (list/pop), branch creation, tagging, diff, log, remote info, checkpoint commits, ahead/behind status. Safe/read-only operations run immediately; anything that mutates state asks for confirmation first. Hard reset and force operations are deliberately not available.
- **Non-AI file operations**: "create a file called X with the text '...'", "append to X the text '...'", "read file X" — parsed with regex, gated behind the same confirm-before-write flow as any risky command.
- **Parameterized commands**: a `console.config.json` command entry can declare `{placeholder}` params (e.g. `watch --interval {interval}`); the console asks for missing values in chat and substitutes them safely (shell metacharacters rejected regardless of the entry's own pattern). Entries can also declare `requires: [paths]` (checked before running, with setup guidance if missing) and a `followUp` field to ask a plain question before the command starts.
- **"how do I run this"**: answers with every run command the project's docs mention (numbered, source-labelled) plus every exact `console.config.json` command entry. When asked to run something, command selection follows a trust order: config entries > `package.json` scripts > documented README/CLAUDE.md command > `Play *.bat` launcher > language-based guess. Site-flavored asks ("run the site") and server-flavored asks ("run the server") prefer whichever documented command actually serves the web app.
- **"how do I <anything>" answers**: guidance questions ("how do you push to github", "command to see the dashboard") are answered from a built-in command catalog — each answer shows the chat phrasing, the real terminal command it runs, and clickable suggestion chips that run it for you. Question shapes ("how to ...", "command to ...", "what is the command to ...") are pinned to this answer before the matcher stage, so a question can never execute the thing it is asking about.
- **Multi-intent queries**: "show structure and run tests" is split on conjunctions and both intents are handled. Pronoun resolution uses the last 5 turns ("it", "the main file").
- **"Open in..." actions**: open a project in VS Code, Cursor, the OS file explorer, a terminal, GitHub (from the origin remote), the live dev site, or a specific file — each with honest fallbacks when a CLI tool isn't installed.

### Developer & General workspaces

- Every scanned folder gets a `workspaceType` classification: **developer** (has code, a `package.json`, or a real `.git` dir) or **general** (a plain documents/files folder). The per-project tab switcher next to the chat header flips between the two, and an explicit `workspaceType` in `console.config.json` always wins over the heuristic.
- The type only filters which commands are *suggested* — dev-shaped suggestions (git, run, diagnostics) stay hidden in a general folder, but typing a dev command there still works exactly as before. Never a hard gate.
- `switch to developer mode` / `switch to general mode` / `what mode am I in` manage the mode from chat or the CLI; the last-used tab is remembered per project.

### Tools panels (interactive web UI)

 - A **Tools** button (visible when a general-mode project is active) opens a card grid of interactive tools — Calculator, File Tools, PDF Tools, and Reminders today, more later. Clicking a card opens that tool's dedicated panel in the same space the chat/dashboard use; no modal stacks.
- Tools are chat-addressable too: typing `open calculator` or `open pdf tools` lands you in the same panel state as clicking the card. The chat reply stays plain text (the CLI is deliberately text-only — from a terminal, these commands answer with a short note and the equivalent chat phrasings).
- Panels are server-driven (registry + `GET /api/tool-panels`), so a tool can later report availability (e.g. "PDF Tools disabled — missing dependency") without a frontend change.
 - The PDF Tools panel is fully interactive: project PDF list with download/"show in folder", merge with multi-select + output name, split (per page / around a page), extract text, page-range extract, and watermark — every Run button composes the same trigger command chat uses, so confirmation, checkpointing, history and `revert action <id>` all work identically from either surface.
 - The Reminders panel is an Apple Reminders-style sectioned list (Today / Upcoming / All); each row has a checkbox completion control and due-date/time subtitle. Adding works through a single `+ New Reminder` input row, and completing a row removes the reminder through the same chat command path.

### General-mode file tools

- **`find files matching X` / `search for X in my files`** — filename + content search across the active folder (plain substring scan, no AI or embedding model required). Read-only, runs immediately.
- **`tidy this folder` / `organize this folder by type`** — moves loose root files into category folders (Images/Documents/Spreadsheets/Archives/...), by date, or both. Shows the full move plan first, asks for confirmation, checkpoints, and journals every move so `revert action <id>` undoes it.
- **`find duplicate files` / `find duplicates in this folder`** — hash-based duplicate groups with wasted-space estimate. Read-only; a separate confirm-gated `delete duplicates, keep newest` does the deletion (journaled, revertible).
- An interactive **File Tools panel** is available from the Tools card grid (`open file tools`); it includes a Finder-style file browser with search, a tidy-preview launcher, and a dedicated duplicate-finder view with keep-newest checkbox conventions.

### Reminders

- **`remind me tomorrow at 9am to renew my license`** / **`remind me in 3 days to follow up`** / **`remind me every friday at 5pm to call the accountant`** — sets a personal reminder with free-form natural-language dates. Fires to the open chat, or to the schedule log when nobody is connected.
- **`list my reminders`** / **`cancel reminder s2`** — shows or cancels reminders. An interactive Reminders panel (Apple Reminders-style) is available from the Tools card grid; `open reminders` opens it directly.
- Same delivery path as scheduled commands: creating-session preference, then any live session, then `data/schedule-log.md`. Reminders are plain text — they never execute commands, so they bypass the read-only intent check at fire time.

### Notes

- **`note: buy milk`** / **`add a note: remember the wifi password`** — jots a user-authored scratch note to `<project>/.console/notes.md` (immediate, no confirmation — your own text, not a risky action).
- **`show my notes`** / **`read my notes`** / **`search my notes for wifi`** — lists notes most-recent-first or substring-searches them. A Notes panel (Apple Notes-style flat feed with instant filter) is available from the Tools card grid; `open notes` opens it directly.
- Notes are never written by the AI and are not injected into the AI system prompt — they're your scratch space, separate from AI memory (`memory.md`).

### Spreadsheet (CSV)

- **`sum column sales in data.csv`** / **`average column price in data.csv`** — deterministic, read-only aggregates over a project CSV (quoted-field aware parser, no AI).
- **`count rows in data.csv where status equals done`** / **`filter data.csv where price greater than 50`** — row filtering with a fixed operator set (equals / contains / greater than / less than). Filter is read-only; a future filter-to-file write would go through the normal confirm + revert path.
- The Spreadsheet panel (Tools > Spreadsheet, or `open spreadsheet`) picks a CSV + column, and renders filter results as a real sortable table with sticky headers and zebra striping.

### Clipboard & snippets

- **`show clipboard history`** / **`copy clipboard item 2`** / **`clear clipboard history`** — in-memory OS clipboard history (most recent 25 entries, deduped). History polling is **opt-in** (Settings → Advanced → "Track clipboard history") — nothing reads your clipboard by default, since passwords and tokens routinely pass through it. A separate "Persist clipboard history to disk" opt-in writes it to a local plaintext file so it survives restarts.
- **`save this as a snippet: welcome`** / **`copy snippet welcome`** / **`delete snippet welcome`** — named text blocks, global and persistent.
- Every copy goes through a server-side OS clipboard write (Set-Clipboard/pbcopy/xclip), so the CLI copies for real too — no browser needed. The Clipboard panel (Tools > Clipboard, or `open clipboard`) shows both lists with copy/delete actions; when history is off the panel still renders and explains how to enable it.

### Backup

- **`backup this folder`** / **`export this project as a zip`** — zips the project folder (or a named subfolder) to `data/backups/` with a timestamp, returns the absolute path + a download link, and journals the zip so `revert action <id>` deletes it. Read-only against the source — nothing in the project is modified or deleted.
- **`list backups`** — shows past backups (timestamp + size). The Backup panel (Tools > Backup, or `open backup`) is a Time Machine-style reverse-chronological list with per-row download and "show in folder".

### PDF toolkit

- **`merge these pdfs into combined.pdf`** — merges several PDFs into one new file (never overwrites an existing output).
- **`split report.pdf into one file per page`** / **`split report.pdf at page 5`** — one file per page, or two parts around a page.
- **`extract text from report.pdf`** — read-only text extraction with a preview, no confirmation needed.
- **`extract pages 2-5 from report.pdf into excerpt.pdf`** — copies a page range into a new file.
- **`watermark report.pdf with confidential`** — stamps text across every page of a copy.
- Every operation that writes a file confirms first, checkpoints, and journals the created file so `revert action <id>` deletes it. PDF-only folders are auto-recognized as projects (classified *general*, not dev) so the toolkit works on them out of the box. Typing a bare operation name (e.g. `merge pdfs`) opens the interactive PDF Tools panel.

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
- **AI-dock bootstrap hints**: open-ended requests typed while AI mode is off ("make me a landing page") get an answer that names the AI dock and suggests a concrete phrasing to use there — instead of a dead-end "flip the toggle".

### Automation & notifications

- **Scheduled & triggered commands**: per-project schedules ("schedule every 10 minutes \"git status\"", "schedule daily at 09:30 ...", "schedule on file save/git commit ...") fire through the same matching pipeline a typed message would use, restricted to read-only intents, with results delivered to the open chat or `data/schedule-log.md`. `list schedules` / `delete schedule 2` / `review schedule log` manage them.
- **Notifications**: opt-in per-event alerts (`notify me when dev-server-crash` / `schedule-find` / `task-done` / new intent collisions) to the Windows desktop and/or webhooks (`webhook add <url>` — SSRF-guarded, no localhost). Everything is off until enabled; `list notifications` / `test notification` verify.
- **File-watch notifications**: `notify me when files change in <folder>` / `notify me if <folder> hasn't changed in N days` — IFTTT-style rules that fire desktop/webhook alerts on file changes, new files, or folder staleness. Watch rules are notification-only (they never run commands) and persist across restarts. `list watched folders` / `stop watching <folder>` manage them; the Notifications panel (Tools > Notifications) shows them as rule cards.
- **Auto-start projects**: "auto-start this project" (or `auto-start <name>`) makes the console boot that project's dev server automatically on every start — the stored phrase is re-matched through the normal pipeline, skips when the site is already answering (no double-serve), staggers multiple projects, and reports into the open chat or `data/auto-start-log.md`. `run auto-start now` starts it immediately; `disable auto-start` / `list auto-start` manage it.
- **Intent-collision baseline**: every boot compares intent-embedding overlaps against the previous boot's baseline and raises the opt-in "new intent collisions appear" notification for anything new — a drift alarm for the matching corpus. `check collisions` shows the current state on demand.

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

#### Installation troubleshooting

On slow or restricted networks, `npm install` can fail with a `sharp` / `libvips` download timeout:

```
npm error command failed
npm error sharp: Downloading https://github.com/lovell/sharp-libvips/...
npm error sharp: Installation error: Request timed out
```

This is a one-time native-binary download performed by `sharp` (a transitive dependency of the embedding package), not a problem with the console itself. Simply retry the install — it succeeds once the download completes.

The embedding dependency is **optional**: if it fails to install, the console still installs and runs normally (matching falls back to the fuzzy/keyword/NLP stages, and `health check` reports the embedding state). To activate semantic matching later, run:

```powershell
npm i @xenova/transformers
```

Do **not** use `--ignore-scripts` to work around install failures — it would also skip the native build of `re2`, which the code-search tool needs, and silently break it.

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

The UI is dark-first with an additive light theme (sliding sun/moon pill in the header; follows your OS preference on first load, remembered in `localStorage`). The welcome screen includes a 4-step guided tour (Take the Tour button) covering project selection, AI mode, and key commands. The header shows the live dev-server count, and the Dashboard button opens a per-project status grid (uncommitted files, recent commits, dev URLs, running commands). With a non-dev folder active, a Developer/General tab switcher and a **Tools** button (interactive tool panels) appear next to the header.

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

### Run & dev servers

| Command | What it does |
|---|---|
| `run the site` / `run the project` / `start the site` | Detects project type, suggests the right run command |
| `run the tests` / `run tests` | Finds and runs the project's test command (pytest, vitest, npm test, ...) |
| `run the build` / `build the project` | Runs the project's build script (`npm run build`, ...) |
| `run the site on port 3010` / `serve the app on port 3040` | Starts the dev server on a specific port |
| `stop the server` / `kill the server` / `stop it` | Stops a running dev server |
| `where is the link` / `link?` | Shows the running dev server URL |
| `is the server running` | Probes recorded/candidate dev URLs (liveness) |
| `scan for servers` | Live/dead table of every project's dev servers |
| `show running processes` | Lists commands the console is tracking for this project |
| `auto-start this project` / `auto-start <name>` | Dev server starts automatically at every console boot (skips when the site is already up) |
| `disable auto-start` / `list auto-start` / `run auto-start now` / `review auto-start` | Manage and run the auto-start config |

### Git

| Command | What it does |
|---|---|
| `check git status` / `what changed` / `git log` / `git diff` | Read-only git introspection |
| `push this to github with comment "..."` / `push my changes` / `deploy` | Checkpoint + commit + push |
| `commit "fix the login bug"` | Commit without pushing — message in quotes |
| `checkpoint my work` / `make a checkpoint` | Explicit save-point commit before risky moves |
| `clean up stale branches` | Lists merged branches you can safely delete |
| `git fetch` / `git pull` / `am i behind origin` / `list tags` / `git init` | More git actions (mutations confirm-gated) |

### Files & editor

| Command | What it does |
|---|---|
| `create a file called X with the text "..."` | Non-AI file create (confirm-gated) |
| `find the config file` / `where is main.py` | Locate files in the project |
| `open in vs code` / `open in terminal` / `open in cursor` / `open in explorer` | Open the project in external tools |
| `open main.py` / `open the config file` | Open a specific file |
| `open the github page` | Open the project's GitHub repo page |
| `find files matching X` / `search for X in my files` | Filename + content search across the active folder (general folders, no AI needed) |
| `tidy this folder` / `organize this folder by type` | Preview + confirmed move of loose files into type/date folders (journaled, revertible) |
| `find duplicate files` / `delete duplicates, keep newest` | Hash-based duplicate detection (read-only) and the confirm-gated cleanup |
| `merge these pdfs into combined.pdf` | Merge PDFs into one new file (confirm-gated, never overwrites, revertible) |
| `split report.pdf into one file per page` / `split report.pdf at page 5` | Split a PDF per page or around a page (confirm-gated, revertible) |
| `extract text from report.pdf` | Read-only text extraction with preview |
| `extract pages 2-5 from report.pdf into excerpt.pdf` | Copy a page range into a new PDF (confirm-gated, revertible) |
| `watermark report.pdf with confidential` | Stamp text across a copy of a PDF (confirm-gated, revertible) |
| `undo` / `revert that` | Restore the last change (git checkpoint or file journal) |
| `type the command directly` | Allowlisted command lines (git push, npm run ...) run as-is |
| `npx local-project-console init` | Bootstrap a console.config.json for a project |

### Schedules, notifications & automation

| Command | What it does |
|---|---|
| `schedule every 10 minutes "git status"` / `schedule daily at 09:30 "run the tests"` / `schedule on file save "npm run lint"` | Run a command on a timer or trigger (read-only, confirm-gated) |
| `list schedules` / `show my schedules` | Shows the project's scheduled/triggered commands |
| `delete schedule 2` / `remove schedule 1` | Removes a scheduled command by its list number |
| `schedule log` | Shows the run history of scheduled commands |
| `remind me tomorrow at 9am to renew my license` / `remind me in 3 days to follow up` | Personal reminder with natural-language dates (fires to open chat or log) |
| `list my reminders` / `cancel reminder s2` | List or cancel a personal reminder (cancel also via the Reminders panel checkbox) |
| `note: buy milk` / `add a note: remember the wifi password` | Jot a user-authored scratch note (no confirmation) |
| `show my notes` / `search my notes for wifi` | List or search notes (also via the Notes panel) |
| `sum column sales in data.csv` / `average column price in data.csv` | Read-only CSV aggregates (quoted-field aware, no AI) |
| `count rows in data.csv where status equals done` / `filter data.csv where price greater than 50` | CSV row filtering — fixed ops: equals/contains/greater than/less than (filter table also via the Spreadsheet panel) |
| `show clipboard history` / `copy clipboard item 2` / `clear clipboard history` | Opt-in OS clipboard history (Settings → Advanced) — copy re-writes to the OS clipboard server-side |
| `save this as a snippet: welcome` / `copy snippet welcome` / `delete snippet welcome` | Named text snippets (global, persistent) |
| `backup this folder` / `export this project as a zip` | Zip the project to data/backups (read-only on the source, journaled, revertible) |
| `list backups` | Show past backups (also via the Backup panel) |
| `notify me when dev-server-crash` / `stop notifying me about ...` | Desktop/webhook alerts per event — all off until you opt in |
| `webhook add <url>` / `webhook remove <url>` / `list notifications` / `test notification` | Webhook channels and verification |
| `notify me when files change in <folder>` / `notify me if <folder> hasn't changed in 7 days` | File-watch rules (notification-only, never a command trigger) |
| `list watched folders` / `stop watching <folder>` | Manage watch rules (also via the Notifications panel) |

### Learning, diagnostics & introspection

| Command | What it does |
|---|---|
| `review learning` / `check learning` | See near-miss suggestions |
| `approve suggestions 1 3` | Promote suggested phrases into the matcher |
| `telemetry review` / `telemetry stats` | Match statistics + learned-model status |
| `threshold set <intent> <floor>` | Override an intent's confidence floor |
| `telemetry clear` | Reset telemetry for the current project |
| `check collisions` | Find overlapping intent embeddings (cosine >= 0.9) |
| `review distillations` / `apply all distillations` | Turn AI learnings into trigger-mode entries |
| `review memory` / `memory patterns` | Usage patterns (frequent commands/files/questions) |
| `show history` / `recent actions` / `revert action 3f2a9c1d` | Recent file edits + confirmed commands; revert restores a file edit or advises the git undo |
| `health check` / `is my console healthy` | Ollama reachability, embedding state, disk space, zombie tracked processes |
| `what is my test coverage` / `analyze bundle size` | Reads existing coverage/build artifacts — never runs anything |
| `what port are you running on` | The console's own port |

### UI, settings & AI

| Command | What it does |
|---|---|
| `help` / `what can you do` / `how do I <anything>` | Full command guide; how-do-I answers come from the command catalog with the exact phrase, the real shell command, and a suggestion chip |
| `list commands` / `help all` / `show all commands` | Prints the ENTIRE command catalog as plain text — the CLI's equivalent of the Command Reference tab (book icon in the header) |
| `what is 12 times 7` / `convert 5 km to miles` / `whats 18% tip on 64.50` | Safe arithmetic + offline unit conversion + percentage/tip/tax (also via the Calculator panel) |
| `open calculator` / `open pdf tools` / `open reminders` / `open file tools` / `open notes` / `open spreadsheet` / `open clipboard` / `open backup` / `open notifications` | Opens the interactive Tools panel (web UI); plain-text note + chat equivalents from the CLI |
| `switch to developer mode` / `switch to general mode` / `what mode am I in` | Change/check a project's workspace type (persisted in console.config.json) |
| `switch projects` / `change projects` | The project list in the left sidebar |
| `dashboard` / `live sites` | The Dashboard tab: project overview + live-site status |
| `the theme toggle in the top bar (sun/moon)` | Dark/light switch, persists per browser |
| `the model picker in the AI popover` | Local Ollama + cloud models (`ollama pull <name>` for new ones) |
| `install pack <path-to-console.tools.json>` | Add custom tools from a local manifest — preview first, confirm to install |
| `AI mode: "remember that ..."` | Save a durable cross-session fact to .console/memory.md |
| `chat header download icon` | Export the session as Markdown/JSON/PDF; chat-log download from the session list |
| `how do i publish this` / `how do i install this on someone else's system` | Publish-to-npm and cross-machine install steps (see "Publishing & installing on another machine" below) |

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

## Publishing & installing on another machine

You can also just ask the console itself — "how do I publish this" or "how do I install this on
someone else's system" answers from the command reference with the exact commands below.

**Publishing a new version (from this repo):**

```powershell
npm login                    # once per machine, if you haven't already
npm version patch            # or minor / major — bumps package.json and tags a commit
npm publish
```

`package.json`'s `"files"` array controls what actually ships (`bin/`, `dist/`, `server/`,
`README.md`, `LICENSE`) — `data/`, personal config, and anything gitignored never gets published.
Run `npm run build` first if `dist/` isn't already up to date; `npm publish` ships whatever's on
disk, not a fresh build.

**Installing on someone else's machine (no clone required):**

```powershell
# Option A — install once, run anytime:
npm install -g local-project-console
local-project-console

# Option B — no install, one-off run:
npx local-project-console
```

Either way it opens the same setup flow as running from source: pick or type a folder to scan,
and the first-run wizard walks through the rest. It needs Node 18+ and, for AI mode, a local
[Ollama](https://ollama.com) install — everything else (the matcher, trigger-mode commands, git
integration) works with zero setup.

---

## Author & License

Created by **Tobi**. Released under the [MIT License](LICENSE) — free to use, modify, and redistribute.
