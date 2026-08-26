# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning policy: minor for new features, patch for fixes, major for breaking
changes. The npm package (`local-project-console`, currently `1.0.8`) and the
desktop app (`local-project-console-desktop`, currently `1.0.0`) are versioned
independently; desktop releases are tagged against the desktop package.

## [Unreleased]

### Added
- Desktop shell: console now runs in the app's own native window (splash during
  cold boot; `openExternal` only for external https links). Non-zero server
  startup exits surface immediately with a specific error page + Retry/Quit
  dialog instead of a silent 90-second probe-then-quit.
- CLI: `desktop/cli.cmd` + an NSIS "Project Console CLI" Start Menu shortcut
  launch the packaged client via the Electron binary
  (`ELECTRON_RUN_AS_NODE=1`) — zero separate Node.js install needed.
- First-run web save failures now revert the optimistic update and show the
  error inline.
- **Hardening round (2026-08-26)**: `docs/adr/` (4 architecture decision
  records pinning the matching-pipeline stage order, safety-layer order,
  memory-store split and WS/CLI parity, each with harness cross-references);
  Dependabot (weekly npm/root + desktop + actions, documented pins ignored);
  Keep-a-Changelog + semver discipline; per-panel React error boundaries (one
  throwing panel can never take down the UI); fast-check fuzz properties for
  the safety leaves (17 properties — found + fixed live: 0.0.0.0/8 numeric
  hosts were externally fetchable, `rm -fr` dodged the risk classifier,
  blocklisted rmdir/device-redirect/shutdown/Reflect/fork-bomb shapes were not
  confirm-worthy).
- **`console doctor`** (`npm run doctor` / `node bin/cli.js doctor` / chat
  command): proactive machine-side checks that work even when the console
  cannot boot — ports 3000–3019 free, daemon alive, embedding model cached,
  runtime writability, Ollama, update status, tooling, disk. Exit 0/1/2 for
  scriptability.
- **`review match quality`**: rolling per-message match telemetry
  (`data/match-stats.jsonl`, one line per trigger-mode message) + a report
  command that flags intents whose recent mean confidence dropped >0.1 vs the
  prior window — matcher drift becomes visible before it misfires.
- Structured logging with **pino** (JSON in prod, pretty in interactive dev);
  the ~81 `console.*` server call sites are level-mapped (`server/logger.js`).
- The 7 safety leaves converted to **TypeScript** (paramCommand, urlSafety,
  commandRisk, dangerousPatterns, toolAllow, executorSandbox, toolGate) with
  compile-time guarantees in `tsc --noEmit`; the desktop stage now bundles the
  server entry (esbuild) so the packaged runtime stays plain-Node.
- Pre-commit gate: husky + lint-staged with a file→battery mapper
  (`scripts/guard-staged.mjs`) — type-check + the harnesses a change touches,
  before anything is committed.

### Fixed
- CLI `--json` piped stdin never flowed on Windows (data arriving before the
  readline attach was dropped; EOF could trip a libuv assert) —
  `process.stdin.resume()` runs before `createInterface` now.
- Auto-update publish: `publish-windows` job granted `contents: write`, so the
  first real GitHub Release (v1.0.0, latest.yml + installer) publishes; a
  first-release race between electron-builder's two publish passes was cleaned.
- SSRF guard: numeric `0.0.0.0/8` hosts (RFC 6890 "this network") were
  externally fetchable — now blocked for numeric dotted-quad hosts without
  touching DNS names.

### Changed
- Port fallback widened from 3000–3009 to 3000–3019 across every launcher
  (server, CLI, desktop, daemon, `start.bat`, PowerShell scripts, docs).
- All `check-*` harnesses run under `node --import tsx` (they import the
  TypeScript safety leaves).

## [1.0.8] — 2026-08-24

Audit rounds 1–6 (unattended) + desktop packaging repair.

### Added
- Real desktop packaging: `desktop/scripts/stage-server.mjs` stages a runnable
  server runtime (source + built frontend + prod node_modules); a broken
  packaging design that could never have produced a working installer was
  replaced end-to-end. CI builds real Mac `.dmg` and Linux `.AppImage`
  artifacts.
- Auto-update via `electron-updater` + GitHub Releases (`dist:publish`,
  `publish-windows` CI job), tray "Check for updates", update-banner awareness
  in the server child (`CONSOLE_DESKTOP=1` short-circuits the npm update
  checker).
- Fresh-install data: installs start empty (no developer profile/telemetry);
  first-run onboarding shows.
- Differentiation: matcher-stage transcript logging, zero-network-floor
  verified, capability probe, CLI `--dry-run`/`--explain`.
- Desktop self-documentation (`server/desktop-release.md`) + three how_do_i
  catalog pins for the build/release pipeline.
- 13 oversized files split into focused modules (executor, cli-client, matcher,
  App.tsx, useConsole, UserProfileModal, FolderExplorer, Dashboard, FileTools,
  TerminalMessages, PdfTools, Spreadsheet).

### Fixed
- P0: packaged app crashed at boot — a static `vite` import in `server/index.js`
  (vite is dev-only; `npm ci --omit=dev` skips it). Now a guarded dynamic import.
- P0: `pdf-parse`→`pdfjs-dist` evaluated `new DOMMatrix()` at module scope and
  crashed the server when the `@napi-rs/canvas` native binding was missing —
  now a lazy guarded import; PDF build/split/watermark keep working.
- P0: `waitForServer()` boolean was interpolated into a URL, opening a real
  window that hung pointed at the wrong port.
- Zero known vulnerabilities (xlsx, protobufjs, sharp CVEs resolved);
  SSRF/XSS/secrets-leak fixes.
- 61 → 0 non-structurized console calls tracked; tone passes removed
  AI-sounding comments.

## [1.0.7] — 2026-08-17

Audit remediation: security, safety, persistence, latency, dependencies, docs.

- Dependency hardening: `protobufjs`/`sharp` overrides; `natural` removed and
  replaced by `server/porterStemmer.js` (byte-identical parity).
- Persistence chain fix: session-metadata writes serialize through
  `serializePersistence` (an `AsyncLocalStorage` holder-context prevents a fast
  AI turn from racing the greeting turn and dropping a `messageCount` update).
- Command-risk classifier (`server/commandRisk.js`) computes effective risk of
  `executeCommand`; cancel scoping (kills only the current AI turn's processes).
- Phase-6 latency + `updateChecker` fixes.

## [1.0.6] — 2026-08-14

Chat upgrade pass (Matchday-Exchange crosscheck + Phase T/T2).

- Matcher fixes: site-overview questions no longer trigger the deploy confirm;
  typo'd time questions route to time; extension-tolerant file resolver for
  typo'd filenames; "Which file?" follow-ups for file_relations/open_file.
- Per-tab workspaces, `scanAllFolders` setting, in-console HTML preview.
- Folder Explorer panel with back/forward, search, open-in-default-app;
  open-with-IDE; sectioned/guided tours; expanded settings (Editors & IDEs).
- `run the site on port N` rewrites the script's own `--port` flag (single,
  unambiguous).
- `console.config.json` mode bookkeeping auto-gitignored when the console
  writes it (unless already tracked).

## [1.0.5] — 2026-08-12

Matchday crosscheck + large UI/UX upgrade.

- 6-stage theme-aware redesign (design tokens, accent-color picker,
  panels to native shadcn styling), Stage H accent sweep.
- Phase 12–21: action-history audit, command palette ranking, command
  reference tab, backup/zip, clipboard history + snippets, spreadsheet-lite
  CSV, i18n scaffolding (German POC), first-run onboarding, file-watch
  notifications, documents knowledge base, pack marketplace, multi-user LAN
  attribution (Phase 19).

## [1.0.0 – 1.0.4] — 2026-08-10 to 2026-08-12

Initial published versions covering the pre-phase-12 roadmap: matching pipeline
(pre-semantic → embedding → fuzzy → NLP → router → fallback), the four-way
memory store, layered safety model, WS/CLI parity, action history + revert,
PDF toolkit, general-mode file tools, shared tool-panel architecture, portable
workspace export/import, real semantic code index, reminders, scheduled
commands, notifications, auto-start, health check, update checker, runtime
tuning overrides, and the Electron desktop shell.

## Unreleased-policy notes

- The npm package ships `server/` source and the `dist/server.js` bundle; the
  bundle must be regenerated (`npm run build`) before publishing so the
  shipped runtime matches the source.
- Desktop version bumps happen per desktop release (currently `1.0.0`).
