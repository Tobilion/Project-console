import WebSocket from 'ws';
import readline from 'readline';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import boxen from 'boxen';
import figlet from 'figlet';
import {
  BASE_PORT,
  HOST,
  MAX_PORT_ATTEMPTS,
  CONNECT_TIMEOUT_MS,
  C,
  isTTY,
  SCRIPTED,
  JSON_MODE,
  QUERY_INPUT,
  DRY_RUN_INPUT,
  EXPORT_ID,
  EXPORT_FORMAT,
  RESUME_ID,
  WANT_LAST,
  generalPseudoProject,
} from './cliOptions.js';
import { stripMarkdown, discoverServer, pickResumeSession } from './cliDiscovery.js';
import { selectProject, findProjectFromArgs } from './cliProjectPicker.js';
import { renderMascot } from './cliMascot.js';
import { createCliRenderer } from './cliRenderer.js';

// Real-shell Ctrl+C (2026-08-24): send the server's `cancel` (which stops only the current AI
// turn's own processes) instead of Node's default abrupt kill, then exit 130 like a shell. A
// second Ctrl+C force-exits without waiting. `activeWs` is set by main() once connected.
let activeWs = null;
let sigintCount = 0;
process.on('SIGINT', () => {
  sigintCount++;
  if (sigintCount > 1) process.exit(130);
  process.stdout.write('\n^C — cancelling…\n');
  if (activeWs && activeWs.readyState === 1) {
    try { activeWs.send(JSON.stringify({ type: 'cancel' })); } catch {}
  }
  setTimeout(() => process.exit(130), 300);
});

/**
 * Scripted mode (--json / --query, 2026-08-24): no banner, no spinner, no readline prompt.
 *  - --json emits every server message as one compact JSON line on stdout (jq-friendly) and
 *    reads chat input from piped stdin, line by line. Scriptable pipelines end on EOF.
 *  - --query "<text>" sends one message then exits with a real status code: 0 on a clean turn,
 *    1 if any error_output arrived or the connection failed — so CI can detect command failure.
 *  Risky-command / tool confirm prompts are auto-DECLINED: a scripted run must never silently
 *  approve anything (mirrors the server's own "never auto-approve" invariant).
 */
function runScriptedMode(ws, project, sessionId) {
  let sawError = false;
  const emitJson = (msg) => process.stdout.write(JSON.stringify({ type: msg.type, data: msg.data ?? null }) + '\n');
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (JSON_MODE) { emitJson(msg); return; }
    switch (msg.type) {
      case 'answer':
        if (msg.data) process.stdout.write(stripMarkdown(String(msg.data)) + '\n');
        break;
      case 'output':
        if (msg.data) process.stdout.write(String(msg.data));
        break;
      case 'warning':
        if (msg.data) process.stdout.write(String(msg.data) + '\n');
        break;
      case 'error_output':
        sawError = true;
        if (msg.data) process.stdout.write(String(msg.data) + '\n');
        break;
      case 'confirm_prompt':
      case 'tool_confirm_prompt':
        process.stdout.write(`(declined confirm for ${msg.command || msg.tool})\n`);
        ws.send(JSON.stringify({ type: 'confirm_response', payload: { token: msg.token, confirmed: false } }));
        break;
      case 'end':
        if (msg.data) process.stdout.write(String(msg.data) + '\n');
        break;
      default:
        break;
    }
  });
  ws.on('error', (err) => {
    process.stderr.write(`WebSocket error: ${err.message}\n`);
    process.exit(1);
  });
  ws.on('close', () => process.exit(sawError ? 1 : 0));
  const startScripted = () => {
    if (QUERY_INPUT || DRY_RUN_INPUT) {
      // --dry-run / --explain send the same execute message with the additive dryRun flag —
      // the server resolves + reports, never executes (see explainInput in connectionMatching.js).
      ws.send(JSON.stringify({
        type: 'execute',
        payload: { projectId: project.id, input: QUERY_INPUT || DRY_RUN_INPUT, sessionId, dryRun: !!DRY_RUN_INPUT },
      }));
      // One-shot exit: command turns end with an 'end' message; answer-only turns (pure
      // chit-chat / read-only intents) never send one — so ALSO exit on an 800ms quiet window
      // after the first real message, plus a 30s hard cap in case nothing ever comes back.
      // (The node:test harness docs explicitly reserve quiet-windows for answer-only turns.)
      let lastActivity = Date.now();
      let received = false;
      const quietTimer = setInterval(() => {
        if (received && Date.now() - lastActivity > 800) {
          clearInterval(quietTimer);
          try { ws.close(); } catch {}
        } else if (!received && Date.now() - lastActivity > 30000) {
          clearInterval(quietTimer);
          process.stderr.write('No response from the server within 30s.\n');
          try { ws.close(); } catch {}
        }
      }, 250);
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'end') {
          clearInterval(quietTimer);
          try { ws.close(); } catch {}
          return;
        }
        lastActivity = Date.now();
        received = true;
      });
    } else {
      // --json with piped stdin: chat line-by-line; EOF ends the session.
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const t = line.trim();
        if (!t) return;
        if (t === 'quit' || t === 'exit') { try { ws.close(); } catch {} return; }
        ws.send(JSON.stringify({ type: 'execute', payload: { projectId: project.id, input: t, sessionId } }));
      });
      rl.on('close', () => { try { ws.close(); } catch {} });
    }
  };
  // The socket may already be OPEN when runScriptedMode runs (a fast localhost handshake can
  // complete before listeners attach) — an 'open'-only attach would silently never fire.
  if (ws.readyState === 1) startScripted();
  else ws.once('open', startScripted);
}

async function main() {
  // Scripted runs (--json/--query/--export) keep stdout clean for piping — no banner, no
  // mascot, no picker chrome.
  if (!SCRIPTED) {
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
  }

  const spinner = !SCRIPTED && isTTY ? p.spinner() : null;
  if (spinner) {
    spinner.start(`Connecting to local server (ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1})...`);
  } else if (!SCRIPTED) {
    console.log(`${C.dim}Connecting (checking ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}, retrying for up to ${CONNECT_TIMEOUT_MS / 1000}s)...${C.reset}`);
  }

  const discovered = await discoverServer(
    spinner
      ? (elapsed) => spinner.message(`Still connecting (${elapsed}s elapsed, checking ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1})...`)
      : (SCRIPTED ? () => {} : null)
  );
  if (!discovered || discovered.projects.length === 0) {
    if (spinner) spinner.stop(chalk.red(`✖ Could not connect to a server on ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}`));
    else process.stderr.write(`${C.red}✖ Could not connect to a server on ports ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}${C.reset}\n`);
    process.stderr.write(`${C.yellow}  Make sure "npm run dev" is running (or still finishing startup), then try again.${C.reset}\n`);
    process.exit(1);
  }

  let { projects, port: PORT } = discovered;
  // Stop the spinner BEFORE the port-collision note so stdout writes don't interleave with the
  // still-animating spinner line (clack owns that line until .stop()).
  if (spinner) {
    spinner.stop(chalk.green(`✔ Connected to Local Engine on port ${PORT}`));
  } else if (!SCRIPTED) {
    console.log(`${C.green}✔ Connected.${C.reset}`);
  }
  if (PORT !== BASE_PORT && !SCRIPTED) {
    console.log(`${C.yellow}Note: server is on port ${PORT}, not ${BASE_PORT} (something else had ${BASE_PORT}).${C.reset}`);
  }

  // --export <id>: dump a session's full record to stdout (the same uncapped server formatter
  // the web downloads use) — scriptable, no chat involved.
  if (EXPORT_ID) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/api/sessions/${encodeURIComponent(EXPORT_ID)}/export?format=${EXPORT_FORMAT}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        process.stderr.write(`Export failed: HTTP ${res.status}\n`);
        process.exit(1);
      }
      process.stdout.write(await res.text());
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Export failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  // Phase 13 (2026-08-12): first-run onboarding mirror — when the server's profile hasn't
  // been completed yet, ask the same three questions the web wizard asks (name, default
  // workspace type, and a note about AI mode) and write through the same /api/profile path.
  // Never blocks: on any failure or non-TTY, silently skip (setupComplete stays false and the
  // web wizard will show instead).
  try {
    const profRes = await fetch(`http://${HOST}:${PORT}/api/profile`);
    const profData = await profRes.json();
    const userProfile = profData?.userProfile;
    if (!SCRIPTED && isTTY && userProfile && !userProfile.setupComplete) {
      console.log(`\n${C.bold}${C.bgBlue}  First run — a few quick questions  ${C.reset}\n`);
      const firstName = await p.text({
        message: 'What should we call you? (optional, Enter to skip)',
        placeholder: 'Your name',
        validate: (v) => (v.trim().length <= 60 ? undefined : 'Keep it under 60 characters.'),
      }).catch(() => undefined);
      const workspaceChoice = await p.select({
        message: 'Default workspace type? (change per project anytime)',
        options: [
          { value: 'dev', label: 'Developer — git, npm, run commands, diagnostics' },
          { value: 'general', label: 'General — files, notes, reminders, PDF tools (tools-first)' },
        ],
      }).catch(() => 'dev');
      const aiNote = await p.confirm({
        message: 'AI mode needs the free local app "Ollama" (optional). Got it?',
        initialValue: true,
      }).catch(() => true);
      await fetch(`http://${HOST}:${PORT}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userProfile: {
          name: (firstName || '').trim(),
          setupComplete: true,
          defaultWorkspaceType: workspaceChoice === 'general' ? 'general' : 'dev',
        } }),
      });
      console.log(`${C.green}✔ ${C.reset}Setup saved. Everything works without AI — flip the AI toggle in the web UI later to enable it.${C.reset}\n`);
      console.log(`${C.dim}Publishing/distributing this console? In the web chat type "how do i publish this" —${C.reset}`);
      console.log(`${C.dim}it covers npm publish, the desktop installer (cd desktop && npm run dist), and common install errors.${C.reset}\n`);
    }
  } catch {
    // profile unreachable — the web wizard will handle onboarding instead
  }

  // 2026-08-14: General-workspace chat. Interactive (TTY) runs always show the picker so a user
  // can choose "General workspace" and chat before picking a project; piped/CI runs keep the old
  // single-project auto-pick so scripted runs are not broken by an extra prompt.
  //
  // --resume/--last (2026-08-24): continue an existing session instead of starting a fresh one.
  // Sessions are locked to their project server-side, so the active project is resolved from
  // the session's own projectPath — sending the resumed sessionId with the WRONG projectId
  // would trip the session-lock check ("Session is locked to ...").
  let sessionId = null;
  let resumed = false;
  let project = null;
  if (RESUME_ID || WANT_LAST) {
    const sess = await pickResumeSession(PORT);
    if (!sess) {
      process.stderr.write(`${C.red}No session found for --resume${WANT_LAST ? ' (last)' : ` "${RESUME_ID}"`}.${C.reset}\n`);
      process.exit(1);
    }
    sessionId = sess.id;
    resumed = true;
    const sessPath = (sess.projectPath || sess.workspacePath || '').replace(/[\\/]+$/, '').toLowerCase();
    const matched = sessPath
      ? projects.find((pr) => pr.path.replace(/[\\/]+$/, '').toLowerCase() === sessPath)
      : null;
    project = matched || generalPseudoProject();
  }

  if (!project) project = findProjectFromArgs(projects);
  if (!project) {
    if (resumed || SCRIPTED) {
      project = generalPseudoProject();
    } else {
      project = isTTY
        ? await selectProject(projects)
        : (projects.length === 1 ? projects[0] : await selectProject(projects));
    }
  }

  console.log(`\n${C.dim}─── Project: ${C.green}${project.name}${C.dim} ───────${C.reset}`);
  if (resumed) {
    console.log(`${C.dim}Resuming session ${sessionId}${C.reset}`);
  }
  if (!SCRIPTED) {
    console.log(`${C.gray}Type a message, 'projects' to switch/rescan, or 'quit' to exit.${C.reset}\n`);
  }

  const ws = new WebSocket(`ws://${HOST}:${PORT}/stream`);
  activeWs = ws;
  // Scripted modes take over the socket immediately — runScriptedMode attaches its own open/
  // message/error/close handlers and never returns. MUST run before the LAN-display-name
  // fetch below: that await yields to the event loop, and a fast localhandshake can emit
  // 'open' during it — a listener attached after the fact would never fire (seen live
  // 2026-08-24: --query hung with readyState=1 and zero listeners).
  if (SCRIPTED) {
    runScriptedMode(ws, project, sessionId);
    return;
  }
  // Phase 19 (2026-08-12): LAN display-name attribution — when the server is bound to
  // 0.0.0.0 (HOST env), the CLI asks for a display name on connect exactly like the web UI.
  // When the server is 127.0.0.1-only the prompt is skipped entirely and attribution stays
  // "local" — single-user behavior completely unchanged (per the roadmap's explicit rule).
  try {
    const usersRes = await fetch(`http://${HOST}:${PORT}/api/connected-users`);
    const usersData = await usersRes.json();
    if (usersData?.lanBound && isTTY) {
      const name = await p.text({
        message: 'Other people are on this console (LAN mode). What should others see as your name?',
        placeholder: 'local',
        validate: (v) => (v.trim().length <= 40 ? undefined : 'Keep it under 40 characters.'),
      }).catch(() => null);
      if (name && name.trim()) {
        // The socket may already be OPEN when this runs (the fetch above yielded the event
        // loop long enough for a localhost handshake to complete) — an 'open'-only attach
        // would silently never fire. Guard both states.
        const sendName = () => ws.send(JSON.stringify({ type: 'set_display_name', payload: { name: name.trim() } }));
        if (ws.readyState === 1) sendName();
        else ws.once('open', sendName);
      }
    }
  } catch {
    // endpoint unreachable — attribution stays "local", no prompt
  }

  // Interactive path: the readline + WS-message renderer (see cliRenderer.js). The state bag
  // holds the mutable project/projects/port the renderer's 'projects' command updates.
  const state = { project, projects, port: PORT };
  const { handleMessage, setupReadline } = createCliRenderer({ ws, sessionId, state });

  // Same already-open guard as the scripted path (2026-08-24): the LAN-display-name fetch
  // above yields the event loop, and a fast localhost handshake can complete before this
  // attaches — an 'open'-only listener would never fire and the CLI would sit with no prompt.
  if (ws.readyState === 1) setupReadline();
  else ws.on('open', setupReadline);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(msg);
  });

  ws.on('close', () => {
    activeWs = null;
    console.log(`\n${C.yellow}Connection closed.${C.reset}`);
    process.exit(0);
  });

  ws.on('error', (err) => {
    activeWs = null;
    console.log(`\n${C.red}WebSocket error: ${err.message}${C.reset}`);
    process.exit(1);
  });
}

main();