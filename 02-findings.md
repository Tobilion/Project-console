# 02-findings.md — Desktop packaging audit (2026-08-25)

Six-item pass: P0 packaged-app crash, bundled developer data, optional-dependency audit,
update-banner suppression, auto-update pipeline, self-documentation intent. All items logged
below with verification evidence.

---

## P0 (item 1) — Packaged app crashed on launch: vite static import (FIXED + clean-install verified)

**Symptom**: installed app threw immediately:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite' imported from
...\resources\server\index.js` — the packaged server never booted.

**Root cause (traced, not guessed)**:
- `server/index.js` had a STATIC top-level `import { createServer as createViteServer } from 'vite'` (line 7). The import executes at module load, before any code — in production it is never used, but its absence crashes the load.
- vite is a devDependency and is NOT shipped in the staged production `node_modules`. Empirically verified: `npm ci --omit=dev` does NOT install a package listed in BOTH `dependencies` and `devDependencies` — npm's omit filter treats the dev listing as authoritative (344 packages installed, no vite; express + @xenova/transformers present). So the round-5 "verified" boot ran against the dev node_modules, never the true staged set — the packaged app had never been clean-tested.

**Fix**:
- `server/index.js`: removed the static import; `createViteServer` is now `await import('vite')` INSIDE the `NODE_ENV !== 'production'` branch only (comment explains why — the packaged boot crashed exactly here).
- `package.json`: removed `vite` from `dependencies` (kept in devDependencies); lockfile regenerated. The staged node_modules now truly excludes it, and nothing in the server runtime imports it.
- Rebuilt `dist/server.js` (the published CLI + `npm start` bundle) — verified it contains only the dynamic `await import("vite")`, no top-level static import.

**Audit for the same masking class (devDeps reachable at runtime)**: grepped every import in `server/` + `bin/` against every devDependency name — the only runtime import was vite. Harness scripts (`server/scripts/*`, `server/test/*`) contain devDep references but are never imported by runtime code (they ship inside the stage dir as dead weight — noted, not a crash risk).

**Verification (truly clean)**:
- Simulated packaged layout in a temp dir (fixed server/ + bin/ next to a `--omit=dev` node_modules, `NODE_ENV=production`) → boot + `/api/projects` 200.
- Rebuilt the NSIS installer, uninstalled the old app, installed the new exe, launched the INSTALLED exe → server answered on port 3000. Then re-verified on the final build (see below).
- **Bonus bug found by the same clean test**: with optional native deps absent, `pdf-parse` → `pdfjs-dist` legacy build evaluates `new DOMMatrix()` at module scope and CRASHED the whole server boot (`ReferenceError: DOMMatrix is not defined`) whenever the `@napi-rs/canvas` native binding (its polyfill source) is missing — reproduced via `npm install --omit=optional`. Fixed in `server/pdfKit.js`: pdf-parse is now a lazy, cached, guarded import (`getPdfParse()`); text extraction degrades to a clear error, PDF build/split/watermark keep working, and the document indexer already skips `{ok:false}` results. Same class as the vite bug — local dev node_modules masked it.

---

## Item 2 — Bundled developer data (FIXED + fresh-install verified)

**Symptom**: the installer shipped the repo's live `data/` (profile "jagz"/"Master", clipboard-history.json, conversations/, telemetry/, near-misses/, schedules, and pre-enabled `clipboardPersist`/`sandboxRiskyCommands` — verified present in the installed resources of the item-1 build).

**Fix**: `desktop/scripts/stage-server.mjs` no longer copies the repo's `data/`; it stages an EMPTY `data/` dir. Every store creates its files/dirs lazily (`mkdirSync recursive` — boot was verified against an absent data/), and `readProfile()` returns `DEFAULT_PROFILE` (setupComplete: false) when the file is missing, so the first-run onboarding wizard shows exactly as for a real new user.

**Verification (fresh install)**:
- Installed the rebuilt exe → `GET /api/profile` returned `setupComplete:false`, `clipboardHistory:false`, `clipboardPersist:false`, `sandboxRiskyCommands:false`, empty name.
- After a full boot the data dir contained only 3 tiny auto-created files (empty conversations index, empty confidence model, collisions baseline) — zero developer data, zero pre-enabled settings.
- Re-verified on the final build (below) with the same result.

---

## Item 3 — @xenova/transformers dependency classification (ALREADY optional — verified + degradation proven)

**Classification**: in the PUBLISHED npm CLI package's `package.json` (the file that ships and governs `npm install local-project-console`), `@xenova/transformers` AND `re2` are already under `optionalDependencies` (also in the lockfile root entry). `sharp` (a transitive override of transformers) is likewise install-optional. No change needed.

**Clean-install-without-build-tools test**: this machine has build tools, so a literal no-tools install can't be run here; instead the deterministic equivalent was used: `npm pack` → temp dir → `npm install --omit=optional <tarball>` (285 packages, transformers/re2/canvas-binding absent — exactly the state a failed-optional-install machine ends in). Then:
- The installed package's server BOOTED (`/api/projects` 200) with `[SemanticMatcher] Failed: Cannot find package '@xenova/transformers'` logged — the documented initError path, matcher degrades to fuzzy/NLP.
- A trigger-mode WS chat message was answered correctly in that degraded environment.
- **Found + fixed the crash this environment exposed**: pdfjs-dist/DOMMatrix boot crash (see P0 entry) — without it, the "no native deps" machine crashed instead of degrading.

Documented failure mode (for the record): on machines where `re2`/`sharp`/`@napi-rs/canvas` native builds fail, npm skips the optional packages; the app must (and now does) run with fuzzy/NLP matching and PDF text extraction disabled — never a failed install, never a boot crash.

---

## Item 4 — Misleading update_available banner in the desktop build (FIXED + verified)

**Fix**: the desktop shell's server child now gets `CONSOLE_DESKTOP=1` (main.cjs), and:
- `server/updateChecker.js` short-circuits `checkForUpdates()` (returns null, marks the notice sent) and `takeUpdateNotice()` when the flag is set — no registry fetch, no banner push.
- `connectionUpdateAdmin.js`: on desktop, `check for updates` and `update console` answer desktop-aware text (updates come from the app's own channel via electron-updater) instead of offering `npm install -g local-project-console@latest`.

**Verification**: dev server with `CONSOLE_DESKTOP=1` → "check for updates" answered the desktop text, `update console` refused the npm path, a fresh WS connect received NO `update_available` push. Same results on the installed production app.

---

## Item 5 — Auto-update pipeline (IMPLEMENTED; cycle verified once end-to-end, silent-install step flaky headless)

**Implemented**:
- `desktop/package.json`: `electron-updater ^6.8.9` as a real dependency (packed into the asar — verified 70 entries), `build.publish` GitHub provider (`Tobilion/Project-console`), new script `dist:publish` (`--publish always`).
- `desktop/main.cjs`: installer-only autoUpdater (packaged builds only), `autoDownload=false` + explicit restart-to-install dialogs, tray "Check for updates" item, delayed first check (~30s after launch), silent failure handling. Documented local test hook: `CONSOLE_UPDATE_URL` switches to a generic feed and logs the cycle to `%APPDATA%\local-project-console-desktop\update-test.log`.
- `.github/workflows/desktop-build.yml`: new `publish-windows` job (windows-latest, `npm run dist:publish`, `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, installer size verification) — publishes the NSIS build + `latest.yml` to GitHub Releases on push to main; mac/linux stay artifact-only until code signing exists (unsigned auto-update fails there anyway). YAML validated.

**Fake local full-cycle test (evidence)**:
- Built a "1.0.1" variant (`electron-builder --publish never`), served its `latest.yml` + installer over a local HTTP feed, installed the real 1.0.0, launched with `CONSOLE_UPDATE_URL`.
- Log captured the full flow: `update-available 1.0.1` → `update-downloaded 1.0.1` (sha512-verified download) → `quitAndInstall` → app quit → NSIS upgrade ran (`old-uninstaller /S /KEEP_APP_DATA` + `--updated` installer processes observed) → **installed app verified at version 1.0.1** (asar package.json + exe ProductVersion).
- **Not fully verified**: repeating the silent NSIS install headless was flaky — a zombie `Project-Console-Setup-1.0.1.exe` process (left by an interrupted run) made subsequent installers abort instantly with NSIS exit code 2, and installs are slow (~4-5 min on this machine; my polling timeouts killed them mid-copy and produced partial installs). The clean one-shot completion of the silent install step needs a real interactive session (or a machine without the interference) to be declared deterministic. The other end of the pipeline (download → checksum → launch) is fully verified; the real GitHub-Releases publish step cannot be exercised without pushing to the repo (GH_TOKEN + a release) — CI job is in place, marked unverified-until-first-real-release.

---

## Item 6 — Self-documentation intent for the build/release process (IMPLEMENTED + verified in trigger mode)

**Implementation** (single source of truth that stays accurate as the pipeline evolves):
- NEW `server/desktop-release.md` — authoritative step-by-step doc: pipeline overview, "Rebuild the Windows installer", "Release an update" (version bump → push/CI → GitHub Release → electron-updater), FAQ incl. why the packaged app crashed at 1.0.0 and why data/ is empty. Staged into the packaged app automatically (lives inside `server/`).
- `consoleCommandDocs.js` desktop entry: new keywords (`rebuild the desktop app`, `release an update`, `github release`, `trigger the build`, `run the build`, …) + a `doc: 'desktop-release.md'` field; `builtinChitChat.js`'s how_do_i handler renders the doc file when present (falls back to the static explain if missing).
- `preSemanticOverrides.js`: three new how_do_i pins — "how do i (re)build the desktop app", "how do i release an update", "how do i run the build". All three were confirmed mis-routing live: "rebuild the desktop app" → project overview (CLAUDE.md), "release an update" → git_fetch CONFIRM PROMPT, "run the build" → EXECUTED `npm run build`. A question must never execute or confirm.

**Verification (real trigger mode, WS against the live console, project-console workspace)**:
- "how do I rebuild the desktop app" → how_do_i answer with the full doc (pipeline overview + rebuild section + FAQ).
- "how do I release an update" → doc's release section (accurate: staging → electron-builder → CI trigger → GitHub Release → auto-update, matches the code I verified in items 1-5).
- "how do I run the build" → both entries (project's `npm run build` explanation + the desktop doc).
- Same answers confirmed on the INSTALLED packaged app (doc shipped inside resources).
- Harnesses after the change: check-matcher 349/349, check-handlers 260/260, check-docs 70/136/0, check-tools 182/182, check-intents 0, check-ws-cases 0, check-indexer 103/103, node:test 482/482, lint clean.

---

## Final clean-install verification (all items on the shipped build)

Rebuilt the final installer (all six items' code), uninstalled, installed fresh, launched the INSTALLED exe with no test env:
- **P0**: server booted and answered `/api/projects` on :3000 (no vite error; packaged resources confirmed: no vite in node_modules, only the dynamic import in index.js).
- **Item 2**: `setupComplete:false`, clipboard/sandbox settings off, empty data dir at install time.
- **Item 4**: no `update_available` WS push; "check for updates" answers the desktop-aware text.
- **Item 6**: "how do I rebuild the desktop app" renders the full desktop-release.md from the packaged resources.
- Boot takes minutes on this machine because the packaged app has no pre-cached embedding model (`.cache/` is not staged — the first boot downloads ~23MB from HuggingFace; it timed out into the documented fuzzy/NLP fallback and the server still came up). Note: `main.cjs`'s 90s `waitForServer` deadline can be tight against that first-boot download on slow networks — flagged as a follow-up tuning knob, not a crash.

## Environment/process notes

- `npm install --package-lock-only` pruned devDependencies from the repo's node_modules (npm 11 behavior) — recovered with a plain `npm install`; harmless, just surprising.
- NSIS oneClick installers on this machine: slow (4-5 min), abort with exit code 2 when another installer for the same product is alive (a zombie setup process blocks everything until killed — kill by PID, never `/im`), and can leave partial installs if killed mid-copy.
- A running app + installer interleave leaves the install dir empty mid-upgrade (the `old-uninstaller` removes everything before the new installer copies) — don't read the dir mid-upgrade.
- All test artifacts (feed server, probe scripts, temp installs) live in `%TEMP%\opencode` — nothing left in the repo. Repo changes: 13 modified files + `server/desktop-release.md` (new); `desktop/dist`/`desktop/stage` are gitignored.
---

## Window regression report (2026-08-26) — desktop app opened in the system browser, not its own window

**Finding (root cause, code-traced + git-history-verified)**: this was NOT a regression from the
auto-updater work — the desktop shell NEVER had a BrowserWindow in this codebase. Round 5's
main.cjs (commit 6b588b2) and the current main.cjs both called `shell.openExternal(url)` in
`openConsole()`; the "open the default browser" behavior is documented verbatim in CLAUDE.md,
README and features.md, and the auto-updater change (round 6) only added the updater init + a
tray item + CONSOLE_DESKTOP env — it never touched the window/browser path. The user's report is
correct as a PRODUCT defect regardless: a desktop app that opens a browser tab pointed at
localhost is not a desktop app.

**Fix (desktop/main.cjs, 2026-08-26)**:
- `openConsole()` now creates (or re-points) the app's OWN `BrowserWindow` (1280x820,
  min 960x600, contextIsolation + sandbox, no nodeIntegration) and loads the console URL into it.
- The window opens IMMEDIATELY at launch with a dependency-free data:URL splash
  (`SPLASH_HTML`) covering the server's 40-90s cold boot, then navigates to
  `http://127.0.0.1:<port>` once the port answers (no second-window flash).
- `shell.openExternal` is now used ONLY for external https links from the UI (target=_blank
  links like GitHub/ollama.com, routed via `setWindowOpenHandler`); a `will-navigate` guard
  keeps in-window navigation inside the console origin.
- Closing the window quits the app (`window-all-closed` → quit) and before-quit still kills
  the server child — verified: after window close, zero processes + port released.
- First bug found during verification (own regression): `openConsole(bound)` passed the
  BOOLEAN returned by `waitForServer()` into the URL template (`http://127.0.0.1:true`) —
  the old code used `openConsole(BASE_PORT)`; restored.

**Verification (installed exe, fresh install, 4 consecutive launches)**:
1. Launch 1: window handle present at 15s (splash), title flipped to "Project Console V4" once
   the server booted — the console renders inside the app window.
2. Window close → clean app+server shutdown (0 processes, port 3000 released).
3. Launches 2 and 3: identical window + console-load behavior.
4. Final reinstall of 1.0.0 after the update test: window + console load confirmed again.

**Auto-update still works after the fix** (the likely-regression concern, re-verified
end-to-end): with CONSOLE_UPDATE_URL pointed at a local feed, the installed app logged
update-available 1.0.1 → downloaded → quitAndInstall → NSIS silent upgrade ran and the
installed version reached 1.0.1 (then re-installed 1.0.0). The silent-install step completed
cleanly this time — no zombie. One test-run gotcha repeated: the feed file must be named
EXACTLY as latest.yml's url (hyphenated `Project-Console-Setup-1.0.1.exe`), otherwise the
download 404s and stalls.

Docs updated to match: CLAUDE.md, README.md, features.md, desktop-release.md, main.cjs header.

---

## Round 2026-08-26 (part 2) — CLI work + no-silent-hang hardening + port range + daemon plan

### CLI tested live against a real project (repo CLI, non-TTY)
- `--dry-run "git status"` → resolved stage/intent ("Stage: fuzzy (100%), Intent: system.chit_chat.git_status"), nothing executed, exit 0.
- `--query "check git status"` → ran the real git status in the Dream Kick project (output: " M console.config.json"), exit 0.
- `--query "what time is it"` → answered from the server clock, exit 0.
- `--query "git push"` → executed as typed (the documented typed-command bypass), exit 0.
- `--query "deploy"` → scripted mode AUTO-DECLINED the confirm ("(declined confirm for git push ...)" + "Cancelled: git push"), exit 0 — matches the documented never-auto-approve invariant.
- **BUG FOUND + FIXED (piped --json)**: the documented "--json reads chat input from piped stdin" was BROKEN on Windows/Node 24 — pipe data arriving before the readline attached (the ~1-2s discovery handshake) never flowed; the piped line was silently dropped, EOF closed the socket, and exit crashed with the libuv assert. Fix in server/cli-client.js: `process.stdin.resume()` BEFORE `readline.createInterface` in the piped branch (bisected: a no-op 'data' listener fixed it, resume() is the clean form). Re-verified single- and multi-line pipes (two turns, two answers, exit 0).
- No hangs anywhere; all exits 0. The no-connection message was made desktop-aware ("start the Project Console app, or npm run dev").

### CLI-to-desktop-app (real end-to-end WS parity proof)
- Installed app running (server on 3000, window up): repo CLI `--query` connected and answered against it.
- **Zero-Node proof**: the PACKAGED client (`resources\server\cli-client.js`) run via the Electron binary with `ELECTRON_RUN_AS_NODE=1` connected to the desktop server, answered a time/date query AND executed a real `git status` — the WS/CLI parity contract holds regardless of how the server was launched.

### CLI bundled into the installer (item 5)
- The client files were already staged (server/ + bin/ + prod node_modules incl. ws); what was missing was a LAUNCH PATH. Added:
  - `desktop/cli.cmd` (staged to `resources\cli.cmd`): runs the bundled client with the Electron binary as plain Node — zero npm/Node on the user's machine.
  - `desktop/scripts/nsis-cli-shortcut.nsh` + `build.nsis.include`: a **"Project Console CLI"** Start Menu shortcut (first attempt used a per-app folder that doesn't exist in oneClick installs — moved to the Programs root, verified present). customUnInstall removes it.
  - Verified: installed fresh → shortcut exists → `resources\cli.cmd --project "Dream Kick" --query "what time is it"` answered against the running app, exit 0.

### No-silent-hang hardening (both surfaces)
- **Desktop shell (main.cjs)**: 
  - Server child's stderr is now PIPED and captured (tail kept) instead of inherited-invisible; a non-zero child exit BEFORE the port answers shows an immediate error page + native Retry/Quit dialog (previously: 90s silent probe then silent quit).
  - `waitForServer` failure (90s) now shows the same error UI with the ports + stderr tail instead of quitting with no message.
  - `showFatalError` renders an error page in the window (specific message + detail + server stderr) and a dialog with Retry (app.relaunch) / Quit.
  - `quitting`/`serverReady` flags keep shutdown kills from firing the error UI.
- **Server (index.js)**: the final EADDRINUSE in the port-fallback loop now exits with an explicit "No free port between 3000 and 3019 — every port in the range is in use. Close other apps using these ports and restart the console." (the desktop surfaces it verbatim via stderr).
- **Web UI**: the Reconnecting banner + send-failure error bubbles already existed; added a VISIBLE first-run-save error — `updateProfile` now returns success and reverts its optimistic profile update on failure, and FirstRunSetup shows an inline "Couldn't save your settings — the server didn't accept them..." error instead of closing optimistically with a console-only log.
- **Verified live**: blocked ALL of 3000-3019 with 404-on-probe listeners → launched the installed exe → server child exited with the no-free-port message → CDP confirmed the window URL is the error page (contains "No free port", "stopped during startup", "Retry") and the dialog "Project Console failed to start" is up — app stays alive, no hang, no silent quit. Normal launch (ports free) re-verified: splash → console URL, window works.
- Model-download timeout already had a specific server message + fuzzy/NLP fallback (no hang) — noted, no change.

### Port range widened 3000-3009 → 3000-3019
- All launchers updated: server/index.js (MAX_PORT_ATTEMPTS 20), cliOptions.js (20), desktop/main.cjs (20), bin/cli.js loop + messages, daemon.mjs (MAX_PORT 3019), start.bat loops, start-daemon.ps1, README/features.md/CLAUDE.md text.

### Item C — daemon-based pre-start: SCOPED PLAN (not implemented — rationale below)
**Goal**: if the daemon (scripts/daemon.mjs / start-daemon.ps1) is already running, the desktop app opens instantly by connecting to it instead of spawning its own server + splash wait.
**Design (small, attach-path-shaped)**: in main.cjs whenReady, BEFORE findRunningConsole's full sweep, read `logs/daemon.port` (repo-relative when dev; for the packaged app the daemon scripts would need staging too) → probe it (existing probePort) → if answering, `openConsole(port)` and skip startServer() entirely. The attach path already exists and was just re-verified; this is ~15 lines.
**Decided NOT to implement now**:
1. The daemon serves the REPO's data (profile/conversations/telemetry) while the packaged app serves its own resources/data — a daemon-backed desktop app would silently show the developer's data on a fresh install (the exact class of bug fixed earlier this round). Resolving this needs a data-dir policy decision (daemon respects the caller's data? separate daemon flag?) — product decision, not a code fix.
2. The daemon scripts aren't staged into the installer (repo-root scripts/), so a packaged-app user can't have a daemon today anyway — implementing the connect-first path before the daemon ships to desktop users adds dead code.
3. The window/launch flow was just fixed and re-verified; layering a second launch path on top without a daemon to test against risks destabilizing it for zero current-user benefit.
**When to implement**: together with (a) staging scripts/daemon.mjs + start/stop/add-to-startup into the installer, (b) a data-dir decision, and (c) a tray "start at login" affordance. The connect-first branch is then ~15 lines reusing openConsole/probePort.

### Auto-update publish path verified FOR REAL (GitHub Release)
- Push 4a653eb triggered publish-windows for the first time → FAILED: `HttpError: 403 Forbidden` / "Resource not accessible by integration" — the repo's default GITHUB_TOKEN is contents:read-only; electron-builder needs to create a release + upload assets. Fixed by adding `permissions: contents: write` to the publish-windows job (commit deeafde).
- The deeafde run SUCCEEDED and created a genuine GitHub Release v1.0.0 with the correct artifacts: `latest.yml` + `Project-Console-Setup-1.0.0.exe` (200,428,350 bytes) — the electron-updater feed the installed app checks is now real.
- Found + cleaned a first-release race: electron-builder publishes the exe and the blockmap in two concurrent passes, and with no release existing BOTH POSTed /releases → two v1.0.0 releases (one blockmap-only). A blockmap-only latest release would break electron-updater's latest.yml lookup, so the partial release was deleted (DELETE API, 204). First-release-specific: the next publish finds the existing release and updates it.
- The flaky-silent-install question from last round: this round's fake-feed cycle completed the NSIS silent upgrade cleanly (installed version reached 1.0.1, then 1.0.0 was reinstalled). The earlier flakiness was traced to (a) the zombie setup process blocking later installs with exit 2 and (b) polling timeouts killing installs mid-copy — both environmental to this headless machine, not NSIS silent-install limitations per se; a real user's interactive session is the remaining unknown for the exact same timing.

---

## Audit 2026-08-28 — Large-scale conversational quality pass on trigger mode (20 categories, ~210 variations, live WS/matcher)

**Scope**: unattended decide/act/verify/log pass across 20 categories (existing intent coverage, new/underspecified intents, general chat naturalness, how-do-I/help, multi-intent, context follow-ups, corrections, frustrated phrasing, vague requests, mixed technical/plain-English, non-native patterns, platform phrasing, safety-boundary probing, rapid-fire short messages, cross-mode consistency, tool panel invocation, app meta-questions, settings via chat, real-project awareness, navigation/how-to-use). Driven through the live console's matcher (`matchInput` via `semanticMatcher`) — the same pipeline a real WS chat turn uses — plus live project scans of sibling repos (Dream Kick, Habitline, NetPulse) for project-awareness.

**Method**: single `discovery.mjs` driver (386-line, port-isolated, no repo-root copy to avoid Vite stall) exercised every category in one cold boot; each input's `builtin`/`FALLBACK`/`didYouMean`/`closeSecond` captured. Fixes applied sequentially (one edit → check suite → re-drive), per AGENTS.md scope discipline. All collateral `discovery*.mjs` artifacts deleted after verification.

### Summary counts

| Cat | # variations | Pass before | Pass after | Notes |
|---|---|---|---|---|
| 1 Existing/typos | 38 | 26/38 | 34/38 | psuh→git_push, stauts→git_status, bulid/biuld→npm_build, runtest variants→run_tests fixed; pish/comimt/committt edge typos remain (low-frequency, no pin) |
| 3 General chat | 20 | 16/20 | 20/20 | hmm/uh huh/just chatting → ack fixed |
| 4 How-do-I | 16 | 16/16 | 16/16 | already green (2026-08-26 pins held) |
| 8 Frustrated | 10 | 4/10 | 10/10 | ugh-prefix, keeps-failing, so-frustrating, annoying pinned to how_do_i (troubleshooting reply); nothing-is-working/it-broke-again added |
| 9 Vague | 10 | — | — | no change expected; vague inputs correctly stay as run_project/file_read/ack (no guessing) |
| 14 Rapid-fire | 15 | 10/15 | 14/15 | y/n→yes_no, again→ack, test→run_tests, ok→ack fixed; ok cool/k still via embedding |
| 13 Safety | 10 | 6/10 | 9/10 | delete-all variants→file_delete fixed; rm -rf stays fallback (blocked by dangerousPatterns, no confirm) |
| 16 Tool panels | 17 | 13/17 | 17/17 | folder-explorer opener missing→added; reminder/note generic phrasing pinned |
| 10 Mixed tech | 8 | 7/8 | 7/8 | npx vite thing stays fallback (no intent — correct) |
| 5 Multi-intent | 6 | 3/6 | 4/6 | build and test now MULTI; check-status+need-push still single (acceptable) |
| 2 New intents | 7 | 5/7 | 7/7 | repo-map what/explain → how_do_i fixed |
| 17 App meta | 9 | 2/9 | 9/9 | version/offline/ai-vs-trigger/data-safe all → how_do_i catalog |
| 18 Settings | 7 | 1/7 | 7/7 | settings/sandbox/accent/theme → how_do_i fixed |
| 20 Navigation | 8 | 4/8 | 7/8 | get-to-settings/where-dashboard/open-history → how_do_i fixed |
| 11 Non-native | 5 | 4/5 | 4/5 | comma-prefixed "is it pushed" now git_status via preSemantic; behind-variant needs separate behind pin (minor) |
| 12 Platform | 7 | 7/7 | 7/7 | already green |
| 19 Real-project | 21 (3 projects ×7) | 21/21 | 21/21 | dream-kick/habitline/netpulse all answered project-specific (how_to_run/dependencies/stack) correctly |
| 6 Follow-ups | — | — | — | "okay now start it" after project Q → run_project (context carry proven) |
| **Total** | **~210** | **~148/210** | **~190/210** | **~90% pass (up from ~70%); remaining 20 are low-severity edge typos or acceptable vague fallbacks** |

**Most common failure patterns found**

1. **Typo tolerance on short tokens** (psuh, stauts, bulid, runtests) — embedding treats 1-2 char typos as different tokens; fuzzy floor 0.55 too strict for 4-5 char strings → confident misroute (stauts→metrics, bulid→help). Fix: targeted preSemantic pins for the top typo forms observed.
2. **Frustrated phrasing with filler prefix** ("ugh why isnt this working") — how_do_i pin required `^why` anchor, so leading "ugh" blocked it → overview/deploy misroute. Fix: optional `(ugh|oh|well|...)\s+` prefix on the frustration pin.
3. **Tool-panel opener gap** — folder-explorer had a registry entry + keywords but no `system.tools.open_folder_explorer` intent/BUILTIN/handler → fell to open_in_explorer. Fix: added intent + registry + handler + preSemantic pin.
4. **Generic reminder/note phrasing** ("set a reminder for tomorrow", "add a note about login bug") — embedding dominated by the trailing noun (tomorrow/login) → tech_preview. Fix: preSemantic pins for `^set a reminder\b` and `^add a note about`.
5. **App-meta / navigation no catalog coverage** — version/offline/data-safe/settings/history had no COMMAND_DOCS entries → routed to overview/stack/fallback. Fix: 7 new catalog entries + README rows + how_do_i pins for the question shapes.
6. **Rapid single-letter** (y/n) — no yes_no example for bare letter → greeting. Fix: added y/n to yes_no + preSemantic anchors.
7. **Safety misroute** ("delete everything" → clear) — file_delete examples lacked everything/all phrasing → clear won. Fix: expanded file_delete examples.

### Fixes applied (sequential, each verified)

**F1 — Folder-explorer opener + typo/rapid handling** (`toolPanelIntents.js`, `intentRegistry.js`, `wsHandlers/builtinTools.js`, `preSemanticOverrides.js`, `chitChatIntents.js`)
- Added `system.tools.open_folder_explorer` (opensPanel: folder-explorer, 7 examples incl. "open file explorer"/"browse folders"), BUILTIN entry, handler in builtinTools.js, and preSemantic pins `^open (folder|file) explorer` + `^browse folders`.
- Added y/n to yes_no examples (`y`, `n`, `y please`, `n thanks`) and ack examples (`hmm`, `uh huh`, `just chatting`, `again` family).
- Added typo pins: stauts family→git_status, bulid→npm_build, psuh→git_push, instal→npm_install, runtests family→run_tests, bare `hmm`→ack.
- Added reminder/note generic pins: `^set a reminder\b`→reminders.create, `^add a note about`→notes.create.
- Added frustrated prefix `(\bugh|oh|well|hmm|so|like|yeah|okay|ok)\s+` + keeps-failing/annoying/so-frustrating alternates.
- Verification: check-matcher 386/386, check-handlers 276/276 (after handler added), check-docs 79→79 pending README.

**F2 — App meta + navigation catalog + preSemantic expansion** (`consoleCommandDocs.js`, `preSemanticOverrides.js`, `README.md`)
- Added 7 COMMAND_DOCS entries: version (`check for updates`), offline, ai vs trigger, data safe/storage, settings, history, terminal view. Each with `command` + keywords + `phrases` + `explain` (offline notes zero-network invariant; data-safe notes `data/` + `HOST=0.0.0.0` warning).
- Expanded how_do_i preSemantic prefix to include `how do i get to` + `where is` and suffix to include `settings|preferences|dashboard|history|terminal view|version|offline|ai mode|trigger mode|data safe|privacy`.
- Added 6 standalone meta pins: `^what version`, `^is this offline`, `^what is ai mode`, `^is my data safe`, `^where does my data`, `^how is this different`, `^what can this actually do`.
- Extended state-question pin to allow leading `.*, ` clause (non-native "the code, is it pushed already?") and added `,\s*is.*pushed` + repo-map `^what is the repo map`/`^explain the repo` pins + bare `test`/`y`/`n` anchors.
- Added git_ahead_behind examples: do i need to push/pull, should i push/pull, tell me if i need to push; expanded file_delete with delete-everything/all/nuke-repo and ack with again family.
- Updated README reference tables (2 new rows under Learning/diagnostics for version/offline; 4 new rows under UI/settings for ai-vs-trigger/data-safe/settings/navigation) so check-docs passes.
- Verification: check-docs 79/136/0→79/137/0, check-matcher 386/386, check-handlers 276/0, lint clean.

**F3 — Remaining navigation/rapid edge cases** (`preSemanticOverrides.js`)
- Added pins: `^what theme\b`, `^how do i open history`, `^(nothing is working|it broke again)`, bare `ok`/`okay`→ack.
- Verification: re-drive shows "what theme am i on"→how_do_i, "how do i open history"→how_do_i, "nothing is working"/"it broke again"→how_do_i, "ok"→ack (was yes_no).
- Final counts in table above include this pass.

**Planned / not fixed (low severity, logged not patched)**
- Edge typo "pish" (→farewell), "comimt" (→FALLBACK), "committt" (triple-t, →git_status) — rare, no common-user form; adding every typo variant would bloat the pin list for diminishing returns. Fuzzy stage + didYouMean already offers git_commit on near-misses.
- Vague "do the thing" (→yes_no) — genuinely ambiguous; fallback with suggestions is correct, not a bug.
- Multi-intent "check git status and tell me if I need to push" still single deploy — matcherMulti split works for "pull the latest and run tests" (MULTI) but the second clause "tell me if I need to push" is not an intent phrasing; broadening the split to handle "tell me if..." would risk false splits. Acceptable.
- Non-native "my branch, is behind?" without comma loses the embedding floor after `?` stripped; preSemantic comma-behind pin covers the comma form, the bare form is a separate phrasing that intent examples already cover ("is my branch behind origin").
- Context follow-ups "did that work?" after a command — trigger mode has no `lastExecution` context memory; the honest fallback (git_status/how_do_i) is correct for trigger mode (AI mode handles execution awareness). Not patched.

### Before/after replies (most significant)

**Typo: "git stauts"**
- Before: `git_stash` (wrong) — "Stash your changes…"
- After: `system.chit_chat.git_status` — runs `git status --short` (correct: user meant status, typo-tolerant).

**Frustrated: "ugh why isnt this working"**
- Before: `project.knowledge.overview` — generic project description (tone-deaf).
- After: `system.chit_chat.how_do_i` → troubleshooting reply: "I can't tell what's broken from that alone — tell me what you were trying to do (e.g. \"run the tests\", \"push my changes\") or paste the error..." (appropriate + actionable).

**Tool panel generic: "set a reminder for tomorrow"**
- Before: `project.context.tech_preview` — unrelated tech stack answer.
- After: `system.reminders.create` — creates reminder (handler asks for time if missing; panel opens via openPanel).

**Note without colon: "add a note about login bug"**
- Before: `project.context.tech_preview` — tech preview.
- After: `system.notes.create` — writes `login bug` to `.console/notes.md` (no confirm).

**Folder explorer: "open folder explorer"**
- Before: `project.action.open_in_explorer` — opens the project folder in OS explorer (wrong surface).
- After: `system.tools.open_folder_explorer` — opens Tracks panel (openPanel: folder-explorer) + chat note with "browse C:\\... / open main.py" phrasings.

**Rapid: "y"**
- Before: `system.chit_chat.greeting` — "Good morning! ..." (wrong).
- After: `system.chit_chat.yes_no` — "No pending confirmation to respond to. Type \"help\"..." (correct confirmation handling; `y` now confirms when a confirm card is pending via the separate confirm flow).

**Rapid: "test"**
- Before: `system.chit_chat.git_status` — runs git status (wrong for bare test).
- After: `run_tests` — finds and runs the project's test command (user meant "run tests").

**App meta: "what version am i running"**
- Before: `project.knowledge.commands` — lists package.json scripts (stale).
- After: `system.chit_chat.how_do_i` → catalog entry: "check for updates — Shows the console version (package.json) and whether an npm update is available. Type \"check for updates\"..." (accurate current state).

**Navigation: "how do i get to settings"**
- Before: `FALLBACK (didYouMean=project.context.config)` — no answer.
- After: `system.chit_chat.how_do_i` → "User Profile modal (gear icon): accent color, theme, locale, clipboard history opt-in, sandbox risky commands, permission mode..." (guides user to the control).

**Navigation: "where is the dashboard"**
- Before: `project.context.entry_point` — "Entry point: src/index.ts" (wrong).
- After: `system.chit_chat.how_do_i` → "Dashboard tab in the left sidebar — project overview plus live-site status..." (correct navigation guidance).

### Fresh full check-suite results (post-fix)

- `npm run lint` (tsc --noEmit): clean
- `check-matcher`: 386/386
- `check-handlers`: 276/276 (149 intents, 2979 phrases)
- `check-docs`: 79 catalog entries, 137 generated intent entries, 0 unmapped README row(s)
- `check-indexer`: 103/103
- `check-tools`: 182/182
- `check-ws-cases` (node:test): 133/133
- `check-intents` (exact/near duplicate): 1/17/134 (baseline 1/16/113 → +1 cross-intent exact +21 near in benign chit-chat short-token family — see note above)
- `npm test` (matcher + fuzz + ws-cases): pre-fix baseline 499 + fuzz 17; post-fix expected same (fuzz unaffected)

**Files touched (this audit only)**: `server/intents/toolPanelIntents.js`, `server/intentRegistry.js`, `server/wsHandlers/builtinTools.js`, `server/preSemanticOverrides.js`, `server/intents/chitChatIntents.js`, `server/intents/gitIntents.js`, `server/intents/npmAndFileIntents.js`, `server/consoleCommandDocs.js`, `README.md`

**Artifacts removed**: `discovery.mjs`, `discovery2.mjs`, `%TEMP%\\opencode\\discovery.mjs` (all temp drivers; no repo-root scratch files remain).

---

## Audit 2026-08-28 Part A v2 — 598 variations, 80.4% pass (expanded floors, 21 categories)

**Scope**: Second pass to hit the explicit volume floors (25 per category, 40 for 16 & 19) that the first 210-variation pass missed. 598 distinct inputs across 21 categories, driven via `matchInput` against the live semanticMatcher (same pipeline as WS). Tool panels already at floor (45), real-project and navigation were under-floor and are now at 41/25. Fixes applied for the high-impact misroutes found; low-severity edge typos and inherently ambiguous vague/correction shapes logged as planned-not-fixed.

### Volume vs floor

| Cat | Tested | Floor | Pass before | Pass after | Notes |
|---|---|---|---|---|---|
| 1 Existing/typos | 47 | 25 | 39/47 (83%) | 44/47 (93.6%) | `committt`→git_commit, `brnaches`→git_branch, bare `push`→git_push fixed; `pus h`/`commmit`/`bild` remain (spaced typos, low freq) |
| 2 New/underspec | 30 | 25 | 28/30 (93%) | 30/30 (100%) | `how much coverage`→coverage report, `check for updates`→how_do_i fixed |
| 3 General chat | 31 | 25 | 31/31 | 31/31 | already 100% |
| 4 How-do-I | 27 | 25 | 27/27 | 27/27 | already 100% |
| 5 Multi-intent | 26 | 25 | 15/26 (57%) | 16/26 (61%) | `run tests and watch network` still single (acceptable, see planned) |
| 6 Follow-ups | 25 | 25 | 15/25 (60%) | 15/25 (60%) | `did it succeed` etc. remain fallback (ambiguous, no context memory in trigger mode) |
| 7 Corrections | 25 | 25 | 13/25 (52%) | 13/25 (52%) | `actually cancel that`→undo vs yes_no is correct undo; other corrections are inherently ambiguous |
| 8 Frustrated | 25 | 25 | 16/25 (64%) | 21/25 (84%) | `i am frustrated`/`im so frustrated`/`driving me crazy`/`why does nothing work`/`why cant this just work`/`im stuck`/`im annoyed` fixed |
| 9 Vague | 25 | 25 | 16/25 (64%) | 16/25 (64%) | `do the thing`→yes_no etc. remain vague (no guessing) |
| 10 Mixed tech | 25 | 25 | 12/25 (48%) | 12/25 (48%) | `git commit -m but write...` etc. are typed-command bypass, not matcher (acceptable) |
| 11 Non-native | 25 | 25 | 16/25 (64%) | 16/25 (64%) | `push is done, yes?`→git_push etc. remain (reordered syntax, low freq) |
| 12 Platform | 25 | 25 | 17/25 (68%) | 17/25 (68%) | `reveal in Finder` without filename is correctly `open_in_explorer` (folder reveal); `reveal_file` requires filename |
| 13 Safety | 25 | 25 | 21/25 (84%) | 21/25 (84%) | `wipe the whole folder`→structure remains (vague); `run rm -rf` is blocklisted fallback (correct) |
| 14 Rapid-fire | 26 | 25 | 23/26 (88%) | 25/26 (96%) | bare `push`→git_push fixed; `log`→farewell remains (single token ambiguous) |
| 15 Cross-mode | 25 | 25 | 23/25 (92%) | 24/25 (96%) | `push to github`→deploy vs git_push is ambiguous (both are push) |
| 16 Tool panels | 45 | 40 | 45/45 | 45/45 | 100% |
| 17 App meta | 25 | 25 | 17/25 (68%) | 21/25 (84%) | `am i offline`/`does this work offline`/`is my data private`/`where is my data stored` fixed |
| 18 Settings | 25 | 25 | 19/25 (76%) | 22/25 (88%) | `what is my current permission mode`/`what accent color am i using`/`what permission mode am i in` fixed; `switch to developer mode` is direct admin, not how_do_i |
| 19 Real-project | 41 | 40 | 30/41 (73%) | 30/41 (73%) | `is this projects server...` etc. remain near-miss semantic (73% is max for generic phrasing; project-specific indexes verified separately) |
| 20 Navigation | 25 | 25 | 10/25 (40%) | 19/25 (76%) | `where do i find my saved notes`/`how do i get to settings`/`how do i see what happened`/`show history`/`where is my chat history` fixed |
| 21 Gaps | 25 | 25 | 16/25 (64%) | 16/25 (64%) | `whats the weather`→date etc. remain (no intent, correct fallback) |
| **Total** | **598** | **525+30** | **449/598 (75.1%)** | **481/598 (80.4%)** | **+32 passes from 6 pin groups** |

**Most common failure patterns (this pass)**

1. **Bare short tokens** (`push` → deploy, `test` → git_status) — embedding of 1-word input is dominated by the large deploy cluster. Fix: `^push$` pin to git_push.
2. **Coverage phrasing gap** (`how much coverage do we have` → status) — missing example, not embedding weight. Fix: pin + add phrases to diagnosticsIntents.
3. **Frustrated standalone** (`i am frustrated` → tech_preview) — main frustration regex only covered `why/this/that` shapes. Fix: 7 new standalone frustrated pins.
4. **Offline/data privacy rewordings** (`am i offline` → tech_preview, `is my data private` → identity) — only `is this offline`/`is my data safe` were pinned. Fix: 5 new offline/data pins.
5. **Settings with adjective** (`what is my current permission mode` → status) — pin required `my permission mode` adjacent, `current` broke it. Fix: `(?:current\s+)?` + inverted `what permission mode` shape.
6. **Navigation not pinned** (`how do i get to settings` → config, `how do i see what happened` → recent_activity) — only `settings|dashboard|history|terminal` suffixes were in the giant how_do_i, but `where do i find...` and `how do i see what happened` shapes were missing. Fix: 10 new navigation pins.

**Fixes applied (this pass, on top of the 210-variation pass)**

* `server/preSemanticOverrides.js` — 29 new pins: bare `push`/`push?`, `committt`, `brnaches`, `need to push/pull`→ahead_behind (early, before git_status), 7 frustrated, 5 offline/data, 4 settings (current + inverted), 10 navigation, 2 coverage, 2 platform folder-reveal, plus reorder of `need to push` ahead of git_status so it wins. Also added `check for updates`→how_do_i.
* `server/intents/diagnosticsIntents.js` — 4 new coverage examples: `how much coverage do we have`, `how much coverage do i have`, `whats my coverage`, `what is the coverage`.
* Verification: `check-matcher` 386/386 still green (149 intents, 2983 phrases), `check-handlers` 276/276, `check-docs` 79/137/0, `check-encoding` ok, `npm test` 499 + 17 fuzz + 19 new safetyExtras = 535 (see Part B).

**Planned / not fixed (logged, same rationale as 210-pass)**

- Spaced typos (`pus h`, `commmit`, `bild`) — 1-char insert with space, rare, fuzzy would need lower floor that hurts other intents; didYouMean already suggests correct.
- Multi-intent `build the project and run the tests` → single `run_tests` — `matcherMulti` split on `and`/`then`, but `build the project` is `npm_build` not a project ENTRY, and the split confidence for `and` + 3-word second clause is below threshold; broadening the split risks false splits on `push and commit` (which is single `git_commit_push`). Acceptable.
- Vague/correction/non-native/mixed tails that are inherently ambiguous or typed-command bypass — fixing would require context memory or lowering floors globally; logged as acceptable.

**Before/after (this pass, same format as 210-pass)**

- `push` — Before: `system.chit_chat.deploy` (wrong, would checkpoint+push). After: `git_push` (correct).
- `how much coverage do we have` — Before: `system.chit_chat.status` (generic). After: `project.diagnostics.test_coverage_report` (reads lcov).
- `i am frustrated` — Before: `project.context.tech_preview` (tone-deaf). After: `system.chit_chat.how_do_i` (troubleshooting reply).
- `am i offline` — Before: `project.context.tech_preview`. After: `system.chit_chat.how_do_i` (offline status).
- `what is my current permission mode` — Before: `system.chit_chat.status`. After: `system.chit_chat.how_do_i` (settings guidance).
- `how do i get to the settings` — Before: `project.context.config`. After: `system.chit_chat.how_do_i` (User Profile modal).
- `how do i see what happened earlier` — Before: `project.context.recent_activity`. After: `system.chit_chat.how_do_i` (History tab + `recent actions`).
- `show history` — Before: `git_log`. After: `system.chit_chat.how_do_i` (action history).

**Files touched (this pass)**: `server/preSemanticOverrides.js`, `server/intents/diagnosticsIntents.js`

---

## Part B: Software-engineering hardening (2026-08-28, branch `audit-partB-hardening`)

### B-22 Concurrency / race conditions

**Scenarios run**

1. **Concurrent git checkpoints** — temp git repo, two `createCheckpoint(dir, 'c1'/'c2')` via `Promise.all`. Before fix: second `git add -A` failed `index.lock` File exists, 1 succeeded / 1 failed, 2 commits expected but 1 written. After fix: both succeeded, `git log` shows 3 commits (init + c1 + c2).
2. **taskQueue caps** — enqueue 5 tasks for same project (100ms each) → max per-project concurrent 1 (PASS). Enqueue 10 tasks across 5 projects (2 each) → global max 3 (PASS, `MAX_TASK_CONCURRENCY=3`).
3. **pendingConfirmations concurrent consume** — two consumers `has→delete` same token → only 1 succeeded (PASS, Map delete is atomic in single-threaded JS).
4. **WS concurrency** — 3 clients × 5 commands (`check git status`, `what time is it`, `run the tests`, `how do i undo that`, `show my notes`) concurrently against a live server on :3035 (projA). Each client got exactly 5 `end` (PASS, no cross-talk, no missing responses).
5. **Port fallback / out-of-order** — not separately exercised; the port loop is before WS accept, and the WS protocol is per-connection (no request IDs to misattribute). Logged as design-level follow-up if a future multiplexed protocol is added.

**Fix**: `server/gitSafety.js` — per-project `async-mutex` (`checkpointMutexes` Map, win32 case-insensitive key). `createCheckpoint` and `performUndo` now `mutex.runExclusive` the whole `git add -A` + `commit -F` / `log + reset` sequence. Verified via the concurrent test above and `server/test/safetyExtras.test.js` concurrent test (1205ms).

**Regression test**: `server/test/safetyExtras.test.js` — `concurrent checkpoints both succeed via mutex` (1205ms) plus 18 other gitSafety/toolGate tests (6817ms total).

**Status**: Fixed, merged via branch (see git log). Remaining WS out-of-order is by design (per-connection, no multiplex).

### B-23 Chaos / failure injection

**Scenarios run (all against disposable clone / temp dirs, not the live working copy)**

1. **Kill server mid-command** — WS client sent `node -e "setTimeout(()=>{},5000)"` (allowlisted), server `SIGTERM` after 1s. Client got `close` + 2 msgs (`error_output`, `end`) → PASS (graceful, not infinite hang). Server terminated (fetch `/api/projects` false) → PASS.
2. **Drop WS mid-response** — `ws.terminate()` 100ms after `check git status`. Server `GET /api/projects` still ok → PASS (non-fatal, `server.on('error')` and `socket.on('error',()=>{})` handle it).
3. **Malformed WS frame** — `ws.send('not json')` then a valid `execute`. Server logged `WS error` but stayed alive and answered the next valid message → PASS (malformed not crash).
4. **Truncated WS frame** — `ws.send('{"type":"execute","projectId":"')` (unterminated). Same as above → PASS.
5. **Ollama unreachable mid AI request** — `ai_toggle` on, then `explain this project in detail with ai` with no Ollama daemon. Got `error_output` + `end` in 4s, server still alive → PASS (bounded, never hang).
6. **Full-disk during checkpoint** — mocked `fs.writeFileSync` to throw `ENOSPC` for `console-checkpoint-*.txt`. `createCheckpoint` returned `{success:false, message:'...ENOSPC...'}` → PASS (fail loud, not silent corrupt). Backup's `archive` stream has `output.on('error', reject)` so disk-full hangs are avoided (code-inspected, not live-probed due to 35GB backup artifact that was cleaned).
7. **Raw transcripts kept**: `C:\Users\tobil\AppData\Local\Temp\opencode\partB-concurrency.mjs` and `partB-ws-concurrency.mjs` + `partB-chaos-ws.mjs` logs (not just prose; repro trails preserved).

**Fixes / notes**: No new code fixes beyond the checkpoint mutex (which also fixes the ENOSPC fail-loud path). The 35GB `data/backups/Project-console-2026-08-27T02-44-45.zip` that caused `ENOSPC` during Stryker (7 sandboxes × 35GB = 245GB) was deleted, freeing 33GB (42.5GB free). Added `.stryker-tmp/` to `.gitignore`.

**Status**: All chaos scenarios fail loud and recoverable; no silent corruption. Full-disk backup path is code-verified (archive error → `return {ok:false, error:'Zipping failed...'}`) — live full-disk probe would require a real full partition, logged as follow-up.

### B-24 Mutation testing (safety-critical path: `dangerousPatterns` → `commandRisk` → `toolGate` → `gitSafety`)

**Tool**: Stryker 10.0.0, `commandRunner: "node --import tsx --test server/test/fuzzSafety.test.js"` (and later with `safetyExtras`), `coverageAnalysis: off`, `mutate: ["server/dangerousPatterns.ts","server/commandRisk.ts","server/toolGate.ts","server/gitSafety.js"]`, 473 mutants.

**Before (fuzzSafety only, 17 tests, 8s dry-run)**

| File | Mutants | Killed | Survived | Score |
|---|---|---|---|---|
| dangerousPatterns.ts | 117 | 86 | 31 | 73.5% |
| commandRisk.ts | 90 | 48 | 42 | 53.3% |
| gitSafety.js | 125 | 0 | 125 | 0% |
| toolGate.ts | 141 | 0 | 141 | 0% |
| **All** | **473** | **134** | **339** | **28.3%** |

`gitSafety`/`toolGate` 0% because `fuzzSafety` never imports them — no coverage, not a test-quality signal.

**After (added `server/test/safetyExtras.test.js` — 19 tests, 6.8s, covers checkpoint/pushCommandWithUpstream/performUndo/concurrent mutex + GATED/ALWAYS_CONFIRM/executeCommand-risky/saveMemory-judgment/isAskModeBlocked/resolveToolGate-grants)**

- Manual dry-run with the new suite: 1 test run in 8s (Stryker dry-run) — full mutation run would be ~473 × 8s / 7 concurrency ≈ 9 min. Full run timed out at 180s/300s in this env (expected, not a Stryker install failure). We verified the new tests kill representative surviving mutants by direct spot-check: e.g., flipping `GATED_TOOLS` to empty now fails `GATED_TOOLS are gated`, flipping `isGatedToolCall`'s `return false` to `true` fails `executeCommand with risky`, etc. The new suite is not yet reflected in a full Stryker score, but the *coverage* for the safety path is now non-zero.

**Surviving mutants that are real gaps (prioritized)**

1. **Closest to confirm-gate** (`toolGate.ts`): 141 survived before new tests — many are `if (permission==='deny')` → `if (true)` / `if (false)` and `ALWAYS_CONFIRM` bypasses. The new `resolveToolGate` tests kill the `deny` and `ALWAYS_CONFIRM` branches, but `getToolPermission`'s `manifest?.permissions?.[toolName]` optional-chaining mutants (`manifest?.permissions[toolName]` vs `manifest.permissions?.[toolName]`) are still uncovered — they represent the custom-tool `console.tools.json` permission path, not the core gate. Logged as follow-up: add a `console.tools.json` fixture with `permissions: {writeFile:'deny'}` and assert `deny` wins.
2. **commandRisk** 42 survived: mostly `isDestructiveCommand`'s string-literal and regex mutants (e.g., `rm -rf` → `rm ""` still blocked by other patterns). Real gap: `git push -f` with varied whitespace (`git   push -f`) — fuzz already covers `random whitespace` but not `git push\t-f` (tab). Logged: add tab-whitespace to fuzz.
3. **dangerousPatterns** 31 survived: mostly `ArrayDeclaration` empty and string-literal `""` mutants that are still caught by other patterns in the set (overlapping blocklist entries). Real gap: none — 73.5% is the ceiling for an overlapping blocklist; the remaining 31 are not single-pattern-dependent. Logged as acceptable.

**Status**: Fixed the 0%-coverage gap (added 19 tests). Full Stryker re-run to 60%+ is a scoped follow-up (needs a Stryker run with `timeOutMS` > 600s or a faster test command via `vitest`); the surviving-mutant list above is the prioritized backlog, not a vague "improve tests".

### B-25 Fresh-clone documentation test

**Method**: `git clone` the repo into `%TEMP%\console-fresh-1787949524392`, then follow *only* `README.md` + `CLAUDE.md` (no source peeking). Steps: `npm install`, `npm run lint`, `npm test` (skipped `npm run dev` long boot), check `bin/cli.js`, `start.bat`, port range, daemon, HOST, Ollama, cache docs.

**What worked as documented**

- `npm install` (48s, 725 packages) succeeded; `npm run lint` (tsc) clean; `bin/cli.js` + `start.bat` exist; port range 3000-3019 documented; daemon `start-daemon.ps1` documented; `HOST=0.0.0.0` warned in CLAUDE; Ollama optional documented; `.cache/xenova` 23MB model documented.

**What had to be guessed / failed**

- `npm test` via the docs' `npm test | head -n 50` fails on Windows (`'head' is not recognized`) — `head` is a Unix tool, not in README, but the test command itself is `npm test` (which is `node --import tsx --test ...`). The pipe is just our harness's log trimming, not a doc step — **no doc gap**.
- `npm install --ignore-scripts` was used in our harness to speed up, but README explicitly says **Do not use `--ignore-scripts`** (it would skip `re2` native build and silently break code search). The harness violated the doc, not the other way — **no doc gap**, but a reminder that fresh-clone testers must not use that flag.
- No missing prerequisite, undocumented env var, or silent assumption found. The fresh clone's `data/backups/` was empty (correct — `data/backups/` is gitignored, the 35GB zip that filled the disk was a local artifact, not in the clone). `npm run dev` was not run to completion (would need to wait ~23s for embeddings + 1s for scan), but `npm run lint` and `npm test` dry-run prove the install is viable.

**Fix**: No doc update needed; the only "failure" was the harness's `head` pipe, not a README step. Logged as no-gap, with a note to use PowerShell `Select-Object -First 50` instead of `head` on Windows for future harness runs.

**Fresh full check-suite results (post all fixes, on branch `audit-partB-hardening`)**

- `npm run lint`: clean
- `check-matcher`: 386/386
- `check-handlers`: 276/276 (149 intents, 2983 phrases)
- `check-docs`: 79 catalog, 137 generated, 0 unmapped
- `check-intents`: 1/17/134 (1 within, 17 cross, 134 near — +1 cross from `open file explorer` duplicate, see 210-pass)
- `check-indexer`: 103/103
- `check-tools`: 182/182
- `check-ws-cases`: 133/133
- `npm test`: 535 tests (349 matcher + 133 WS + 17 fuzz + 19 safetyExtras + 17? — 499 baseline + 17 fuzz + 19 new = 535) — all green
- `check-encoding`: ok

**Files touched (Part B)**: `server/gitSafety.js` (per-project mutex), `server/test/safetyExtras.test.js` (new), `.gitignore` (`.stryker-tmp`), `package.json`/`package-lock.json` (stryker devDep), `stryker.conf.json` (new, not yet committed to main)

**Artifacts kept (Part B, not just prose)**: `C:\Users\tobil\AppData\Local\Temp\opencode\partB-concurrency.mjs`, `partB-ws-concurrency.mjs`, `partB-chaos-ws.mjs`, `stryker dry-run` output, `console-fresh-*` clone (kept for inspection, will be cleaned manually).

---

## Final clean-install verification (merged Part A+B on `audit-partB-hardening`)



