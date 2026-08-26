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
