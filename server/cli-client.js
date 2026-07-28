import WebSocket from 'ws';
import readline from 'readline';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', blue: '\x1b[34m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m',
  bgBlue: '\x1b[44m',
};

function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/### /g, '');
}

async function fetchProjects() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/projects`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.projects || [];
  } catch { return null; }
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

  const projects = await fetchProjects();
  if (!projects || projects.length === 0) {
    console.log(`${C.red}✖ Could not connect to server at http://${HOST}:${PORT}${C.reset}`);
    console.log(`${C.yellow}  Make sure the server is running first.${C.reset}`);
    process.exit(1);
  }

  const project = projects.length === 1 ? projects[0] : await selectProject(projects);

  console.log(`\n${C.dim}─── Project: ${C.green}${project.name}${C.dim} ───────${C.reset}`);
  console.log(`${C.gray}Type a message or 'quit' to exit.${C.reset}\n`);

  const ws = new WebSocket(`ws://${HOST}:${PORT}/stream`);
  let rl;
  let waitingForInput = false;
  let pendingConfirm = null;    // { resolve, question }

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
      // Normal message
      if (trimmed.toLowerCase() === 'quit' || trimmed.toLowerCase() === 'exit') {
        console.log(`\n${C.yellow}Bye!${C.reset}`);
        ws.close();
        process.exit(0);
      }
      waitingForInput = false;
      rl.pause();
      ws.send(JSON.stringify({
        type: 'execute',
        payload: { projectId: project.id, input: trimmed, sessionId: null },
      }));
    });
  }

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
        if (msg.data) process.stdout.write(`${C.reset}${stripMarkdown(msg.data)}`);
        break;
      case 'error_output':
        if (msg.data) process.stdout.write(`${C.red}${msg.data}${C.reset}`);
        break;
      case 'output':
        if (msg.data) process.stdout.write(`${C.green}${msg.data}${C.reset}`);
        break;
      case 'start':
        if (msg.data) process.stdout.write(`${C.dim}${msg.data}${C.reset}`);
        break;
      case 'stream_start':
        process.stdout.write(C.reset);
        break;
      case 'token':
        if (msg.data) process.stdout.write(msg.data);
        break;
      case 'stream_end':
        process.stdout.write('\n');
        break;
      case 'end':
        process.stdout.write(`\n`);
        if (!waitingForInput && rl) { waitingForInput = true; rl.prompt(true); }
        break;
      case 'clear_console':
        console.clear();
        break;
      case 'confirm_prompt':
        questionAsync(`Risky command "${msg.command}"? (y/N):`).then((ans) => {
          ws.send(JSON.stringify({ type: 'confirm_response', payload: { token: msg.token, confirmed: ans === 'y' || ans === 'yes' } }));
        });
        break;
      case 'tool_confirm_prompt':
        questionAsync(`AI wants to run ${C.bold}${msg.tool}${C.reset}${C.yellow} with ${JSON.stringify(msg.args)} — approve? (y/N):`).then((ans) => {
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
