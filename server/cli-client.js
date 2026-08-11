import WebSocket from 'ws';
import readline from 'readline';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import boxen from 'boxen';
import figlet from 'figlet';
import cowsay from 'cowsay';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Mirrors server/index.js's own PORT..PORT+9 fallback range — if something else already had
// BASE_PORT (a stale console instance, another dev server, anything), the real server may have
// landed anywhere in this range, and this client used to have no way to find it.
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || 'localhost';
const MAX_PORT_ATTEMPTS = 10;
// Bumped again 2026-07-30 (40s → 90s) based on a real measured cold boot of ~41s — right at the
// old timeout's edge, meaning some boots were likely already failing silently before this. The
// 2026-07-30 intent-expansion batch also grew intentsData.js by roughly a third (more phrases for
// semanticMatcher.js to embed, more training data for nlpEngine.js), which pushes real startup
// time up further, not down. 90s gives real headroom above the one measured data point rather
// than guessing a new number outright — re-measure and adjust again if a real boot ever gets
// close to this new ceiling. (Previous bump: 20s → 40s, same underlying cause.)
const CONNECT_TIMEOUT_MS = 90000;
const RETRY_INTERVAL_MS = 750;

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', blue: '\x1b[34m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m',
  bgBlue: '\x1b[44m',
};

// @clack/prompts requires an interactive TTY (raw-mode input) and throws on piped/redirected
// stdin, so every clack call below is gated on this and falls back to the plain readline
// implementations the CLI had before — those still work in non-interactive shells.
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/### /g, '');
}

async function tryFetchProjects(port) {
  try {
    // 5s, not 2s: measured live 2026-08-10 — this machine's /api/projects takes ~1.7s on a
    // freshly booted server (project discovery rescans 15 folders), so a 2s abort fired on
    // most retry cycles and the CLI reported "could not connect" against a healthy server.
    const res = await fetch(`http://${HOST}:${port}/api/projects`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return { projects: data.projects || [], port };
  } catch {
    return null;
  }
}

/**
 * Finds which port the server actually bound to and waits out its startup time, instead of the
 * old single-shot fetch that failed instantly if the server wasn't listening yet on the exact
 * moment this ran (confirmed live: "npm run dev" starting via start.bat is not instant — route
 * registration, Vite middleware setup, and the embedding model used by semanticMatcher.js all
 * take real time) or if it had fallen back off BASE_PORT.
 */
async function discoverServer(onCycle) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  let printedDots = false;
  while (Date.now() < deadline) {
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const result = await tryFetchProjects(BASE_PORT + i);
      if (result) {
        if (printedDots) process.stdout.write('\n');
        return result;
      }
    }
    // TTY path: main() drives a @clack/prompts spinner via this callback; the non-TTY path
    // keeps the original dot-printing so piped/redirected output stays readable.
    if (onCycle) {
      onCycle(Math.floor((Date.now() - startedAt) / 1000));
    } else {
      process.stdout.write('.');
      printedDots = true;
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
  if (printedDots) process.stdout.write('\n');
  return null;
}

// TTY: interactive arrow-key select via @clack/prompts. Clack only accepts listed options, so
// the confirmed-live 2026-07-30 bug class ("anything that wasn't an in-range number silently
// resolved to projects[0] with zero feedback") can't happen here; Esc/Ctrl+C cancels cleanly.
// Non-TTY (piped/CI stdin): clack throws without a TTY, so fall back to the numbered readline
// picker, which keeps the exact re-ask behavior that fixed that 2026-07-30 report.
function selectProject(projects) {
  return isTTY ? selectProjectInteractive(projects) : selectProjectLegacy(projects);
}

async function selectProjectInteractive(projects) {
  const selected = await p.select({
    message: 'Select a project to open in CLI session:',
    options: projects.map((proj) => ({
      value: proj,
      label: proj.name,
      hint: chalk.dim(proj.path),
    })),
  });
  if (p.isCancel(selected)) {
    p.cancel('CLI Session cancelled.');
    process.exit(0);
  }
  return selected;
}

// Confirmed live 2026-07-30 (real transcript): typing anything that wasn't a valid in-range
// number — a stray chat message sent before the picker was answered ("what port are you running
// on"), or a mistyped number ("1100") — used to silently resolve to `projects[0]` with zero
// feedback. That's how a session ended up on the wrong project with no visible error at all: the
// user thought they'd typed a chat message or picked project #11, but actually got whichever
// project happened to be first in the list. Now it re-asks instead of ever guessing.
function selectProjectLegacy(projects) {
  return new Promise((resolve) => {
    // crlfDelay: Infinity — without it, Node's readline docs warn that an interface can emit
    // TWO 'line' events for one Enter press if the \r and \n bytes of a Windows-style line ending
    // arrive in separate reads (default crlfDelay is only 100ms). This matches a real report:
    // typing "10" for project #10 registered each digit as if pressed twice. Windows terminals
    // (ConPTY in particular) are exactly the case docs call out as prone to this. Applied to all
    // three readline.createInterface() calls in this file for the same reason.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
    console.log(`\n${C.bold}${C.cyan}Available Projects:${C.reset}\n`);
    projects.forEach((p, i) => {
      console.log(`  ${C.bold}${i + 1}${C.reset}. ${C.green}${p.name}${C.reset}\n     ${C.dim}${p.path}${C.reset}`);
    });
    const ask = () => {
      rl.question(`\n${C.bold}Select project (1-${projects.length}):${C.reset} `, (answer) => {
        const idx = parseInt(answer.trim(), 10);
        if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) {
          rl.close();
          resolve(projects[idx - 1]);
        } else {
          console.log(`${C.red}"${answer.trim()}" isn't a number between 1 and ${projects.length} — try again.${C.reset}`);
          ask();
        }
      });
    };
    ask();
  });
}

// Requested directly: a way to skip the interactive picker entirely and jump straight to a known
// project directory, e.g. `node server/cli-client.js --dir "C:\Users\tobil\Desktop\Projects\netpulse"`
// (also accepts `--project <name>` for a case-insensitive name/folder-name match). Matched against
// whatever the server's own discovery already returned — this never re-implements project
// discovery client-side, it just picks from the same list `selectProject()` would show.
function findProjectFromArgs(projects) {
  const args = process.argv.slice(2);
  const dirIdx = args.findIndex((a) => a === '--dir' || a === '-d');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    const target = args[dirIdx + 1].replace(/[\\/]+$/, '').toLowerCase();
    const match = projects.find((p) => p.path.replace(/[\\/]+$/, '').toLowerCase() === target);
    if (match) return match;
    console.log(`${C.yellow}No discovered project has path "${args[dirIdx + 1]}" — falling back to the picker.${C.reset}`);
    return null;
  }
  const projIdx = args.findIndex((a) => a === '--project' || a === '-p');
  if (projIdx !== -1 && args[projIdx + 1]) {
    const target = args[projIdx + 1].toLowerCase();
    const match = projects.find((p) => p.name.toLowerCase() === target || p.folderName?.toLowerCase() === target);
    if (match) return match;
    console.log(`${C.yellow}No discovered project matches name "${args[projIdx + 1]}" — falling back to the picker.${C.reset}`);
    return null;
  }
  return null;
}

// ASCII mascot greeting shown above the project picker (TTY path only, matching the figlet
// banner). The animal is picked at random from a curated list validated against the installed
// cowsay package's cows/ directory (2026-08-10: cat/owl/dragon/robot/stegosaurus all present);
// the fallback exists because cowsay.say() throws on an unknown f value, and the greeting name
// comes from the tracked user profile when available, never hardcoded per user.
const MASCOT_COWS = ['cat', 'owl', 'dragon', 'robot', 'stegosaurus', 'tux', 'doge'];
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function renderMascot() {
  // Generic fallback, not a hardcoded person's name — data/user-profile.json isn't published
  // with the npm package and only exists once a user sets their own profile, so a fresh install
  // used to greet every stranger as "Tobi" (the original author) by name (audit 2026-08-10,
  // raised while generalizing for npm/public distribution).
  let name = 'there';
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'user-profile.json'), 'utf8'));
    if (profile.userProfile?.name) name = profile.userProfile.name;
  } catch {
    // Missing/corrupt profile must not fail the whole CLI — keep the fallback name.
  }
  const animal = MASCOT_COWS[Math.floor(Math.random() * MASCOT_COWS.length)];
  let art;
  try {
    art = cowsay.say({ text: `Welcome back, ${name}! Select a project to initialize session:`, e: 'oO', T: 'U ', f: animal });
  } catch {
    art = cowsay.say({ text: `Welcome back, ${name}!`, f: 'cat' });
  }
  console.log(chalk.cyan(art));
}

async function main() {
  console.clear();
  if (isTTY) {
    console.log(chalk.cyan(figlet.textSync('PROJECT CONSOLE', { horizontalLayout: 'full' })));
    console.log(
      boxen(chalk.dim('Local Project Engine — Offline Project & AI Assistant'), {
        padding: { left: 2, right: 2 },
        margin: { bottom: 1 },
        borderStyle: 'round',
        borderColor: 'cyan',
      })
    );
    renderMascot();
  } else {
    console.log(`\n${C.bgBlue}${C.bold}  Local Project Console — CLI Chat  ${C.reset}\n`);
  }
  console.log(`${C.dim}Tip: skip the picker next time with --dir "<full project path>" or --project "<name>".${C.reset}`);

  const spinner = isTTY ? p.spinner() : null;
  if (spinner) {
    spinner.start(`Connecting to local server (ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1})...`);
  } else {
    console.log(`${C.dim}Connecting (checking ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}, retrying for up to ${CONNECT_TIMEOUT_MS / 1000}s)...${C.reset}`);
  }

  const discovered = await discoverServer(
    spinner
      ? (elapsed) => spinner.message(`Still connecting (${elapsed}s elapsed, checking ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1})...`)
      : null
  );
  if (!discovered || discovered.projects.length === 0) {
    if (spinner) spinner.stop(chalk.red(`✖ Could not connect to a server on ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}`));
    else console.log(`${C.red}✖ Could not connect to a server on ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}${C.reset}`);
    console.log(`${C.yellow}  Make sure "npm run dev" is running (or still finishing startup), then try again.${C.reset}`);
    process.exit(1);
  }

  let { projects, port: PORT } = discovered;
  // Stop the spinner BEFORE the port-collision note so stdout writes don't interleave with the
  // still-animating spinner line (clack owns that line until .stop()).
  if (spinner) {
    spinner.stop(chalk.green(`✔ Connected to Local Engine on port ${PORT}`));
  } else {
    console.log(`${C.green}✔ Connected.${C.reset}`);
  }
  if (PORT !== BASE_PORT) {
    console.log(`${C.yellow}Note: server is on port ${PORT}, not ${BASE_PORT} (something else had ${BASE_PORT}).${C.reset}`);
  }

  let project = findProjectFromArgs(projects) || (projects.length === 1 ? projects[0] : await selectProject(projects));

  console.log(`\n${C.dim}─── Project: ${C.green}${project.name}${C.dim} ───────${C.reset}`);
  console.log(`${C.gray}Type a message, 'projects' to switch/rescan, or 'quit' to exit.${C.reset}\n`);

  const ws = new WebSocket(`ws://${HOST}:${PORT}/stream`);
  let rl;
  let waitingForInput = false;
  // Confirmed live 2026-07-29: the server sends a 'confirm_prompt' AND (for that same turn) an
  // 'end' message — fine for the web UI (a confirmation card + hiding a spinner are independent
  // concerns there), but the CLI's 'end' handler used to unconditionally call `rl.prompt(true)`
  // on whatever `rl` currently pointed to. `questionAsync()` below closes `rl` the instant a
  // confirm prompt starts and doesn't reassign it until the user actually answers — so an 'end'
  // arriving in that window called `.prompt()` on an already-closed readline interface and
  // crashed the whole client with ERR_USE_AFTER_CLOSE. This flag makes 'end' a no-op while a
  // confirm/tool-confirm prompt owns the terminal; `questionAsync`'s own `setupReadline()` call
  // (after the user answers) is what re-prompts, so nothing is lost by skipping it here.
  let confirmPending = false;

  // Numbered option picks for the server's chip-style messages ('suggestions' / 'did_you_mean').
  // The web UI renders these as clickable chips; the CLI renders them as numbers the user types
  // in the input line. Entries are cleared on ANY next input — a non-number just falls through
  // as a normal message (the web UI's chips are non-blocking too), so a stray "1" typed later
  // can never fire a stale pick.
  let pendingOptions = [];

  // stdout.write() calls below don't reliably end in '\n' — some WS message types (start/output/
  // token) are meant to run together mid-stream. But 'answer' is always a discrete reply, and the
  // server can send more than one in a single turn (e.g. an "answer" from npm_run immediately
  // followed by a fallback "answer" from projectTypeSuggestions) — those used to print back-to-
  // back with no separator ("No script called dev found in package.json.Could not detect project
  // type..."), unlike the web UI where each 'answer' becomes its own chat bubble. Track whether
  // the last thing written ended in a newline and force one before any new discrete message.
  let atLineStart = true;
  function writeLine(text) {
    if (!atLineStart) process.stdout.write('\n');
    process.stdout.write(text);
    atLineStart = text.endsWith('\n');
  }
  function writeRaw(text) {
    process.stdout.write(text);
    atLineStart = text.endsWith('\n');
  }

  // Renders a numbered block for server chip messages and records the options so the next bare
  // in-range number input picks one (see setupReadline). Numbering continues across successive
  // chip messages within the same turn — the fallback path sends did_you_mean before suggestions.
  function addPendingOptions(entries, header) {
    const start = pendingOptions.length + 1;
    const lines = entries.map((e, i) => {
      const label = e.kind === 'didYouMean' ? e.label : e.text;
      return `  ${C.cyan}${start + i}${C.reset}) ${C.green}${label}${C.reset}`;
    });
    writeLine(`${C.dim}${header}:${C.reset}\n${lines.join('\n')}\n`);
    pendingOptions.push(...entries);
  }

  async function refreshProjects() {
    const result = await tryFetchProjects(PORT);
    if (result && result.projects.length > 0) projects = result.projects;
    return projects;
  }

  async function switchProject() {
    await refreshProjects();
    const next = await selectProject(projects);
    project = next;
    console.log(`\n${C.dim}─── Project: ${C.green}${project.name}${C.dim} ───────${C.reset}\n`);
    atLineStart = true;
  }

  function setupReadline() {
    if (rl) rl.close();
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
    // Piped/redirected stdin (echo foo | cli-client, CI) hits EOF, which closes the interface
    // under us — a server 'end' arriving afterwards used to crash with ERR_USE_AFTER_CLOSE
    // (reproduced 2026-08-10). Track liveness via a close listener so the 'end' handler's
    // existing `&& rl` guard actually works; real TTY sessions never EOF, so this only affects
    // scripted runs.
    rl.on('close', () => { rl = null; });
    rl.setPrompt(`${C.cyan}${C.bold}chat>${C.reset} `);
    waitingForInput = true;
    rl.prompt();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) { rl.prompt(); return; }

      // If waiting for confirm/consent, route to the pending handler
      if (pendingConfirm) {
        const { resolve } = pendingConfirm;
        pendingConfirm = null;
        const ok = trimmed.toLowerCase() === 'y' || trimmed.toLowerCase() === 'yes';
        resolve(ok);
        return;
      }
      // If a chip-style question is pending, a bare in-range number picks that option (the web
      // UI equivalent of clicking a chip). Anything else clears the options and flows on as a
      // normal message — same non-blocking semantics as the web UI's chip bar.
      if (pendingOptions.length > 0) {
        const numeric = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
        const chosen = Number.isInteger(numeric) && numeric >= 1 && numeric <= pendingOptions.length
          ? pendingOptions[numeric - 1]
          : null;
        pendingOptions = [];
        if (chosen) {
          if (chosen.kind === 'didYouMean') {
            ws.send(JSON.stringify({ type: 'did_you_mean_pick', payload: { intent: chosen.intent } }));
          } else {
            ws.send(JSON.stringify({ type: 'execute', payload: { projectId: project.id, input: chosen.text, sessionId: null } }));
          }
          return;
        }
      }
      const lower = trimmed.toLowerCase();
      if (lower === 'quit' || lower === 'exit') {
        console.log(`\n${C.yellow}Bye!${C.reset}`);
        ws.close();
        process.exit(0);
      }
      // Handled entirely client-side — these never had a way to work without restarting the
      // whole process before, since the project was only ever picked once at startup. Nothing
      // server-side needs to change: handleExecute() already trusts whatever projectId is sent
      // on each individual message, so switching is just a matter of changing what this client
      // sends next.
      if (lower === 'projects' || lower === 'switch project' || lower === 'change project' || lower === 'scan projects' || lower === 'rescan projects') {
        waitingForInput = false;
        rl.pause();
        switchProject().then(() => { waitingForInput = true; rl.prompt(true); });
        return;
      }
      // Normal message
      waitingForInput = false;
      rl.pause();
      ws.send(JSON.stringify({
        type: 'execute',
        payload: { projectId: project.id, input: trimmed, sessionId: null },
      }));
    });
  }

  let pendingConfirm = null;    // { resolve, question }

  function questionAsync(prompt) {
    return new Promise((resolve) => {
      if (rl) rl.close();
      const q = readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
      q.question(`${C.yellow}${prompt} ${C.reset}`, (answer) => {
        q.close();
        resolve(answer.trim().toLowerCase());
        setupReadline();
      });
    });
  }

  ws.on('open', setupReadline);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'answer':
        // Phase 1.5 (UPGRADE-ROADMAP.md): web-UI tool panels (`openPanel` on the answer
        // payload) are deliberately ignored here — PERMANENTLY. There is no terminal-native
        // equivalent of a live button grid or a file-drop picker, and the numbered-option-list
        // pattern is a worse fit for it than plain text. The same answer's `data` text is the
        // CLI-usable half of the contract: panel opers (e.g. "open calculator") always phrase
        // the chat command equivalent ("use 'calculate ...' directly"). Do not "fix" this.
        // A new answer starts a fresh turn (or continues one whose options already fired) —
        // stale options from a previous turn must not linger, or a later "1" could fire a pick
        // from a dead conversation (seen live: fallback suggestions from turn N still pending
        // when turn N+1's suggestions arrived, mis-numbering them 8-13).
        pendingOptions = [];
        if (msg.data) writeLine(`${C.reset}${stripMarkdown(msg.data)}\n`);
        break;
      case 'error_output':
        pendingOptions = [];
        if (msg.data) writeLine(`${C.red}${msg.data}${C.reset}`);
        break;
      case 'warning':
        // Informational notices (the LF/CRLF collapse summary, sandbox-mode confirmations,
        // "process survived kill" heads-ups) — the web UI renders an amber banner, so this used
        // to fall through to default and be silently dropped in the CLI. Same stale-chip guard
        // as error_output: a warning starts a fresh read of the situation, not a pick from a
        // dead turn.
        pendingOptions = [];
        if (msg.data) writeLine(`${C.yellow}${msg.data}${C.reset}\n`);
        break;
      case 'output':
        if (msg.data) writeRaw(`${C.green}${msg.data}${C.reset}`);
        break;
      case 'start':
        if (msg.data) writeRaw(`${C.dim}${msg.data}${C.reset}`);
        break;
      case 'stream_start':
        writeRaw(C.reset);
        break;
      case 'token':
        if (msg.data) writeRaw(msg.data);
        break;
      case 'stream_end':
        writeRaw('\n');
        break;
      case 'end':
        writeRaw(`\n`);
        if (!waitingForInput && !confirmPending && rl) { waitingForInput = true; rl.prompt(true); }
        break;
      case 'clear_console':
        console.clear();
        atLineStart = true;
        break;
      case 'confirm_prompt':
        pendingOptions = [];
        confirmPending = true;
        questionAsync(`Risky command "${msg.command}"? (y/N):`).then((ans) => {
          confirmPending = false;
          ws.send(JSON.stringify({ type: 'confirm_response', payload: { token: msg.token, confirmed: ans === 'y' || ans === 'yes' } }));
        });
        break;
      case 'tool_confirm_prompt':
        pendingOptions = [];
        confirmPending = true;
        questionAsync(`AI wants to run ${C.bold}${msg.tool}${C.reset}${C.yellow} with ${JSON.stringify(msg.args)} — approve? (y/N):`).then((ans) => {
          confirmPending = false;
          ws.send(JSON.stringify({ type: 'confirm_response', payload: { token: msg.token, confirmed: ans === 'y' || ans === 'yes' } }));
        });
        break;
      case 'ai_start':
        process.stdout.write(`${C.yellow}${msg.data || 'AI thinking...'}${C.reset}\n`);
        break;
      case 'tool_start':
        if (msg.data) process.stdout.write(`${C.dim}${msg.data}${C.reset}\n`);
        break;
      case 'tool_result':
        if (msg.data?.result?.error || msg.data?.error) process.stdout.write(`${C.red}✖ ${msg.data.result?.error || msg.data.error}${C.reset}\n`);
        else process.stdout.write(`${C.green}✔ ${msg.data?.tool || 'Tool'} done${C.reset}\n`);
        break;
      case 'suggestions':
        // Run-command suggestions (config entries, npm scripts, documented commands) — the web
        // UI renders clickable chips; render them as a numbered list the user can pick from.
        if (Array.isArray(msg.data) && msg.data.length > 0) {
          addPendingOptions(msg.data.map((text) => ({ kind: 'suggestion', text })), 'Options');
          writeLine(`${C.dim}(type a number to run it, or type your own message)${C.reset}\n`);
        }
        break;
      case 'did_you_mean':
        // Non-blocking "did you mean" chip (matcher's closeSecond / nearest-intent hint).
        if (msg.data && typeof msg.data.intent === 'string' && typeof msg.data.label === 'string') {
          addPendingOptions([{ kind: 'didYouMean', intent: msg.data.intent, label: msg.data.label }], 'Did you mean');
          writeLine(`${C.dim}(type its number to pick it)${C.reset}\n`);
        }
        break;
      case 'memory_suggestion':
        // Accept/reject card for a suggested CLAUDE.md memory note. The reply is plain text
        // ("yes"/"no") handled by the server's pending-memory-suggestion interceptor, so this
        // only renders the card — no interception needed.
        if (msg.data?.topic) {
          writeLine(`${C.yellow}[Memory suggestion]${C.reset} ${C.bold}${msg.data.topic}${C.reset}${msg.data.content ? `: ${msg.data.content}` : ''}\n${C.dim}(reply "yes" to add this to CLAUDE.md, "no" to skip)${C.reset}\n`);
        }
        break;
      case 'learning_suggestion': {
        // "review learning" output — mirror the web UI's formatting and offer the same
        // per-item "approve N" chips as numbered options (text replies also work).
        const lSuggestions = msg.data?.suggestions;
        if (!Array.isArray(lSuggestions) || lSuggestions.length === 0) {
          writeLine('No learning suggestions yet — keep using the console and check back later!\n');
        } else {
          const lines = ['Learning suggestions:'];
          lSuggestions.forEach((s) => {
            const phrases = (s.phrases || []).slice(0, 5).join(', ');
            const extra = (s.phrases || []).length > 5 ? ` (+${s.phrases.length - 5} more)` : '';
            lines.push(`  ${C.bold}${s.intent}${C.reset} (${s.confidence}) — ${s.count} occurrences, ${s.accepted} accepted, ${s.rejected} rejected`);
            lines.push(`    Phrases: ${phrases}${extra}`);
          });
          lines.push('Type "approve suggestions" to add all, or "approve suggestions 1 3" to approve specific ones.');
          writeLine(lines.join('\n') + '\n');
          addPendingOptions(lSuggestions.map((_, i) => ({ kind: 'suggestion', text: `approve ${i + 1}` })), 'Approve');
        }
        break;
      }
      case 'server_url':
        // "This is the project's dev-server site" — the web UI renders a clickable chip; the
        // CLI has nothing to click, so print the URL plainly.
        if (msg.data) writeLine(`${C.green}Site running at: ${msg.data}${C.reset}\n`);
        break;
      case 'update_available':
        // One-shot newer-version notice (see updateChecker.js). Mirrors the web UI's
        // malformed-payload guard: a partial object is ignored, never rendered.
        if (msg.data?.current && msg.data?.latest) {
          writeLine(`${C.yellow}Update available: v${msg.data.current} -> v${msg.data.latest} (run 'update console')${C.reset}\n`);
        }
        break;
      // Deliberately-not-rendered CLI no-ops: each of these is handled meaningfully by the web
      // UI but has no terminal equivalent, and every one used to fall through to `default` with
      // zero signal that it was considered. CLI parity for new WS message types is enforced by
      // scripts/checkWsMessageCases.ts — a key in WS_CORE_CASES without a `case` here (rendered
      // OR this kind of explicit no-op) fails the harness.
      case 'projects_updated': // project-list refresh — the CLI refetches on demand via 'projects'
      case 'project_updated': break; // single-project update — same
      case 'ai_status': break; // AI toggle state — a UI switch, not terminal info
      case 'thinking': break; // reasoning-model trace — an italic panel in the web UI
      case 'task_granted': break; // "approved" acknowledgement — the CLI already saw the y/N prompt
      case 'workspace_updated': break; // workspace-project set — UI-only (SidebarDrawer)
      case 'copy_to_clipboard': break; // browser clipboard write — no browser here; the copy intent's own answer text is the CLI's confirmation
      case 'dashboard_update': break; // dashboard refresh signal — no dashboard in the CLI
      case 'processes_update': break; // dock refresh signal — no dock in the CLI
      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log(`\n${C.yellow}Connection closed.${C.reset}`);
    if (rl) rl.close();
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.log(`\n${C.red}WebSocket error: ${err.message}${C.reset}`);
    if (rl) rl.close();
    process.exit(1);
  });
}

main();
