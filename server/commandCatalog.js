// commandCatalog.js — the FULL command catalog (2026-08-13): the hand-curated how_do_i docs
// (consoleCommandDocs.js) plus an auto-generated entry for every dispatchable chat intent.
// Before this, only ~60 curated features were documented while the matcher understood 90+
// intents — the Ctrl+K deck and the Command Reference tab now enumerate "all possible
// commands" from this single server-side module, and a committed harness (checkDocsSync.js)
// asserts every eligible BUILTIN_INTENTS member is represented so a new intent can never
// silently miss the docs again.

import { INTENTS } from './intentsData.js';
import { BUILTIN_INTENTS } from './intentRegistry.js';
import { PURE_CHITCHAT_INTENTS } from './intentTrust.js';
import { getToolPanel } from './toolPanelRegistry.js';
import { COMMAND_DOCS } from './consoleCommandDocs.js';

// Zero-argument canned small talk stays out of the command catalog (deck + reference) — the
// user asked for real commands. time/date/calculate are utility commands, not small talk, so
// they stay in even though PURE_CHITCHAT_INTENTS guards them for other purposes.
export const CANNED_CHITCHAT_INTENTS = new Set(
  [...PURE_CHITCHAT_INTENTS].filter(
    (id) => !['system.chit_chat.time', 'system.chit_chat.date', 'system.chit_chat.calculate'].includes(id),
  ),
);

// Group label from the intent id's prefix — checked before opensPanel so panel-tagged intents
// can keep their panel's name as the group. Explicit table, not regex gymnastics: a prefix
// that maps to nothing falls into 'Other' rather than guessing.
export function intentGroup(id) {
  if (id.startsWith('git_')) return 'Git';
  if (id.startsWith('project.diagnostics.')) return 'Diagnostics';
  if (id.startsWith('project.code.')) return 'Code search';
  if (id.startsWith('project.knowledge.')) return 'Project knowledge';
  if (id.startsWith('project.context.')) return 'Project info';
  if (id.startsWith('project.action.')) return 'Project actions';
  if (id.startsWith('project.workflow.')) return 'Workflow';
  if (id.startsWith('general.files.')) return 'Files & editor';
  if (id.startsWith('pdf.')) return 'PDF';
  if (id.startsWith('csv.')) return 'Spreadsheets';
  if (id.startsWith('system.notes.')) return 'Notes & memory';
  if (id.startsWith('clipboard.') || id.startsWith('snippet.')) return 'Clipboard & snippets';
  if (id.startsWith('system.reminders.')) return 'Reminders';
  if (id.startsWith('backup.')) return 'Backup';
  if (id.startsWith('system.tools.')) return 'Tools';
  if (id.startsWith('system.knowledge.')) return 'Knowledge';
  if (id.startsWith('system.monitoring.')) return 'Monitoring';
  if (id.startsWith('system.chit_chat.')) return 'Chat & utilities';
  if (id === 'run_project' || id === 'run_tests' || id.startsWith('npm_') || id.startsWith('file_')) {
    return 'Run & files';
  }
  return 'Other';
}

/** How many example phrases a generated entry carries — enough to search and learn from,
 *  small enough to keep the payload light (the full list still lives in server/intents/). */
export const INTENT_PHRASE_CAP = 8;

/**
 * The full command catalog: `curated` (hand-written COMMAND_DOCS, unchanged) plus `intents`
 * (one generated entry per dispatchable intent: first example as the command, capped phrase
 * list, panel tag, category group). Deterministic order — grouped, then alphabetical.
 */
export function buildCommandCatalog() {
  const intents = [];
  for (const id of BUILTIN_INTENTS) {
    if (CANNED_CHITCHAT_INTENTS.has(id)) continue;
    const data = INTENTS[id];
    if (!data?.examples?.length) continue;
    const panel = data.opensPanel ? getToolPanel(data.opensPanel) : null;
    intents.push({
      intentId: id,
      command: data.examples[0],
      phrases: data.examples.slice(0, INTENT_PHRASE_CAP),
      opensPanel: data.opensPanel || null,
      group: panel ? panel.name : intentGroup(id),
      explain: panel
        ? `Chat command for the ${panel.name} panel — sends one of the phrasings below.`
        : `Chat command — send one of the phrasings below (risky actions confirm first).`,
    });
  }
  intents.sort((a, b) => a.group.localeCompare(b.group) || a.command.localeCompare(b.command));
  return { curated: COMMAND_DOCS, intents };
}
