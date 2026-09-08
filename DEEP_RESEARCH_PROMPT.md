# DEEP RESEARCH PROMPT — Project Console V4 — Full Codebase & Experience Audit

> **Purpose**: This is the *research-only* prompt. Do NOT make code changes while executing it. Produce evidence, inventories, measurements, and gap lists that a later *execution* phase will implement. The execution phase (on explicit user instruction) must finish by updating `README.md`, `features.md`, `CLAUDE.md` and then `git push` + `npm run build` / `desktop` rebuild.
>
> **Invocation**: Run with agents via `Task` (Explore: quick/medium/very thorough + General). Maximize parallelism where dependencies allow. Every claim must be evidence-backed (file:line + snippet or measured log). "Should work" is not verification.

---

## 0. Operating Constraints & Non-Negotiables

1. **No code changes during research**. Read-only. If a file must be touched to instrument, do it in `%TEMP%` or a scratch driver outside the repo root (Vite watches `data/`, `.cache/`, `.console/` — a file in the repo root stalls WS for 60–90s). Use `node --import tsx` harnesses, `rg`, `Read`, `Glob`, `Grep`.
2. **Git hygiene**: Start by confirming `git status` is clean. A checkpoint commit `ac28654` already exists ("Pre-research checkpoint"). Do NOT commit research artifacts to main until execution. If you must snapshot findings, write to `audit/` or `docs/adr/` drafts and keep them gitignored or on a branch.
3. **Professional code lens** (throughout): Every file you inspect, tag: `professional` vs `vibecoded` signals — dead code, unused vars, `any`, `console.log` leftovers, magic numbers not in a `*Constants.ts`, 400+ line files, inconsistent indentation, slang in comments, missing error handling. Capture file:line for each.
4. **Modularity lens**: Flag any file >400 lines (target ~150), any orchestration wrapper >300 lines that should be split (reference: `server/wsHandlers/`, `src/hooks/`, `src/components/dashboard/`, `folderExplorer/` split patterns). Note cross-import cycles.
5. **Latency lens**: Every latency note must include *measured* timing (cold boot to `Ready -- N`, semantic model load, `npm run dev` vs `dist/server.js`, tab switch spinner duration, WS `matchInput` ms, `/api/dashboard` probe ms). Do not estimate.
6. **Customization lens**: Flag any hardcoded color, size, port, path, string, or threshold that should be a token/profile/tuning override. Check `src/index.css` tokens, `toolPanelRegistry`, `intentRegistry`, `tuningStore`, `data/user-profile.json`, `DEFAULT_TUNING`.
7. **Two-session parity**: This prompt runs in 2 parallel sessions. Both must produce the same evidence shape so results can be diffed. Do not rely on local-only mutable state (clear `.cache/`-dependent timings should be noted as warm vs cold).

---

## 1. Phase 0 — Pre-Flight & Inventory (Agents: 1x General)

**Goal**: Baseline truth before any analysis.

- [ ] `git status`, `git log --oneline -10`, `git diff --stat` origin/main. Confirm clean.
- [ ] `node --version`, `npm --version`, `npx tsc --noEmit` (capture output), `npm run lint` baseline.
- [ ] Inventory counts (record exact numbers):
  - `server/` files, `server/wsHandlers/` files, `server/intents/` phrases (grep `trigger|examples`), `server/routes/` endpoints, `src/components/` panels, `BUILTIN_INTENTS` size, `TOOL_PANELS` size.
  - Lines-per-file histogram (bucket: <150, 150–300, 300–400, 400+). List every 400+ file with line count.
  - `rg -n "TODO|FIXME|HACK|TEMP|hardcoded|hard-code"` across repo.
- [ ] Verify shadcn/Tailwind/TS stack: read `components.json`, `tsconfig.json`, `vite.config.ts`, `src/index.css` (`@theme inline`), `src/lib/utils.ts` (`cn()` uses `twMerge(clsx)`). Confirm `aliases.components == "@/components"`, `ui == "@/components/ui"`. If not `ui`, document why `src/components/ui` is required (shadcn CLI `npx shadcn@latest init` writes there; `button.tsx`/`card.tsx` imports resolve via `@/components/ui/*`).
- [ ] Check `desktop/` packaging pre-conditions: `desktop/package.json` `files` globs, `desktop/scripts/stage-server.mjs` stages `server/`, `bin/`, `data/` (empty), `vite-built frontend`, `npm ci --omit=dev`, `after-pack.cjs` node_modules inclusion, `ELECTRON_RUN_AS_NODE=1` in `main.cjs`. Confirm `server/index.js` lazy-imports `vite` (static import = packaged crash).
- [ ] Output: `audit/preflight.md` with tables + raw counts.

---

## 2. Phase 1 — Conversation Log Forensics (Agents: 3x Explore very thorough + 1x General synthesizer)

**Where logs live**:
- Legacy: `data/conversations/*.json` + `*.ndjson` + `data/conversations/index.json` (check `index.json` corruption / `.tmp` orphans).
- Current: `<project>/.console/sessions/*.json` + `*.ndjson` + `<project>/.console/chat-log.md` — auto-discover via `allKnownProjects()` / `data/general-workspace/.console/sessions/` (the `__general__` pseudo-project).
- Telemetry: `data/telemetry/*.jsonl` (incl. `project-console.jsonl`), `data/match-stats.jsonl`, `data/near-misses/*.jsonl`, `data/distillations/*.jsonl`, `data/action-history.jsonl` per project, `logs/daemon.port`, `server.log` + `.prev`.
- Desktop/CLI: also `data/general-workspace/.console/` and any `.console/` under `C:\Users\tobil\Desktop\Projects\*`.

**Tasks per agent** (split by corpus, not by question):

**Agent A — Trigger-mode forensics**:
- For every user message, extract `{input, intent, stage, confidence, margin, matchedTrigger, responseText, responseLen, hasConfirm, hasSuggestion, isFallback}` from `telemetry/*.jsonl` + session `*.ndjson` (`meta.match`). Where `meta.match` missing (old sessions), reconstruct via `matchInput` replay.
- Classify question types the user actually asks: run/build/deploy/git, file find/tidy/duplicates, open/reveal, knowledge/overview/stack/routes, calculate/convert/percent, reminders/notes/csv/clipboard/backup/pdf, chit-chat (tired/empathetic), how-do-i, multi-intent ("and/then"), typo-d variants. Build frequency table + paraphrase variants per type.
- Rate each console response on: naturalness (robotic vs human), length (target: concise 1–3 sentences for simple, longer only when data-dense), variation (does same intent produce same canned line every time? Check `chitChatIntents` templates, `consoleCommandDocs` rendering). Flag overly long, repetitive, or templated replies with examples.
- Flag every fallback / `did_you_mean` / `suggestions` miss and what the follow-up correction was.

**Agent B — AI-mode forensics**:
- Same as A but for `ai_*` WS messages (`aiQuery.js`, `ollamaContext.js`, `aiStream.js`). Check: thinking truncated mid-stream (`aiQueryInFlight` + `autoExpand` in Terminal), `MAX_TOOL_ROUNDS` hit, `<tool_call>` extraction failures, fabricated PID/tool-result (verify `pid` in `executeCommand` results), `saveMemory` gating (`low` vs `judgment`), context pruning (`contextPruner.js`) dropping relevant history.
- Check Ollama Cloud vs local fallback (`listCloudModels`, `CLOUD_MODELS` 404 handling), `NUM_CTX`, streaming `thinking` vs `content` separation.

**Agent C — Failure & edge-case forensics**:
- Catalog every error surface: WS `error_output`/`warning`, `dangerousPatterns` blocks, `isCommandBlocked`, `commandRisk` escalations, `validateToolCall` syntax failures, `verifyHarness` background `tsc` failures, `sessionIndex` corruption recovery, `ensureGitignored`/`ensureConsoleConfigGitignored` collisions, port-collision warnings (`isSamePortAsConsole`), `EADDRINUSE`/`NO_UPSTREAM` retries, `taskkill` survivor warnings.
- For each, note: was the error actionable? Did it suggest the fix? Was it a placeholder ("not implemented")?

**Synthesis (General)**:
- Merge A/B/C into `audit/conversations.md` with:
  - Table: intent family → example inputs → actual response (short excerpt) → rating (concise/varied/natural 1–5) → failure rate.
  - List: top 20 paraphrases the user uses that have weak/no coverage (with nearest intent + confidence).
  - List: top 20 responses that should be shorter or have 2–3 variations.
  - List: every stale/placeholder/no-op reply.
  - Recommendation: new `chitchat` template variations, per-intent length caps, retry hints.

---

## 3. Phase 2 — Live Chat Fuzzing (Agents: 2x General — one trigger, one AI)

**Method**: Drive a live server via WS (`ws://127.0.0.1:<port>/stream`) from a `%TEMP%` driver (never repo root). Use the batteries in `server/scripts/batteries/matcherBatteries.js` as seed + generate novel paraphrases (typos, synonyms, question vs imperative, with/without file names). Record `{input, stage, intent, confidence, suggestions, didYouMean, answerText, latencyMs}` per message. Await `end` (not quiet-window) per turn.

**Trigger-mode driver** (covers):
- All `BUILTIN_INTENTS` at least once + 3 paraphrases each (use `check-matcher` CONTROL/PHASE batteries + `check-handlers` dispatch rows as ground truth).
- Adversarial: "run the site on port 3010" (port rewriting), "merge alpha.pdf and beta.pdf into combined.pdf" (pdf deploy trap), "extract the zip file" (pdf vs file_count), "find duplicate files" (Windows `find.exe` guard), "convert 5 km to miles" (`convert` binary guard), "what is the tme" (typo time), "what is the site about" (overview vs deploy), "how do i publish" (how_do_i vs deploy), quoted vs unquoted file creates, natural-language `find`/`sort`/`where` vs real commands.
- Multi-intent: "show structure and run tests" (split), "show it" (context carryover), "ok" after a confirm (AI_ACK_RE short-circuit).
- Workspace type: same phrase in `dev` vs `general` (suggestion filtering only, not dispatch gate).

**AI-mode driver** (covers):
- Toggle `ai on`/`ai off` via `ai_toggle` (CLI) and header toggle (web). Verify `ai_status` push, `needs_ai_mode` CLI vs web hint (`aiDockInstruction`).
- Streaming: long prompt that forces `think: true` trace, verify no mid-thinking cut-off (`aiStream.js` + `wsStreamingCases.ts` buffering, 45ms batching, idle watchdog 2m).
- Tool loop: ask AI to `readFile` then `editFile` (confirm gate, diff preview, `undoLastChange({path})`), `executeCommand` risky vs non-risky (must checkpoint), `runTests`/`stopProcess` always-confirm.
- Cancellation: `cancel` vs `abort_ai` (turnKey scoping).

**Deliverable**: `audit/fuzz-results.ndjson` + `audit/fuzz-summary.md` (pass/fail per intent, latency p50/p95, every miss with expected vs actual intent, screenshot/log excerpt for truncated thinking).

---

## 4. Phase 3 — Professionalism & Modularity Sweep (Agents: 3x Explore medium)

**Agent A — Style & correctness**:
- `rg -n "console\.log|console\.warn.*TODO|TODO|FIXME|any\s*:|@ts-ignore|eslint-disable|vibe|just |basically"` (flag slang in comments/strings).
- Check every file for: `cn()` usage (not bare `clsx`), consistent indentation, `type` vs `interface` coherence, exported but unused symbols (`ts-prune` mental), dead branches, commented-out code, `process.exit()` vs `process.exitCode` (daemon gotcha).
- Verify every `.ts` safety leaf has an extensionless importer (esbuild `dist/server.js` bundling rule).

**Agent B — Modularity & size**:
- List every file >400 lines (flag), 300–400 (warn), 150–300 (review if orchestrator). Cross-ref `CLAUDE.md`'s 400-line convention + documented exceptions (`App.tsx:513`, `matcher.js:312`, `useConsole.ts:389`).
- For each oversized file, propose split leaves (e.g. `Terminal.tsx:520` → `TerminalHeader/Messages/ConfirmCards/...` as done before). Check import cycles with `madge` mental.

**Agent C — Error hygiene**:
- `rg -n "throw|catch|try|not implemented|placeholder|coming soon"` — every placeholder must be accounted for (either removed or behind a panel `coming in later update` placeholder with a tracking issue).
- `rg -n "ws\.send|broadcast\("` — verify every new WS type has a handler in `src/hooks/wsMessageCases.ts`/`wsStreamingCases.ts`, `server/cli-client.js` + `cliRenderer.js`, and a row in `scripts/checkWsMessageCases.ts` (`WS_CORE_CASES`).
- Check `server/verifyHarness.js` / `aiGuardrails.js` / `actionHistory.js` journal coverage — every mutating path must journal (`appendAction`) with `preContent`/`existed`.

**Deliverable**: `audit/code-quality.md` — per-file table (size, style issues, dead code, placeholder, split recommendation) + top 20 vibecoded lines with `file:line` + fix snippet.

---

## 5. Phase 4 — Tour System & Guided Immersion (Agents: 1x Explore thorough + 1x General)

- Inventory `src/tours.ts`, `src/components/TourOverlay.tsx`, `src/hooks/useAppViewState` tour wiring, `data-tour` attributes (list every `data-tour="..."` in codebase with `rg -n "data-tour"`), `WelcomeScreen` card vs guided toggle, `UserProfileModal` Tours section, `localStorage["console.toursTaken"]`.
- For each of the 10 sections + 3 groups (per last roadmap), verify: spotlight ring (`getBoundingClientRect`, `scrollIntoView`, resize re-measure), `lpc:tour-view` view switching, backdrop blur, `rounded-2xl`/`shadow-modal`, `liquid-glass` toggle interaction, keyboard nav (Esc/backdrop/←/→), completion badge.
- Map uncovered surfaces that need tours: CommandDeck (`Ctrl+K`), Dashboard tabs, ProcessDock History, Tool Panels (Calculator/PDF/Reminders/File Tools/Notes/Spreadsheet/Clipboard/Backup/Notifications/Documents/Marketplace/Repo Map), Folder Explorer (path/breadcrumb/back-forward/search/view toggle), Tab strip (new/close/persist), Terminal confirm cards, AI toggle/mode picker, Theme/Accent picker, Notifications bell, CLI launcher.
- Propose immersive upgrades: spotlight SVG cutout vs ring, step-progress scrubber, per-panel deep tours (e.g. PDF Tools 5-step), auto-advance on action, hover-driven sand/block ambient (blend with loading screen), reduced-motion alternative.
- Deliverable: `audit/tours.md` — coverage matrix (tour → targets hit/missed, immersive gaps, stale/placeholder steps) + proposed new tours spec.

---

## 6. Phase 5 — Latency & Reliability Deep Dive (Agents: 2x General — one frontend, one backend)

**Frontend**:
- Tab rescan: profile `POST /api/scan-path?tab=` (measure `discoverProjects` + `projectScanner` + `codebaseIndexer` hot path), `restoreTabs()` fire-and-forget vs await trade-off, `activeTab` fallback showing former path (race). Propose optimistic per-tab cache, skeleton, abort on tab switch, `tabWorkspaces` Map invalidation.
- Dashboard `/api/dashboard` 30s cache + `volatileSignature()` + 1200ms probe staleness (the 2026-08-18 `forgetDevUrl` fix). Measure probe p95.
- CommandDeck fetch caching (`cached for palette lifetime`).
- Terminal auto-scroll (`only near bottom`), output coalescing (150ms `createBufferedSender`), `LineRingBuffer` 2000-line cap.

**Backend**:
- Cold boot: from `npm run dev` / `node dist/server.js` / `desktop` child to `Ready -- N` — measure with `console.time` around `semanticMatcher.initialize()`, `nlpEngine` rebuild, `discoverProjects`, `initScheduler`/`initNotifications`/`initAutoStart`. Check lazy-imports: `@xenova/transformers`, `vite` dynamic, `pdfjs-dist`/`@napi-rs/canvas` guard, `natural` removal. Assess 23MB model `.cache/` not staged for desktop (first boot download >90s `waitForServer` deadline).
- Semantic matcher warm-up blocking event loop 30–45s (reminder shape fast path vs embedding). Propose: worker thread, quantized model, `all-MiniLM-L6-v2` cache warming indicator, fallback to fuzzy/NLP instantly.
- Port fallback loop 3000–3019: `probeRunningPort`, `withPortCollisionWarning`, `start.bat` background PowerShell watcher, `globalThis.__consoleServerPort` polling. Repro "app couldn't find a port" error path (`server.log`/`server.err.log` tail on connect failure).
- CLI crash (exe): `bin/cli.js` source mode `import('tsx/esm/api')`, `desktop/main.cjs` `ELECTRON_RUN_AS_NODE`, `CONSOLE_DESKTOP` flag, `serverStderrTail` hoisting, `crlfDelay: Infinity`. Capture crash repro under `desktop/stage` vs `tsx` source.
- `taskQueue` `MAX_TASK_CONCURRENCY=3`, per-project FIFO, `DEBOUNCE_MS`/`DETACHED_EXIT_PROBE_DELAY_MS` knobs.

**Deliverable**: `audit/latency.md` — cold-boot waterfall (ms per subsystem), tab-switch timeline, WS `matchInput` latency by stage, probe latency, CLI crash stack (if repro), prioritized fixes (worker, cache, optimistic UI, staggered boot) with tuning knobs to expose.

---

## 7. Phase 6 — Customization & Hardcoding Audit (Agents: 1x Explore very thorough)

- Enumerate every hardcoded value: colors (`#0071E3`, `#0A84FF`, `accent-blue` vs `accent` drift), radii (`rounded-full/lg/xl/2xl`), shadows (`shadow-card/float/modal`), spacing (8px grid, 44px target, 24px container), type scale (`text-display/h1/h2/subhead/body/caption/code`), `COMMON_DEV_PORTS`, `MAX_*` caps (`MAX_PDF_BYTES 150MB`, `MAX_TOTAL_PAGES 2000`, `2MB CSV`), `DEV_URL_DETACH_GRACE_MS`, `FUSE_THRESHOLD`, `IGNORE_DIRS`, `DOCUMENT_EXTS`, `TOOLS panel` ids, `BUILTIN_INTENTS` gate.
- Verify each has a token / `tuningStore` / `data/user-profile.json` / `GET /api/tuning` path. Flag: tour color still fixed blue, project folder icon blue, hover highlight blue (`accent-blue` override only patches one token — `App.tsx` accentColor effect), black theme not blending user color, missing `liquidGlassEnabled` toggle.
- Check `settings` UI: `UserProfileModal` accent picker, `TuningSection` groups, `EditorsSection`, `explorerViewMode`, per-tool toggles (`clipboardHistory`, `clipboardPersist`, `sandboxRiskyCommands`, `permissionMode: 'ask'`, `scanAllFolders`) — each must round-trip via `GET/POST /api/profile` + live `syncClipboardPolling`/re-render without restart.
- Deliverable: `audit/customization.md` — hardcoded → token mapping table (file:line, token name, settings UI status, migration fix).

---

## 8. Phase 7 — Login & User Portal (Research-only design) (Agents: 1x General)

- Survey existing identity: `HOST=0.0.0.0` LAN attribution (`set_display_name`, `GET /api/connected-users`, `createdBy` on actions/notes/reminders) — explicitly *not* auth (per `CLAUDE.md`). Document the deliberately-out-of-scope boundary.
- Research portal shape: per-user password (hashed with `argon2` or `bcrypt` via optional dep), reset via system auth (Windows Hello / `Credential Manager` / `PowerShell Get-Credential` / `os.userInfo()` + `data/users.json` gitignored, `CONSOLE_AUTH_MODE` env). Consider: local-only vs LAN, session JWT vs WS `display_name` upgrade, `permissionMode` interaction, `data/user-profile.json` per-user sharding.
- Assess Electron `safeStorage` (DPAPI on Windows) for secret-at-rest, `desktop` auto-login vs lock screen, CLI `--user` flag parity.
- Constraints: no network auth service, no plaintext password in `data/`, reset must not weaken `confirm gate` / `blocklist`.
- Deliverable: `audit/auth-design.md` — threat model, storage schema, routes (`POST /api/auth/login`, `POST /api/auth/reset`), UI flows, migration plan, explicit non-goals.

---

## 9. Phase 8 — Installer & Loading Screen Redesign (Agents: 1x Explore + 1x General)

- **Current**: `desktop/scripts/stage-server.mjs`, `electron-builder` NSIS (`.exe`), `dmg`/`AppImage`, `after-pack.cjs`, `CONSOLE_DESKTOP`, `server/desktop-release.md`, `desktop/build/icon.png:512`. Install takes long (stage includes `npm ci --omit=dev` + Vite build). Loading is a plain splash with `waitForServer` 90s deadline.
- **Design target** (from user images): top half large "Project Console" wordmark + small "made by Tobiloba Jagun" subline; bottom half loading state (phase label, elapsed time, progress bar/spinner, port probe status). Color scheme: blue (#0071E3/#0A84FF), red (#FF453A/#FF3B30), black (#0D0D0E), white (#FFFFFF) — sand-like blocks that drift/blend on mouse move (reference: Google Antigravity starfield + 21st.dev hero/sonar-grid/waves-shader — subtle grain, directional flow field, not a heavy shader).
- Reference the attached visuals: Antigravity stardust parallax, sonar-grid dot field with ping ripples, `CURRENT` directional hatch, `Codex` metaball — propose a lightweight canvas/WebGL field (e.g. `sonar-grid.tsx` with `spacing=26`, `speed=260`, `ringWidth=90`, tinted by the four-brand palette, `prefers-reduced-motion` fallback to static grid).
- Requirements: staged `node_modules` cached between updates (electron-updater differential), progress streamed via `update-test.log` / IPC, NSIS `oneClick:false` with directory picker, retry on `sharp`/`libvips` timeout (known `npm` fix — retry, not `--ignore-scripts`), pre-cache `.cache/xenova` to avoid first-boot download.
- Deliverable: `audit/installer-loading.md` — current timings (stage/build/install/update), proposed splash spec (layout wireframe in ASCII, palette tokens, canvas effect params, mouse-reactive blend math, reduced-motion), NSIS/differential update plan, `CONSOLE_UPDATE_URL` test hook.

---

## 10. Phase 9 — UI Design Upgrade (Agents: 2x Explore — one tokens, one components)

**Tokens & theming**:
- Audit `src/index.css`: `:root` dark vs `[data-theme="light"]` overrides, `accent-*` pairs (blue/teal/orange/green/red), `fg-*` ladder contrast (dark `fg-dim #86868B` 4.70:1, light `fg-muted #6E6E74` 4.54:1—measure again). Check `light-vs-dark leakage` (`dark:` utilities must not exist; only `var()` refs via `@theme inline`).
- Propose: user color blends into black theme (`color-mix(in oklab, var(--user-accent), var(--color-background) 80%)`), `settings → "color follows mouse"` (like project hover / loading sand), `liquid glass` on/off toggle (see below), more `rounded-2xl` / `rounded-full` per spec.

**Components**:
- Sweep every component for stray `bg-accent` vs `bg-accent-blue` (Stage H bug), `text-white` → `fg-*`, `border-white` → `border-border*`, `bg-black` → `bg-scrim`. List file:line.
- Verify `cn()` = `twMerge(clsx)` everywhere.

**Liquid Glass integration** (shadcn + Tailwind + TS stack is ready — `components.json` confirms `tsx:true`, `tailwind.css: src/index.css`, `aliases.ui: @/components/ui`, `src/lib/utils.ts` present):
1. `npm i @radix-ui/react-slot class-variance-authority` (already has `clsx`/`tailwind-merge`/`lucide-react`/`motion`).
2. Copy the provided `liquid-glass-button.tsx` (contains `Button`/`buttonVariants`/`liquidbuttonVariants`/`LiquidButton`/`MetalButton`/`GlassFilter` with `backdropFilter: 'url("#container-glass")'` + `feTurbulence`/`feDisplacementMap`) to `src/components/ui/liquid-glass-button.tsx` — keep the `"use client"` directive (harmless under Vite) and the `cn` import as `@/lib/utils`.
3. Copy `sonar-grid.tsx` to `src/components/ui/sonar-grid.tsx` (canvas dot field, `ringWidth/speed/amplitude/pingEvery` knobs, `prefers-reduced-motion` idle, `IntersectionObserver` pause). No extra deps.
4. Wire a `settings.liquidGlass: boolean` (default on) in `data/user-profile.json` → `GET/POST /api/profile` → `useTheme`/`useConsole` → conditional `LiquidButton`/`GlassFilter` vs plain `Button` (fallback when off or `prefers-reduced-motion`). Ensure SSR-safe (no `window` at import).
5. Apply `SonarGrid` as optional background for: loading splash, hero `WelcomeScreen`, empty states, and the `ToolsPanel` card grid (subtle `spacing=32` `baseOpacity=0.18` wash — not a full-page shader).

**Sonar hero** (second provided component): optionally use `sonar-grid.tsx` + its `demo.tsx` (uses `motion/react` already present) as the `WelcomeScreen` hero alternative to the static `GlowOrbs.tsx` — keep `GlowOrbs` as fallback when `motion` missing.

**Deliverable**: `audit/ui-upgrade.md` — token table (current vs proposed), component sweep (file:line per stray), integration steps verified via `npx tsc --noEmit` + `npx vite build` smoke, `liquidGlass` toggle spec, before/after screenshots plan.

---

## 11. Phase 10 — Home, AI Mode & Notification Routing (Agents: 2x General)

**Home screen**:
- `WelcomeScreen.tsx` hero + `BentoGrid.tsx` + stats strip + `FirstRunSetup.tsx` tour. Audit: Quick Start Guide button (what it does today — flag if `onClick` is no-op / stale `console.log`), placeholder buttons, dead `expand` buttons (Folder Explorer expand does nothing — `rg -n "expand"` + click handler check).
- AI mode header toggle + `AIAssistantInterface.tsx` (file upload, Search/Reason/Deep Research toggles). Verify deepthinking/reason toggle actually flips the `aiModePrompts` mode (not a dead prop), `NUM_CTX` env, streaming `thinking` not cut off (see Phase 2 AI driver).

**Project open & workspace switch**:
- Clicking a project sometimes opens Tools tab in `general` — trace `useConsoleTabs` `activateTab` → `toolPanel` default vs last-open (`console.toolPanelByProject`), `workspaceType` classification drift (`detectWorkspaceType`).
- `Developer↔General` switch currently sends a chat message — change to a top-of-site inline notification line (non-chat). Spec: `AppHeader` / `AppMainView` notification strip (auto-dismiss 4s), `settings → notificationsAtTop: boolean` (also governs tool-execution notices). Chat message must disappear; a non-blocking `notification` WS event replaces it.

**Tool execution decoupling**:
- Today: adding a note/reminder from a Tools panel composes a chat trigger command via WS (`handleExecute`) — adds latency + chat noise. Spec: panels call typed REST (`POST /api/notes`, `POST /api/reminders`) directly (normal code path, journaled), WS only for broadcast (`project_updated`/`dashboard_update`). Chat `add reminder to...` / `add note: ...` keep working (typed-command bypass + `builtinNotes`/`builtinReminders` intents).
- Verify: reminder complete → `completed` list (today missing), delete reminder/note → recycle bin (`data/recycle/*.json` with 30-day TTL + restore), file explorer basic path + `open with` shows OS apps for that file (not just editors), `expand` button wired or removed.

**Deliverable**: `audit/home-ai-routing.md` — per-button alive/dead table (file:line, handler, expected vs actual), AI thinking cut-off repro (with `aiStream` log), notification routing spec (strip component, settings, WS event), panel → REST decoupling plan, recycle bin schema.

---

## 12. Phase 11 — Tools & Panels Real-World Parity (Agents: 3x Explore very thorough — one per tool family)

For **each** panel/tool, compare to a real reference and audit both UI and functionality:

| Panel | Reference | Audit checklist |
|---|---|---|
| **Notes** | Apple Notes | 2-col split (240px rail + reader) filter persistence, add/search via `builtinNotes`, inline `contentEditable` bold/italic not rendering (check `NotesPanel.tsx` — does `bold` apply `document.execCommand` vs markdown `**`? Must render WYSIWYG), delete → recycle → permanent delete, tags, pin, search highlight |
| **Calculator** | iOS Calculator | `CalculatorPanel.tsx` keypad, `C/±/%/÷×−+`, `=` via `POST /api/calculate` (same `mathEval.js`), keyboard `digits/operators/Enter/Backspace/Esc`, Convert/Tip modes, display overflow |
| **PDF Tools** | macOS Preview / Smallpdf | `PdfToolsPanel.tsx` file list (download/reveal), drag-drop 50MB cap, merge multi-select, split per-page/around-N, extract text/pages, watermark, ever-overwrite guard, `pdf-lib`/`pdf-parse` error paths |
| **File Tools** | Finder | `FileToolsPanel.tsx` Finder rail + browser, search, tidy plan (by-type/by-date, per-row exclude), duplicates (MD5 groups, keep-newest, per-row select), rename/move via `general.files.*`, HTML Preview iframe (`/api/projects/:id/static/*`) |
| **Folder Explorer** | Windows Explorer / Finder | `FolderExplorerPanel.tsx` path/breadcrumb/back-forward/up/home/refresh, name-filter search, Lines/Objects toggle, double-click/Enter `POST /api/browse/open`, `Open with` (OS apps, not just `data/editors.json`), `Reveal`, `Copy path`, bottom bar, `localStorage` persist, any-absolute-path guard (`GET /api/browse`) |
| **Reminders** | Apple Reminders | `RemindersPanel.tsx` Today/Upcoming/All/No Date, quick-add, complete-as-cancel, overdue highlight, `Undo` snackbar, due persistence, `data/schedules.json` `kind: 'reminder'` |
| **Spreadsheet** | Apple Numbers / Google Sheets | `SpreadsheetPanel.tsx` CSV pick, column, Sum/Avg/Count/Filter, sortable sticky-header zebra `ResultTable`, upload 2MB cap, quoted-field `parseCsv` parity with chat |
| **Clipboard** | Windows Clipboard History | `ClipboardPanel.tsx` history (polling `clipboardHistory`, persist `clipboardPersist`), snippets (pin, import `.txt/.md`), server-side `copyToOsClipboard`, empty-state guidance |
| **Backup** | Time Machine | `BackupPanel.tsx` reverse-chron list, subfolder picker, zip to `data/backups/`, download/reveal, `revert action` deletes zip, `backups/` prefix special-case |
| **Documents** | Spotlight | `DocumentsPanel.tsx` status (unavailable/indexing/ready), `GET /api/projects/:id/documents?q=` + `.../ask?q=` AI synthesis, code-index `documentCount` vs `workspaceType` |
| **Notifications** | IFTTT / Zapier | `NotificationsPanel.tsx` rule cards, event toggles, desktop/webhook status, `POST /api/notifications/test-webhook` response panel |
| **Marketplace** | App Store | `MarketplacePanel.tsx` registry grid, SSRF-guarded HTTPS, sha256 verify, preview-then-confirm, `uses: 18-20px card radius` |
| **Repo Map** | Aider | `RepoMap` symbol map, filterable table, file details pane, `GET /api/projects/:id/repo-map` |

For each: `rg -n "placeholder|coming soon|not implemented|TODO.*panel"` + click every button in a live run (record which are stale/no-op — e.g. Folder Explorer `expand`). Propose new features: Notes WYSIWYG + tags + pin + version history, Reminders recurrence editing + snooze, File Tools batch rename, etc.

**Deliverable**: `audit/tools-parity.md` — per-panel parity score (UI 1–5, functionality 1–5, parity gaps, stale buttons file:line, new feature proposals ranked).

---

## 13. Phase 12 — Notifications Subsystem (Agents: 1x Explore + 1x General)

- Trace: `server/notify/` + `notifyChannels.js` (`sendDesktopNotification` PowerShell WinRT toast — needs `AppUserModelID` on Win11, may silently no-op; `sendWebhook` 8s abort + `isSafeExternalUrl` re-validate at send), `notifyEvents.js` (`dev-server-crash/schedule-find/task-done/collision-found/file-changed/file-added/folder-stale/reminder-fired`), `watchEngine.js`/`watchRules.js` (`data/watch-rules.json` chokidar, folder-stale sweep from scheduler tick), `connectionNotifyAdmin.js` pre-matcher, `NotificationsPanel.tsx` (currently a tool — **must become its own popup** when clicking the bell icon, not a panel).
- Repro: set an alarm/reminder (`remind me in 1 minute to test`), verify delivery to live session vs `data/schedule-log.md`, verify Windows toast appears (check `PowerShell` `BurntToast` vs `WinRT` fallback, notification center settings, focus assist). Capture `server.log` + `data/notification-history.json`.
- Spec: bell icon → `NotificationsPopup` (overlay, not `ToolsPanel`), `GET /api/notifications` badge count, mark-read, snooze, OS permission primer, fallback in-app banner when OS toast unavailable.
- Deliverable: `audit/notifications.md` — event→channel matrix, repro log (did toast appear? why not?), popup spec, harness rows needed.

---

## 14. Phase 13 — Zero-Error Sweep (Agents: 2x Explore very thorough)

- Full `rg -n "Error|throw|catch|fail|undefined|not defined|MAX_PORT_ATTEMPTS"` — re-check the fixed `desktop` crash (`MAX_PORT_ATTEMPTS` not defined) and `doctor` standalone bundling.
- Typecheck: `npm run lint` + `node --check` on every `server/*.js` + `--import tsx` leaves. Verify no `any` without justification, no unused import, no missing `await` on `serializePersistence`.
- Runtime guards: every `JSON.parse` has try/catch, every `fs.readFile` checks `ENOENT`, every `ws.send` checks `readyState`, every `spawn` handles `error`/`close`, every `fetch` has `AbortSignal` timeout.
- Stale-function scan: `rg -n "function \w+\("` vs `rg -n "\w+\("` usage — flag uncalled functions, unregistered intents (in `intentsData` but not `BUILTIN_INTENTS` — has killed intents 6+ times), intents in `BUILTIN_INTENTS` without a `check-handlers` row.
- Placeholder sweep: `rg -n "placeholder|Coming soon|later phases|not implemented|unwrap"` — every match must be tracked or removed.
- Deliverable: `audit/zero-errors.md` — error catalog (file:line, error class, user-visible message, fix), stale-function list, placeholder list, harness deltas needed (`check-handlers`/`check-matcher`/`check-ws-cases` rows).

---

## 15. Phase 14 — Synthesis & Gap Map (Agents: 1x General)

Consolidate `audit/preflight.md` + all phase `audit/*.md` + `audit/fuzz-results.ndjson` into a single `audit/GAP_MAP.md`:

- Executive summary (1 page): top 10 latency wins, top 10 UX gaps, top 10 correctness risks, top 5 customization holes.
- Full gap table: `ID | Area | Severity (P0/P1/P2) | File:line | Evidence (log/NN) | Current behavior | Desired behavior | Phase to fix | Harness to add`.
- Phased execution plan for the *implementation* prompt (stacked by dependency): Phase A latency, Phase B tour/liquid-glass/theme, Phase C notification routing + panel decoupling + recycle, Phase D auth/portal, Phase E installer/loading, Phase F docs+harness+build.
- Explicit "do not fix in research" list (deferred to execution).

---

## 16. Execution Harness & Verification (applies to every phase)

- Every phase must end with: `npm run lint`, relevant `check-*` (`check-matcher`, `check-handlers`, `check-tools`, `check-indexer`, `check-ws-cases`, `check-docs`, `check-intents`, `check-encoding`), and (where latency/behavior) a `%TEMP%` WS driver run with pass/fail counts.
- No phase is "done" without `file:line` citations for each gap and a replayable driver/log to re-verify.
- Cross-check heavily and repeatedly: re-run the driver after each phase's findings review; second agent re-reads the first's evidence and flags contradictions.

---

## 17. What Execution Must Do (when user says "execute")

- Work through `audit/GAP_MAP.md` phase by phase (A→F), small verifiable commits, `git status` clean between phases, `npm run lint` + all `check-*` green between phases, live WS smoke per phase.
- Integrate `liquid-glass-button.tsx` + `sonar-grid.tsx` as specified in Phase 9 (shadcn `src/components/ui/`, `cn` import, `liquidGlass` toggle, `SonarGrid` backgrounds).
- Fix: tab rescan race, semantic model lazy/worker load, port contention, CLI exe crash, notification toasts, AI thinking truncation, `general↔developer` chat noise → top strip, panel→REST decoupling, reminder/note recycle, `expand`/`quick start`/`deepthinking` dead buttons, notes bold WYSIWYG, folder explorer `open with` OS apps, hardcoded blue tokens, tour immersive spotlight, installer differential + cached model, loading sand canvas.
- **Before final push**: rewrite `README.md`, `features.md`, `CLAUDE.md` to current truth (no stale counts, no stale routes, no stale harness numbers — re-measure `intent`/`phrase`/`panel`/`endpoint` counts, re-list `TOOL_PANELS`, update `Known gotchas`).
- Then: `git add -A && git commit -m "feat: <phase summary>" && git push` + `npm run build` + `cd desktop && npm run dist` (or `dist:publish`) — verify `desktop/dist/Project Console Setup *.exe` boots from `resources` with no `vite` crash, toast appears, tour spotlights land, tab switch is instant, CLI `--help` works.

---

## 18. Reference — Images Provided

- Google Antigravity download page (black starfield with blue stardust parallax) — reference for loading-screen sand/starfield ambient.
- 21st.dev hero grid (search `?qt=hero` + `?qt=ai-chat`) — Codex metaball, `CURRENT` hatching, `Humanoid robots` hero — references for directional flow, glass, and card radii.
- The user also described a sand-blocks-merge-on-mouse-move effect (blocks drift like sand, colors blend blue/red/black/white as cursor moves). Implement as a lightweight canvas field (sonar-grid params: `spacing ~28`, `dotRadius ~1.4`, `baseOpacity ~0.22`, `ringWidth ~90`, `speed ~260`, tinted by the four palette stops, mouse attractor blending via `lerp` of block color).

---

*End of prompt. Research is exhaustive, phased, agent-parallel, evidence-driven, and leaves no stone unturned. Execute with patience; take as much time as needed.*
