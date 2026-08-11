import { TOOL_PANEL_INTENTS } from '../intents/toolPanelIntents.js';
import { getToolPanel } from '../toolPanelRegistry.js';

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
      data: `The ${panel.name} is a web-UI panel where you drop a file and pick an operation — its tools are filled in during a later update. There is no terminal-native equivalent of a file-drop grid, so the PDF operations keep working as plain chat trigger commands once they ship.`,
      openPanel: panel.id,
    }));
  },
};