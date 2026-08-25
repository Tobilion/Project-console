import { TOOL_PANEL_INTENTS } from '../intents/toolPanelIntents.js';
import { getToolPanel } from '../toolPanelRegistry.js';
import { getSchedules } from '../schedules/scheduleStore.js';

// Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): chat-side openers for the shared interactive tool
// panels. When a matched intent carries an `opensPanel` tag (see toolPanelIntents.js), the
// answer travels with an additive `openPanel` field on the same `answer` payload — no new WS
// message type, plain-text answers unchanged. The CLI deliberately ignores `openPanel`
// (see the explicit comment in cli-client.js's 'answer' case): the reply text below is the
// CLI-usable half of the contract, naming the chat command the terminal user types instead of
// clicking a card.
export const toolsHandlers = {
  'system.tools.open_calculator': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} is an interactive web-UI panel (header → Tools, or type this again). From chat — including the CLI — the same feature works as a plain command: try \`calculate 15% of 80\`.`,
      openPanel: panel.id,
    }));
    ws.send(JSON.stringify({ type: 'suggestions', data: ['calculate 15% of 80', 'calculate 340 / 4'] }));
  },
  'system.tools.open_pdf_tools': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI where you pick PDFs and an operation (merge / split / extract / watermark). From chat — including the CLI — the same operations work as plain trigger commands: \`merge these pdfs into combined.pdf\` / \`split report.pdf at page 5\` / \`extract text from report.pdf\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_reminders': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    const reminders = getSchedules().filter((s) => s.kind === 'reminder');
    const listText = reminders.length
      ? reminders.map((s, i) => `${i + 1}. **${s.id}** — ${s.text} (${s.label})`).join('\n')
      : '(none set)';
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI list (Today / Upcoming / All). From chat — including the CLI — the same features work as plain commands.\n\nCurrent reminders:\n${listText}\n\nCreate: \`remind me tomorrow at 9am to renew my license\` · List: \`list my reminders\` · Cancel: \`cancel reminder <id>\``,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_file_tools': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI surface (project file browser + search + duplicate finder + tidy preview). From chat — including the CLI — the same features work as plain commands: \`find files matching X\` / \`tidy this folder\` / \`find duplicate files\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_notes': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI feed (add / read back / search). From chat — including the CLI — the same features work as plain commands: \`note: buy milk\` / \`show my notes\` / \`search my notes for wifi\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_csv_tools': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI grid (pick a CSV + column, run sum/average/count/filter). From chat — including the CLI — the same features work as plain commands: \`sum column sales in data.csv\` / \`filter data.csv where price greater than 50\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_clipboard': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI list (history + saved snippets). From chat — including the CLI — the same features work as plain commands: \`show clipboard history\` / \`copy clipboard item 2\` / \`save this as a snippet: welcome\` / \`copy snippet welcome\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_backup': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI list (zip a folder, browse past backups). From chat — including the CLI — the same features work as plain commands: \`backup this folder\` / \`list backups\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_notifications': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI list of watch rules + channels. From chat — including the CLI — the same features work as plain commands: \`notify me when files change in <folder>\` / \`notify me if <folder> hasn't changed in 7 days\` / \`list watched folders\` / \`stop watching <folder>\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_documents': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI search over the project's PDFs, Word docs and notes (offline semantic index). From chat — including the CLI — the same feature works as a plain command: \`search my documents for pricing\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_marketplace': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI grid of packs from a registry you configure. From chat — including the CLI — the same features work as plain commands: \`set pack registry <url>\` / \`browse pack registry\` / \`install pack <name> from registry\`.`,
      openPanel: panel.id,
    }));
  },
  'system.tools.open_repo_map': async (ws, action) => {
    const panel = getToolPanel(TOOL_PANEL_INTENTS[action].opensPanel);
    if (!panel) return false;
    ws.send(JSON.stringify({
      type: 'answer',
      data: `The ${panel.name} panel is an interactive web-UI view of the whole-project symbol map (every file's top-level exports/functions/classes, imports, and reverse dependencies — the same structure the AI system prompt receives). From chat — including the CLI — the same information is available as plain commands: \`show the project structure\` / \`show me the stack\` / \`what routes does this app expose\`.`,
      openPanel: panel.id,
    }));
  },
};