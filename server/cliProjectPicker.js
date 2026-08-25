// Project selection for the CLI (2026-08-24, split out of cli-client.js): the interactive
// arrow-key picker (@clack/prompts, TTY only), the numbered readline fallback (piped/CI
// stdin), and the --dir/--project argument shortcut. Nothing here connects to the server —
// it picks from whatever discovery already returned.

import readline from 'readline';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { C, isTTY, generalPseudoProject } from './cliOptions.js';

// TTY: interactive arrow-key select via @clack/prompts. Clack only accepts listed options, so
// the confirmed-live 2026-07-30 bug class ("anything that wasn't an in-range number silently
// resolved to projects[0] with zero feedback") can't happen here; Esc/Ctrl+C cancels cleanly.
// Non-TTY (piped/CI stdin): clack throws without a TTY, so fall back to the numbered readline
// picker, which keeps the exact re-ask behavior that fixed that 2026-07-30 report.
export function selectProject(projects) {
  return isTTY ? selectProjectInteractive(projects) : selectProjectLegacy(projects);
}

async function selectProjectInteractive(projects) {
  const selected = await p.select({
    message: 'Select a project to open in CLI session:',
    options: [
      { value: generalPseudoProject(), label: 'General workspace', hint: chalk.dim('chat + tools, no project selected') },
      ...projects.map((proj) => ({
        value: proj,
        label: proj.name,
        hint: chalk.dim(proj.path),
      })),
    ],
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
    console.log(`  ${C.bold}0${C.reset}. ${C.green}General workspace${C.reset}\n     ${C.dim}chat + tools, no project selected${C.reset}`);
    projects.forEach((p, i) => {
      console.log(`  ${C.bold}${i + 1}${C.reset}. ${C.green}${p.name}${C.reset}\n     ${C.dim}${p.path}${C.reset}`);
    });
    const ask = () => {
      rl.question(`\n${C.bold}Select project (0 = General, 1-${projects.length}):${C.reset} `, (answer) => {
        const idx = parseInt(answer.trim(), 10);
        if (Number.isInteger(idx) && idx >= 0 && idx <= projects.length) {
          rl.close();
          resolve(idx === 0 ? generalPseudoProject() : projects[idx - 1]);
        } else {
          console.log(`${C.red}"${answer.trim()}" isn't a number between 0 and ${projects.length} — try again.${C.reset}`);
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
export function findProjectFromArgs(projects) {
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
    // 2026-08-14: "general" maps to the reserved General workspace (no project) instead of a
    // discovered folder — e.g. `--project general` to chat before picking a project.
    if (target === 'general') return generalPseudoProject();
    const match = projects.find((p) => p.name.toLowerCase() === target || p.folderName?.toLowerCase() === target);
    if (match) return match;
    console.log(`${C.yellow}No discovered project matches name "${args[projIdx + 1]}" — falling back to the picker.${C.reset}`);
    return null;
  }
  return null;
}