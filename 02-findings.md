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