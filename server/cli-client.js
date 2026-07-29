import WebSocket from 'ws';
import readline from 'readline';

// Mirrors server/index.js's own PORT..PORT+9 fallback range — if something else already had
// BASE_PORT (a stale console instance, another dev server, anything), the real server may have
// landed anywhere in this range, and this client used to have no way to find it.
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || 'localhost';
const MAX_PORT_ATTEMPTS = 10;
// Bumped from 20s to 40s (requested directly) — real startup (dotenvx env injection, NLP
// training, semanticMatcher's embedding-model load, etc.) sometimes runs long enough that 20s
// wasn't consistently enough, especially on a cold start.
const CONNECT_TIMEOUT_MS = 40000;
const RETRY_INTERVAL_MS = 750;

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', blue: '\x1b[34m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m',
  bgBlue: '\x1b[44m',
};

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
async function discoverServer() {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let printedDots = false;
  while (Date.now() < deadline) {
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const result = await tryFetchProjects(BASE_PORT + i);
      if (result) {
        if (printedDots) process.stdout.write('\n');
        return result;
      }
    }
    process.stdout.write('.');
    printedDots = true;
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
  if (printedDots) process.stdout.write('\n');
  return null;
}

function selectProject(projects) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n${C.bold}${C.cyan}Available Projects:${C.reset}\n`);
    projects.forEach((p, i) => {
      console.log(`  ${C.bold}${i + 1}${C.reset}. ${C.green}${p.name}${C.reset}\n     ${C.dim}${p.path}${C.reset}`);
    });
    rl.question(`\n${C.bold}Select project (1-${projects.length}):${C.reset} `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10);
      resolve(idx >= 1 && idx <= projects.length ? projects[idx - 1] : projects[0]);
    });
  });
}

async function main() {
  console.clear();
  console.log(`\n${C.bgBlue}${C.bold}  Local Project Console — CLI Chat  ${C.reset}\n`);
  console.log(`${C.dim}Connecting (checking ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}, retrying for up to ${CONNECT_TIMEOUT_MS / 1000}s)...${C.reset}`);

  const discovered = await discoverServer();
  if (!discovered || discovered.projects.length === 0) {
    console.log(`${C.red}✖ Could not connect to a server on ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}${C.reset}`);
    console.log(`${C.yellow}  Make sure "npm run dev" is running (or still finishing startup), then try again.${C.reset}`);
    process.exit(1);
  }

  let { projects, port: PORT } = discovered;
  if (PORT !== BASE_PORT) {
    console.log(`${C.yellow}Note: server is on port ${PORT}, not ${BASE_PORT} (something else had ${BASE_PORT}).${C.reset}`);
  }
  console.log(`${C.green}✔ Connected.${C.reset}`);

  let project = projects.length === 1 ? projects[0] : await selectProject(projects);

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
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
      const q = readline.createInterface({ input: process.stdin, output: process.stdout });
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
        process.stdout.write(`${C.yellow}🧠 ${msg.data || 'AI thinking...'}${C.reset}\n`);
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
