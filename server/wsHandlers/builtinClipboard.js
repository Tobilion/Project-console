// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): trigger handlers for clipboard history + snippets.
// Clipboard WRITES go through the server-side OS clipboard (clipboardHistory.copyToOsClipboard)
// so the CLI (no browser to hand the event to) behaves identically to the web UI — the
// copy_to_clipboard WS event stays as a pure "here's what got copied, for display" notice.
import { readProfile } from '../routes/profileRoutes.js';
import {
  getClipboardHistory, clearClipboardHistory, removeClipboardItem, copyToOsClipboard,
} from '../clipboardHistory.js';
import { listSnippets, saveSnippet, getSnippet, deleteSnippet } from '../snippetStore.js';

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));

const TRUNCATE = 120;

function clipboardOffReply() {
  return 'Clipboard history is off — it is opt-in by design (your clipboard can hold passwords and tokens, so nothing polls it without your say-so). Enable it in Settings → Advanced → "Track clipboard history", or from chat: `notify me` style settings live in the profile modal.';
}

export const clipboardHandlers = {
  'clipboard.show': async (ws, action, input) => {
    if (!readProfile().clipboardHistory) {
      answer(ws, clipboardOffReply());
      return;
    }
    const history = getClipboardHistory();
    if (history.length === 0) {
      answer(ws, 'Clipboard history is empty so far — copy something and it shows up here (most recent first).');
      return;
    }
    const rows = history.map((h, i) => `${i + 1}. ${h.length > TRUNCATE ? h.slice(0, TRUNCATE) + '…' : h}`);
    answer(ws, `### Clipboard history (${history.length})\n\n${rows.join('\n')}\n\nCopy one again with \`copy clipboard item N\`.`);
  },

  'clipboard.copy_item': async (ws, action, input) => {
    const m = input.match(/copy\s+clipboard\s+item\s+(\d+)/i);
    const idx = m ? parseInt(m[1], 10) - 1 : -1;
    const history = getClipboardHistory();
    if (idx < 0 || idx >= history.length) {
      answer(ws, 'Which item? `show clipboard history` lists them — then `copy clipboard item N`.');
      return;
    }
    const text = history[idx];
    if (await copyToOsClipboard(text)) {
      ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: text }));
      answer(ws, `Copied clipboard item ${idx + 1} to the OS clipboard.`);
    } else {
      answer(ws, 'Could not write to the OS clipboard on this platform.');
    }
  },

  'clipboard.clear': async (ws) => {
    clearClipboardHistory();
    answer(ws, 'Clipboard history cleared.');
  },

  'clipboard.remove_item': async (ws, action, input) => {
    const m = input.match(/(?:remove|delete)\s+clipboard\s+item\s+(\d+)/i);
    const idx = m ? parseInt(m[1], 10) - 1 : -1;
    if (removeClipboardItem(idx)) {
      answer(ws, `Removed clipboard item ${idx + 1}.`);
    } else {
      answer(ws, 'Which item? `show clipboard history` lists them — then `remove clipboard item N`.');
    }
  },

  'snippet.save': async (ws, action, input) => {
    // Shapes: "save this as a snippet: <name>" / "save last output as snippet <name>" /
    // "save a snippet named <name>". There is no reliable "last output" cross-client store —
    // when the input carries no text, we ask for the snippet text instead of guessing.
    const m = input.match(/(?:as a snippet|as snippet|a snippet named|snippet)\s*:?\s*([\w-]+)/i);
    const name = m ? m[1] : '';
    if (!name) {
      answer(ws, 'Name the snippet: `save this as a snippet: welcome`.');
      return;
    }
    // For the CLI, "last output" isn't reliably retrievable here; the panel sends the text.
    const textPart = input.match(/:\s*([\s\S]+)$/);
    const text = textPart && textPart[1] && textPart[1].trim() !== name ? textPart[1].trim() : '';
    if (!text) {
      answer(ws, `What text should the snippet "${name}" hold? The Clipboard panel can save the current clipboard as a snippet too.`);
      return;
    }
    const result = saveSnippet(name, text);
    answer(ws, result.ok ? `📎 ${result.data}` : result.error);
  },

  'snippet.show': async (ws) => {
    const snippets = listSnippets();
    if (snippets.length === 0) {
      answer(ws, 'No snippets yet. Save one with `save this as a snippet: welcome`, or in the Clipboard panel.');
      return;
    }
    const rows = snippets.map((s) => `- **${s.name}**: ${s.text.length > TRUNCATE ? s.text.slice(0, TRUNCATE) + '…' : s.text}`);
    answer(ws, `### Snippets (${snippets.length})\n\n${rows.join('\n')}\n\nCopy one with \`copy snippet <name>\`.`);
  },

  'snippet.copy': async (ws, action, input) => {
    const m = input.match(/copy\s+snippet\s+([\w-]+)/i);
    const name = m ? m[1] : '';
    const snippet = getSnippet(name);
    if (!snippet) {
      answer(ws, `No snippet "${name}" — \`show my snippets\` lists them.`);
      return;
    }
    if (await copyToOsClipboard(snippet.text)) {
      ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: snippet.text }));
      answer(ws, `Copied snippet "${snippet.name}" to the OS clipboard.`);
    } else {
      answer(ws, 'Could not write to the OS clipboard on this platform.');
    }
  },

  'snippet.delete': async (ws, action, input) => {
    const m = input.match(/(?:delete|remove)\s+snippet\s+([\w-]+)/i);
    const name = m ? m[1] : '';
    const removed = deleteSnippet(name);
    answer(ws, removed ? `Deleted snippet "${removed.name}".` : `No snippet "${name}".`);
  },
};
