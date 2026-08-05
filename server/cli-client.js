import WebSocket from 'ws';
import readline from 'readline';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import boxen from 'boxen';
import figlet from 'figlet';

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
    const res = await fetch(`http://${HOST}:${port}/api/projects`, { signal: AbortSignal.timeout(2000) });
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
        if (msg.data) writeLine(`${C.reset}${stripMarkdown(msg.data)}\n`);
        break;
      case 'error_output':
        if (msg.data) writeLine(`${C.red}${msg.data}${C.reset}`);
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
        confirmPending = true;
        questionAsync(`Risky command "${msg.command}"? (y/N):`).then((ans) => {
          confirmPending = false;
          ws.send(JSON.stringify({ type: 'confirm_response', payload: { token: msg.token, confirmed: ans === 'y' || ans === 'yes' } }));
        });
        break;
      case 'tool_confirm_prompt':
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
