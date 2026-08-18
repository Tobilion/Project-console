// Phase 7 (2026-08-11): auto-start admin commands (`auto-start this project [with "..." ]`,
// `enable/allow auto-start for ...`, `disable auto-start`, `list auto-start`, `run auto-start
// now`, `review auto-start`). Dispatched from connectionExecute.js's pre-matcher admin tier
// (same place as telemetry/pack/notify/health) — each returns true when it consumed the
// message. No new intents or WS message types: everything answers through the existing
// `answer` bubble. Persistence and the boot-time runner live in autoStartProjects.js.
//
// Every branch must send a trailing `end` after its answer: the frontend only clears its
// `commandPending` flag on `end` (wsMessageCases.ts), so an answer without one leaves the
// terminal stuck on "Running..." forever — the 2026-08-14 mode-switch bug class.

import { setAutoStart, removeAutoStart, getAutoStart, appendAutoStartLog, readAutoStartLog, runAutoStart } from '../autoStartProjects.js';
import { state } from '../state.js';
import { enqueueTask } from '../taskQueue.js';

const end = (ws) => ws.send(JSON.stringify({ type: 'end' }));

/** Case-insensitive project lookup by name/folder: exact first, then unique contains. */
function findProjectByName(name) {
  const lower = name.trim().toLowerCase();
  const exact = state.activeProjectsCache.find(
    (p) => p.name.toLowerCase() === lower || (p.folderName || '').toLowerCase() === lower,
  );
  if (exact) return exact;
  const partial = state.activeProjectsCache.filter(
    (p) => p.name.toLowerCase().includes(lower) || (p.folderName || '').toLowerCase().includes(lower),
  );
  return partial.length === 1 ? partial[0] : null;
}

export async function handleAutoStartCommand(ws, project, lowerInput) {
  if (/^run\s+auto[- ]?start(?:\s+this\s+project)?(?:\s+now)?$/.test(lowerInput)) {
    runNowForProject(ws, project);
    return true;
  }
  if (lowerInput === 'list auto-start' || lowerInput === 'show auto-start') {
    listAutoStart(ws);
    return true;
  }
  if (lowerInput === 'review auto-start') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Auto-start log\n\n${readAutoStartLog()}` }));
    end(ws);
    return true;
  }

  const enableThis = lowerInput.match(/^(?:enable|allow)\s+auto[- ]?start(?:\s+for\s+this\s+project)?(?:\s+with\s+"([^"]+)")?$/);
  if (enableThis) {
    enableFor(ws, project, enableThis[1] || 'run the site');
    return true;
  }
  const enableSelf = lowerInput.match(/^auto[- ]?start\s+this\s+project(?:\s+with\s+"([^"]+)")?$/);
  if (enableSelf) {
    enableFor(ws, project, enableSelf[1] || 'run the site');
    return true;
  }

  const disableThis = lowerInput.match(/^(?:disable|deny|stop)\s+auto[- ]?start(?:\s+for\s+this\s+project)?$/);
  if (disableThis) {
    if (removeAutoStart(project.id)) {
      ws.send(JSON.stringify({ type: 'answer', data: `Auto-start is OFF for **[${project.name}]** — it will not start at the next boot.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** was not set to auto-start. \`list auto-start\` shows what's configured.` }));
    }
    end(ws);
    return true;
  }

  const named = lowerInput.match(/^auto[- ]?start\s+(.+)$/);
  if (named) {
    const target = findProjectByName(named[1]);
    if (!target) {
      ws.send(JSON.stringify({ type: 'answer', data: `No scanned project matches "${named[1]}".\n\n${scannedProjectsText()}` }));
    } else {
      enableFor(ws, target, 'run the site');
    }
    end(ws);
    return true;
  }
  const namedDisable = lowerInput.match(/^(?:disable|deny|stop)\s+auto[- ]?start\s+for\s+(.+)$/);
  if (namedDisable) {
    const target = findProjectByName(namedDisable[1]);
    if (!target) {
      ws.send(JSON.stringify({ type: 'answer', data: `No scanned project matches "${namedDisable[1]}".\n\n${scannedProjectsText()}` }));
    } else if (removeAutoStart(target.id)) {
      ws.send(JSON.stringify({ type: 'answer', data: `Auto-start is OFF for **[${target.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${target.name}]** was not set to auto-start.` }));
    }
    end(ws);
    return true;
  }

  return false;
}

function enableFor(ws, project, command) {
  setAutoStart(project.id, project.name, command);
  ws.send(JSON.stringify({
    type: 'answer',
    data: `Auto-start is ON for **[${project.name}]** — every console boot will run \`${command}\` once the site is not already answering.\n` +
      `Manage it with \`list auto-start\`, \`disable auto-start\`, or run it right now with \`run auto-start now\`.`,
  }));
  appendAutoStartLog(`${project.name}: auto-start ENABLED ("${command}")`);
  end(ws);
}

function listAutoStart(ws) {
  const entries = getAutoStart();
  const ids = Object.keys(entries);
  if (ids.length === 0) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `No projects are set to auto-start. Try \`auto-start this project\` (or \`auto-start <name>\` for another project).`,
    }));
    end(ws);
    return;
  }
  const lines = ids.map((id) => {
    const e = entries[id];
    const scanned = state.activeProjectsCache.some((p) => p.id === id) ? 'scanned' : 'NOT scanned — will be skipped';
    return `  - **${e.projectName}** — \`${e.command}\` (${scanned})`;
  });
  ws.send(JSON.stringify({ type: 'answer', data: `### Auto-start\n\n${lines.join('\n')}\n\n\`run auto-start now\` starts them immediately; \`review auto-start\` shows the boot-run log.` }));
  end(ws);
}

function runNowForProject(ws, project) {
  const entry = getAutoStart()[project.id];
  if (!entry) {
    ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** is not set to auto-start — \`auto-start this project\` first.` }));
    end(ws);
    return;
  }
  // Deliberately bypasses initAutoStart's boot stagger: a manual "now" is one project only.
  enqueueTask(project.id, 'auto-start', () => runAutoStart(project, entry));
  ws.send(JSON.stringify({ type: 'answer', data: `Running auto-start for **[${project.name}]** (\`${entry.command}\`) — the result lands here when it finishes.` }));
  end(ws);
}

function scannedProjectsText() {
  const names = state.activeProjectsCache.map((p) => p.name).join(', ');
  return `Scanned projects: ${names || '(none)'}`;
}