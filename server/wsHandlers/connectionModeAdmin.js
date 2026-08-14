// Phase 1 workspaceType admin commands (UPGRADE-ROADMAP.md, 2026-08-11): `switch to developer
// mode` / `switch to general mode` / `what mode am I in`. Dispatched from connectionExecute.js
// in the same pre-matcher admin tier as notify/pack/schedule commands — returns true when it
// consumed the message. Writes the console.config.json `workspaceType` override (which always
// wins over the scan-time heuristic in projectScanHelpers.detectWorkspaceType), updates the
// in-memory project immediately, and lets the config file watcher confirm via its own rescan.
// No new intents or WS message types: everything answers through the existing `answer` bubble.
// Every branch sends a trailing `end` after its `answer` (2026-08-14 fix) — without it the web
// client's `commandPending` flag (cleared only on `end`, see wsMessageCases.ts) never resets,
// so the terminal shows a permanently spinning "Running..." after every mode switch.

import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../atomicWrite.js';
import { broadcast } from '../wsServer.js';
import { ensureConsoleConfigGitignored } from '../sessionMigration.js';

export async function handleModeCommand(ws, project, lowerInput) {
  const switchMatch = lowerInput.match(/^switch\s+to\s+(developer|general)\s+mode$/);
  if (switchMatch) {
    const mode = switchMatch[1] === 'general' ? 'general' : 'dev';
    const changed = setWorkspaceType(project, mode);
    ws.send(JSON.stringify({
      type: 'answer',
      data: changed
        ? `**${project.name}** is now in **${mode} mode** — dev-shaped suggestions/help are ${mode === 'dev' ? 'shown' : 'filtered out'} (commands still match exactly as before), and it's persisted in console.config.json so it survives rescans.`
        : `**${project.name}** is already in **${mode} mode**.`,
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  if (/^what\s+mode\s+am\s+i\s+in$/.test(lowerInput)) {
    const mode = project.workspaceType || 'dev';
    ws.send(JSON.stringify({
      type: 'answer',
      data: `**${project.name}** is in **${mode} mode**${mode === 'general' ? ' — dev-shaped suggestions/help are filtered out, but typing dev commands still works' : ''}.\n\nSwitch with \`switch to developer mode\` / \`switch to general mode\` — it's persisted in console.config.json.`,
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  return false;
}

function setWorkspaceType(project, mode) {
  if (project.workspaceType === mode) return false;

  const configPath = path.join(project.path, 'console.config.json');
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    config = {};
  }
  if (typeof config !== 'object' || Array.isArray(config)) config = {};

  config.workspaceType = mode;
  writeFileAtomicSync(configPath, JSON.stringify(config, null, 2));
  // Keep the console's own bookkeeping out of the user's commits: gitignore the file unless
  // they already track it deliberately (see ensureConsoleConfigGitignored — Matchday-Exchange
  // live session 2026-08-14). Fire-and-forget; a gitignore failure must not fail the switch.
  void ensureConsoleConfigGitignored(project.path).catch(() => {});

  // Update in-memory state immediately so this session's next suggestion/help call sees the
  // new mode; the config file watcher's rescan then re-derives the whole project object from
  // disk (same override wins there), so the two can't drift.
  project.workspaceType = mode;
  if (project.config) project.config.workspaceType = mode;
  broadcast({ type: 'project_updated', data: project });
  return true;
}
