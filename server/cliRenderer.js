// Interactive terminal renderer for the CLI chat (2026-08-24, split out of cli-client.js).
//
// Everything the interactive path does with the terminal lives here: the readline prompt,
// the confirm/question flows, the numbered chip options, and the WS message switch. The state
// that used to be main()'s closure variables (rl, atLineStart, pendingOptions, confirmPending,
// pendingConfirm, waitingForInput) is the factory's closure — behavior is a pure move.
//
// NOTE: scripts/checkWsMessageCases.ts parses the `case 'x':` labels from SOURCE (cli-client.js
// can't be imported — it executes main() on load). It scans this module AND cli-client.js, so a
// new WS message type must still get its case here (rendered or explicit no-op) or the CLI-parity
// harness fails.
//
// main() wires this via `const { handleMessage, setupReadline } = createCliRenderer(...)` —
// keep the destructure shape stable, the harness checks the readyState guard text around
// `setupReadline()` in cli-client.js.

import readline from 'readline';
import { C } from './cliOptions.js';
import { stripMarkdown, tryFetchProjects } from './cliDiscovery.js';
import { selectProject } from './cliProjectPicker.js';

export function createCliRenderer({ ws, sessionId, state }) {
  let rl = null;
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
    const result = await tryFetchProjects(state.port);
    if (result && result.projects.length > 0) state.projects = result.projects;
    return state.projects;
  }

  async function switchProject() {
    await refreshProjects();
    const next = await selectProject(state.projects);
    state.project = next;
    console.log(`\n${C.dim}─── Project: ${C.green}${state.project.name}${C.dim} ───────${C.reset}\n`);
    atLineStart = true;
  }

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

  let pendingConfirm = null;    // { resolve, question }

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
            ws.send(JSON.stringify({ type: 'execute', payload: { projectId: state.project.id, input: chosen.text, sessionId } }));
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
        payload: { projectId: state.project.id, input: trimmed, sessionId },
      }));
    });
  }

  function handleMessage(msg) {
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
        // The web renders 'end' with an optional summary (msg.data) — print it so the CLI
        // shows the same command summary the web shows (audit Phase 5).
        if (msg.data) writeRaw(`${msg.data}\n`);
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
      case 'copy_to_clipboard': break; // display notice only since Phase 8 — the server-side OS clipboard write happens inside the intent handler, so the CLI copies for real without a browser
      case 'dashboard_update': break; // dashboard refresh signal — no dashboard in the CLI
      case 'processes_update': break; // dock refresh signal — no dock in the CLI
      case 'semantic_matcher_progress': break; // boot-time embedding progress — the CLI connects after boot
      case 'display_name_set': break; // name-claim ack — the CLI already knows the name it sent
      default:
        break;
    }
  }

  return { handleMessage, setupReadline };
}