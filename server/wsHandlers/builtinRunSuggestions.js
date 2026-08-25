import { state } from '../state.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { findDocumentedRunCommands } from '../readmeRunParser.js';
import { getCommandDir } from '../commandDir.js';
import { hasInstalledCli } from '../capabilityProbe.js';

/**
 * Confirmed live 2026-07-30 (Matchday Exchange transcript): "run its server" and "run .bat" both
 * ran the generic `npm run dev` (spawning a second, then third, redundant Vite instance on
 * 3002/3003) instead of the project's actual `npm run server` wallet/settlement backend script —
 * even though a differently-phrased "Is its server running?" correctly found and ran that exact
 * script. Root cause: `run_project`'s handler always defaulted straight to scripts.dev/start/serve
 * without ever looking at what the user's own input said, unlike `npm_run`'s handler (which tries,
 * but only when a script name immediately follows "run"/"execute" — "run its server" fails that
 * too, since "its" is what immediately follows "run"). This checks every real script name in the
 * project's own package.json against the input as a whole word, so "its server", "is the server
 * running", "start the server process" etc. all find `server` regardless of exactly where the
 * word falls in the sentence — a looser, more forgiving match than npm_run's strict regex,
 * intentionally, since this is meant to catch cases that regex misses. Returns null (defer to the
 * normal dev/start/serve default) when no other script name appears at all.
 */
export function findMentionedScript(input, scripts) {
  const lower = input.toLowerCase();
  const names = Object.keys(scripts || {});
  // Longest name first so e.g. "test:e2e" wins over a bare "test" also being a substring match.
  names.sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) return name;
  }
  return null;
}

// Phase 3 (2026-08-03, NetPulse transcript): suggestion-chip bar for a project's own
// console.config.json `command` entries when a run-family builtin (run_project / npm_run) won
// the match but its input fell below matcher.js's CONFIG_RUN_ENTRY_FLOOR auto-run bar. Measured
// from real NetPulse inputs against its own triggers: the genuine cases this must catch score
// 0.41-0.50 ("run the site" -> 0.410 serve, "run the server" -> 0.499 serve), while inputs that
// merely contain "run" but are about something else ("run the numbers", "run the calculation")
// never reach this helper at all — they resolve to other intents (project.knowledge.commands)
// or the no-match fallback. A wrong suggestion chip is harmless (nothing runs until clicked),
// which is exactly why this bar is lower than the auto-run floor; 0.40 is the top of the
// measured no-man's-land below the true positives.
const CONFIG_SUGGESTION_FLOOR = 0.4;

// Requested directly (2026-07-30): findDocumentedRunCommands() returns every run command a doc
// documents, in doc order — and the FIRST one is often NOT the web server (NetPulse's "## Run"
// block lists `once` first, `serve` third). For a site-flavored ("run the site" / "start the
// web server") or server-flavored ("run the server" / "start the api") ask, prefer whichever
// documented command actually SERVES the web app (serve/flask / uvicorn/vite/npm dev shape) over
// the raw first match, so neither "run the site" nor "run the server" lands on a one-shot command
// documented first. Non-site asks and single-command docs keep the first-match behavior exactly
// as before. Widened 2026-08-03 to include server/api/backend demand-side shapes — the earlier
// site-only list let a README-only (no console.config.json) project's "run the server" fall back
// to the first documented command (e.g. `once`) instead of the actual `serve`.
const SITE_FLAVORED_INPUT_RE = /\b(site|website|web ?(app|site|server)|dashboard|frontend|page|server|api|backend)\b/i;
const SERVER_SHAPED_COMMAND_RE = /\b(serve\b|server|flask\s+run|uvicorn|gunicorn|vite(\s|$)|php\s+artisan\s+serve|dev\b|npm\s+run\s+(dev|start|serve)|dotnet\s+run|\bhttp\.server)/i;

function pickDocumentedRunCommand(documents, input) {
  if (!documents || documents.length === 0) return null;
  if (SITE_FLAVORED_INPUT_RE.test(input) && documents.length > 1) {
    const serving = documents.find((d) => SERVER_SHAPED_COMMAND_RE.test(d.command));
    if (serving) return serving;
  }
  return documents[0];
}

/**
 * Shared helper: detect project type and emit suggestion chips with runnable commands.
 * Used by both `npm_run` and `run_project` when no matching script is found.
 *
 * Phase 3 (2026-08-03, NetPulse transcript): the suggestion fallback this helper produces used
 * to guess from README/language markers alone — a generic "run the site" on NetPulse suggested
 * `python main.py once` (the first line of its README's Run block) instead of the project's own
 * hand-authored `python main.py serve` entry. A project's own console.config.json `command`
 * entries are strictly more trustworthy than any parsed README guess — same priority order as
 * the matcher's execution-side preference (CONFIG_RUN_ENTRY_FLOOR, stage 1b) — so prefer the
 * best-scoring entry here too, as a suggestion chip (NOT an auto-run: only matcher.js auto-runs,
 * above its own higher floor). Entries with `{param}` placeholders are skipped — a bare chip
 * can't answer the param ask (handleMatchedEntry's pendingParam flow only runs on the
 * entry-dispatch path, which this fallback isn't).
 */
export async function projectTypeSuggestions(ws, project, input, scripts) {
  const idx = project.codebaseIndex;
  const langs = idx?.languages || [];
  const entries = idx?.entryPoints || [];
  const fileSample = idx?.fileSample || [];
  const hasIndexHtml = entries.some(e => e.endsWith('index.html'));
  // Confirmed live 2026-07-29 (survey of every sibling project under Projects/): several small
  // Python/static projects ship a "Play <Name>.bat" launcher instead of a plain python/npm
  // entrypoint, and the launcher is frequently interactive (e.g. DuplicateFileAnalyzer's
  // `set /p TARGET=` folder prompt) or spawns a second detached window (StudyFlash's API server)
  // — neither of which `executeCommand`'s single non-interactive child process can reproduce.
  // Detect this pattern first and point the user at the launcher instead of guessing a command
  // that's likely wrong or would hang forever waiting on stdin nobody can answer. Hand-authored
  // console.config.json entries still take priority over this — it only fires when nothing
  // matched there first.
  // Requested directly (2026-07-30): before guessing a command from language detection alone,
  // check whether the project's own README/CLAUDE.md already documents the real run command
  // (Install/Usage/Getting Started/Run section, or any fenced code block with a recognizable
  // command shape — see readmeRunParser.js). This is real author-written instructions, strictly
  // more trustworthy than a language-based guess, and it's how trigger mode (no AI/Ollama
  // involved at all) can still "read the README" the same way a human skimming it would.
  //
  // Confirmed live 2026-08-03 (NetPulse, reported directly): this used to run AFTER the bat-
  // launcher check below, so a generic "run the site" on NetPulse always hit the bat-launcher
  // fallback and told the user to double-click Play NetPulse.bat — even though NetPulse's own
  // README documents a real, safe, non-interactive command (`python main.py serve`) and the bat
  // launcher was never actually necessary for it. The bat-launcher check exists for projects
  // where the launcher is the ONLY way to reproduce an interactive/multi-process startup — it
  // isn't a reason to ignore a documented single-command entry point when one exists. Swapped
  // order: a documented command now wins even when a Play *.bat file is also present.
  // Phase 3 (2026-08-03, NetPulse transcript): a project's own hand-authored command entries
  // win the *suggestion* race the same way matcher.js stage 1b makes them win the *execution*
  // race above CONFIG_RUN_ENTRY_FLOOR — before trusting a README-parse guess, check whether one
  // of the project's own entries scores above CONFIG_SUGGESTION_FLOOR. Runs before the
  // documented-command branch below for the same reason that branch runs before the bat-launcher
  // check: a config entry is authored for this exact console, so it's the most trustworthy
  // source of all. Deliberately suggestion-only — auto-execution stays in matcher.js where the
  // floor is higher and the safety checks (confirm flow, params) are the normal entry path.
  // Confirmed live 2026-07-29 (NetPulse, a real Flask/Python project): this used `langs.includes(
  // 'Python')` but codebaseIndexer.js's detectLanguages() always formats each entry as
  // "Python (4 files)" — never a bare name — so `.includes('Python')` (an exact-match array
  // check) could never be true for ANY project. Same bug for 'JavaScript'/'TypeScript'. This
  // silently broke the Python and JS branches below for every project, always falling through to
  // the generic "entry point" suggestion instead of "python main.py" / npm script suggestions.
  const isPython = langs.some((l) => l.startsWith('Python'));
  const isJs = langs.some((l) => l.startsWith('JavaScript') || l.startsWith('TypeScript'));
  const cfgEntries = (project.config || project)?.entries || [];
  if (cfgEntries.some((e) => e.type === 'command')) {
    const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === project.id);
    const best = await semanticMatcher.bestProjectCommandEntry(input, projectIndex);
    const bestEntry = best ? cfgEntries[best.entryIndex] : null;
    if (bestEntry && bestEntry.type === 'command' && !bestEntry.params && best.score >= CONFIG_SUGGESTION_FLOOR) {
      ws.send(JSON.stringify({ type: 'answer', data: `Found a run command in **[${project.name}]**'s own config:` }));
      ws.send(JSON.stringify({ type: 'suggestions', data: [bestEntry.action] }));
      return;
    }
  }
  const scriptNames = Object.keys(scripts);
  // Requested directly (2026-08-03): package.json's scripts are the more CURRENT source of truth
  // than a README/CLAUDE.md that may document an older command — a repo's package file gets
  // updated on every dependency/script change while the docs often lag behind. So when the project
  // has real npm scripts (and no matching config entry — config still wins, it's authored for this
  // exact console), prefer listing the actual scripts over trusting a documented command that may
  // be stale. If it turns out the doc has a command the scripts don't cover, the doc still shows
  // up lower in the pipeline — the scripts list is strictly the higher-trust source here. Order:
  // config entries > package.json scripts > documented README/CLAUDE.md command > bat launcher >
  // language guess.
  if (scriptNames.length > 0) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Available Scripts\n\nClick one to run it:` }));
    ws.send(JSON.stringify({ type: 'suggestions', data: scriptNames.map((s) => `npm run ${s}`) }));
    // Capability hint (2026-08-24): when another package manager is installed on this
    // machine, say so — `yarn run dev` works even though the chips say npm. The boot-cached
    // probe is async, so the hint rides on the script list only when it resolves in time.
    hasInstalledCli('yarn').then((hasYarn) => {
      if (hasYarn && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'answer', data: `*Also installed on this machine: **yarn** — \`yarn run <script>\` works too.*` }));
      }
    }).catch(() => {});
    return;
  }
  const documented = pickDocumentedRunCommand(findDocumentedRunCommands(project), input);
  if (documented) {
    const sourceNote = documented.header
      ? `Found in **${documented.doc}** under "${documented.header}":`
      : `Found in **${documented.doc}**:`;
    ws.send(JSON.stringify({ type: 'answer', data: `${sourceNote}` }));
    ws.send(JSON.stringify({ type: 'suggestions', data: [documented.command] }));
    return;
  }
  const batLauncher = fileSample.find((f) => /^Play .+\.bat$/i.test(f));
  if (batLauncher) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `This project ships its own launcher: **${batLauncher}**. It may prompt for input or start more than one process, so double-click it in File Explorer (or run it from a terminal) instead of through this console.`,
    }));
    return;
  }
  // Widened 2026-07-30 (raised directly, alongside the codebase indexer's own language coverage
  // widening) — these five used to have no trigger-mode run-command support at all and fell into
  // the generic `entries.length > 0` branch below, which just does `start <entrypoint>` — wrong
  // for anything compiled (e.g. `start main.go` opens the file in its default editor instead of
  // running it). Each checks a real project marker (not just language file count) before
  // suggesting anything, same "don't guess if we can't tell" spirit as the Python branch above.
  const isGo = !!idx?.keyFiles?.['go.mod'];
  const isRust = !!idx?.keyFiles?.['cargo.toml'];
  const isJava = !!(idx?.keyFiles?.['pom.xml'] || idx?.keyFiles?.['build.gradle'] || idx?.keyFiles?.['build.gradle.kts']);
  const isRuby = !!idx?.keyFiles?.['Gemfile'];
  const isPhp = !!idx?.keyFiles?.['composer.json'];
  const isCSharp = entries.some((e) => e.endsWith('Program.cs')) || langs.some((l) => l.startsWith('C#'));
  const suggestions = [];

  if (isPython) {
    // Confirmed live 2026-07-29 (survey of every sibling project under Projects/): blindly
    // suggesting "python main.py" / "python app.py" is wrong more often than not — some projects
    // have neither file at their root (DuplicateFileAnalyzer's real entry is a package module,
    // `backend/main.py`, invoked as `-m backend.main`), and some have a real main.py that isn't
    // the right file to suggest first (NetPulse's main.py is a CLI dispatcher — `python main.py`
    // alone just prints usage; the actual server command is `python main.py serve`). Prefer
    // whichever common entry filename actually exists at the project root before falling back to
    // a guess, so the suggestion chip is at least a file that's really there.
    const rootPyFiles = fileSample.filter((f) => f.endsWith('.py') && !f.includes('/') && !f.includes('\\'));
    const commonNames = ['main.py', 'app.py', 'run.py', 'server.py', 'dashboard.py'];
    const found = commonNames.filter((n) => rootPyFiles.includes(n));
    ws.send(JSON.stringify({ type: 'answer', data: `This appears to be a **Python** project. Click a suggestion to run it:` }));
    if (found.length > 0) {
      found.forEach((n) => suggestions.push(`python ${n}`));
    } else {
      suggestions.push('python main.py', 'python app.py');
    }
  } else if (hasIndexHtml && !scriptNames.length) {
    // Hedge when the structure genuinely looks like a wrapper/monorepo (root package.json +
    // sub-packages, so detectSubPackages saw more than one manifest dir) but the command-dir
    // rule (commandDir.js) couldn't resolve one — a confident guess is wrong more often than
    // not there. Confirmed live 2026-08-11: a SAM SYSTEM wrapper whose root package.json held
    // only placeholder scripts answered "This is a static site (no build step)" while the real
    // app sat one level down in sam_system.
    const wrapperAmbiguity = idx.subPackages?.length > 1 && !(await getCommandDir(project));
    ws.send(JSON.stringify({ type: 'answer', data: wrapperAmbiguity
      ? `This looks like it might have a nested app — trying to figure out the right one. The options below still serve a plain static site:`
      : `This is a **static site** (no build step). Click a suggestion to serve it locally:` }));
    suggestions.push('npx serve .', 'python -m http.server 8080');
  } else if (isJs) {
    ws.send(JSON.stringify({ type: 'answer', data: `JavaScript project with no npm scripts. Try:` }));
    suggestions.push('npx serve .', 'npx vite', 'npm install');
  } else if (isRust) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Rust** project (Cargo.toml found). Click a suggestion to run it:` }));
    suggestions.push('cargo run', 'cargo build');
  } else if (isGo) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Go** project (go.mod found). Click a suggestion to run it:` }));
    suggestions.push('go run .', 'go build ./...');
  } else if (isJava) {
    const isGradle = !!(idx?.keyFiles?.['build.gradle'] || idx?.keyFiles?.['build.gradle.kts']);
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Java** project (${isGradle ? 'Gradle' : 'Maven'} found)${idx?.frameworks?.includes('Spring Boot') ? ' using **Spring Boot**' : ''}. Click a suggestion to run it:` }));
    if (isGradle) suggestions.push('./gradlew bootRun', './gradlew run');
    else suggestions.push('mvn spring-boot:run', 'mvn compile exec:java');
  } else if (isRuby) {
    const looksLikeRails = fileSample.includes('config.ru') || fileSample.some((f) => f.startsWith('config/environment.rb'));
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **Ruby** project (Gemfile found)${looksLikeRails ? ', likely Rails/Rack' : ''}. Click a suggestion to run it:` }));
    if (looksLikeRails) suggestions.push('bundle exec rails server', 'bundle exec rackup');
    else suggestions.push('bundle install', 'bundle exec ruby app.rb');
  } else if (isPhp) {
    const isLaravel = idx?.frameworks?.includes('Laravel') || fileSample.includes('artisan');
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **PHP** project (composer.json found)${isLaravel ? ', looks like Laravel' : ''}. Click a suggestion to run it:` }));
    if (isLaravel) suggestions.push('php artisan serve');
    else suggestions.push('php -S localhost:8000', 'composer install');
  } else if (isCSharp) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **C#/.NET** project. Click a suggestion to run it:` }));
    suggestions.push('dotnet run', 'dotnet build');
  } else if (entries.length > 0) {
    ws.send(JSON.stringify({ type: 'answer', data: `**Entry point:** \`${entries[0]}\`. Try:` }));
    suggestions.push(`start ${entries[0]}`);
  } else {
    ws.send(JSON.stringify({ type: 'answer', data: `Could not detect project type. Try "help" for available commands or turn AI mode ON.` }));
  }
  if (suggestions.length > 0) {
    ws.send(JSON.stringify({ type: 'suggestions', data: suggestions }));
  }
}
