import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildHelpMessage } from '../builtinHelp.js';
import { injectContext } from '../../contextInjector.js';
import { lookupCommandDocs, resolveShell } from '../../consoleCommandDocs.js';

/**
 * system.chit_chat.* guidance/knowledge handlers (extracted verbatim from builtinChitChat.js) —
 * the help/explain/how-do-i/list-commands family plus the two exported helpers the push-target
 * interceptor reuses (answerDocMatches/pushTargetQuestion must stay importable from
 * ./builtinChitChat.js, which this module re-exports through the barrel).
 */
export const docHandlers = {
  'system.chit_chat.help': async (ws, action, input, project, sessionContext) => {
    ws.send(JSON.stringify({ type: 'answer', data: buildHelpMessage(project, sessionContext) }));
  },

  'system.chit_chat.explain_followup': async (ws, action, input, project, sessionContext) => {
    if (sessionContext.lastTriggeredEntry) {
      const last = sessionContext.lastTriggeredEntry;
      const detailText = last.response || last.details || `Last triggered action was "${last.triggers?.[0] || 'command'}" (\`${last.action || 'answer'}\`).`;
      const ctx = injectContext(input, action, project.codebaseIndex);
      let msg = `### Detailed Follow-up regarding "${last.triggers?.[0]}":\n\n${detailText}`;
      if (ctx) msg += `\n\n${ctx}`;
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    } else {
      const detailEntry = project.config.entries?.find((e) => e.type === 'answer' && e.triggers?.some((t) => t.includes('explain') || t.includes('detail') || t.includes('architecture')));
      let detailText = `### Deep Dive [${project.name}]\n\n**Location:** \`${project.path}\``;
      if (detailEntry) {
        detailText = detailEntry.response;
      } else if (project.contextFiles && project.contextFiles.length > 0) {
        const mainDoc = project.contextFiles[0];
        detailText = `### Deep Dive from ${mainDoc.filename}\n\n${mainDoc.content.substring(0, 1500)}...`;
      }
      const idx = project.codebaseIndex;
      if (idx?.directoryTree?.length) {
        const treeLines = idx.directoryTree.slice(0, 20).map((d) => `  ▸ ${d}`).join('\n');
        detailText += `\n\n**Directory Structure:**\n${treeLines}`;
        if (idx.directoryTree.length > 20) detailText += `\n  ... and ${idx.directoryTree.length - 20} more`;
      }
      if (idx?.fileSample?.length) {
        const sample = idx.fileSample.slice(0, 10).map((f) => `  ▸ ${f}`).join('\n');
        detailText += `\n\n**Key Files:**\n${sample}`;
      }
      const ctx = injectContext(input, action, project.codebaseIndex);
      if (ctx) detailText += `\n\n${ctx}`;
      ws.send(JSON.stringify({ type: 'answer', data: detailText }));
    }
  },

  'system.chit_chat.how_do_i': async (ws, action, input, project, sessionContext) => {
    // Phase 1 (2026-08-10): guidance answers from the consoleCommandDocs.js catalog —
    // deliberately no smartChitchatReply (the answer is deterministic reference text, no model
    // call needed even with AI mode on). Side-effect-free: never runs the referenced command.
    // Phase 9 (2026-08-11): entries now carry the real `shell` command and example `phrases`;
    // the answer renders both, and clickable suggestion chips let the user run it — chips are
    // clicks, nothing auto-runs, so this stays side-effect-free.
    // 2026-08-26: bare "how do i push" (no target) dead-ended with "no documented answer" —
    // the catalog has no bare-'push' keyword, and the three push paths (git / npm / desktop
    // build) are genuinely different flows, so the question now asks which target and arms
    // sessionContext.pendingPushTarget for the reply (consumed in connectionInterceptors.js).
    const PUSH_PRODUCTION_RE = /^how\s+(?:(?:do|can|would|could|should)\s+i|to)\s+push\s+to\s+(?:production|prod|live)$/i;
    const PUSH_TARGET_RE = /^how\s+(?:(?:do|can|would|could|should)\s+i|to)\s+push(?:\s+(?:this|it|my\s+(?:changes?|code)|the\s+code))?$/i;
    // Question-phrasing + typo normalization (2026-08-26 live crosscheck): "how can i push my
    // code", "whats the best way to push" and "how do i pus" all misfired (deploy confirm,
    // dead-end, dead-end). The canonical forms below feed ONLY the branch tests — the generic
    // catalog path still sees the raw input. `pus` is word-boundaried so "pusher" never
    // normalizes.
    const pushStripped = input
      .trim()
      .replace(/[?!.]+$/g, '')
      .replace(/^what(?:'s|s| is) the (?:best|easiest) way to\s*/i, 'how do i ')
      .replace(/\bpus\w*\b/gi, 'push');
    if (PUSH_PRODUCTION_RE.test(pushStripped)) {
      await answerDocMatches(ws, 'push to github', project);
      return;
    }
    if (PUSH_TARGET_RE.test(pushStripped)) {
      sessionContext.pendingPushTarget = { projectId: project.id };
      ws.send(JSON.stringify({ type: 'answer', data: pushTargetQuestion().text }));
      ws.send(JSON.stringify({ type: 'suggestions', data: pushTargetQuestion().chips }));
      return;
    }
    // 2026-08-26 live crosscheck: unspecified frustration/why questions ("why isnt this
    // working", "what went wrong", "i give up") used to fall onto executing intents (deploy
    // confirm, run_tests) or the overview. They pin here; the console cannot know what
    // broke from "this" alone, so the honest reply is a troubleshooting prompt — never a
    // canned cheer, never an action. Specific why-shapes ("why is the server down") keep
    // their read-only diagnostic intents and never reach this branch.
    const FRUSTRATION_RE = /^(?:why\s+(?:is|isn'?t|isnt|are|aren'?t|arent|did|didn'?t|didnt|does|doesn'?t|doesnt|do|don'?t|dont|was|were|won'?t|wont|can'?t|cant|has|have|had|couldn'?t|couldnt|wouldn'?t|wouldnt)\s+(?:this|that|it|everything|nothing|anything|the\s+thing)\b|what\s+(?:went\s+wrong|happened|is\s+wrong)|(?:whats|what's)\s+wrong|this\s+is\s+broken|it'?s\s+broken|nothing\s+works|i\s+give\s+up|just\s+fix\s+it|fix\s+it\s+already)/i;
    if (FRUSTRATION_RE.test(input)) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `I can't tell what's broken from that alone — tell me what you were trying to do (e.g. "run the tests", "push my changes") or paste the error you saw, and I'll dig in. If something I ran failed, the error is usually in the last output block above.`,
      }));
      return;
    }
    await answerDocMatches(ws, input, project);
  },

  'system.chit_chat.list_commands': async (ws) => {
    // Phase 10 (2026-08-12): the full catalog as plain text — the CLI's equivalent of the web
    // Command Reference tab. Same data as how_do_i's lookup, no filtering: every entry, one
    // line each (phrase -> shell command when one exists). No new WS type — a normal answer.
    const { COMMAND_DOCS } = await import('../../consoleCommandDocs.js');
    const lines = COMMAND_DOCS.map((e) => {
      const shell = resolveShell(e) ? ` → \`${resolveShell(e)}\`` : '';
      return `- \`${e.command}\`${shell}`;
    });
    ws.send(JSON.stringify({
      type: 'answer',
      data: `### Command reference (${COMMAND_DOCS.length} entries)\n\n${lines.join('\n')}\n\nAsk "how do i <thing>" about any of them for the full explanation.`,
    }));
  },
};

// Shared how-do-i answer renderer (2026-08-26): the lookup + markdown answer + suggestion
// chips, extracted so the push-target interceptor (connectionInterceptors.js) renders the
// SAME catalog entries the chat would — one code path, identical answers everywhere.
// Side-effect-free: never runs the referenced command. `suffix` is appended to the answer
// (used by the interceptor to continue the conversation: "Any other questions?").
export async function answerDocMatches(ws, input, project, suffix = '') {
  const matches = lookupCommandDocs(input);
  if (matches.length === 0) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `I don't have a documented answer for that yet. Type "help" for the full command reference, or try one of these — "how do i schedule a backup", "how do i export this chat", "how do i change the theme".`,
    }));
    return;
  }
  const lines = matches.map((m, i) => {
    let out = `  ${i + 1}. **\`${m.command}\`** — ${m.explain}`;
    const shell = resolveShell(m);
    if (shell) out += `\n     - Command: \`${shell}\``;
    if (m.phrases?.length) out += `\n     - Try saying: "${m.phrases.join('", "')}"`;
    // Entries with a `doc` field pull their full step-by-step body from a markdown file
    // next to the server source (staged into the packaged app, so the answer is identical
    // everywhere). The file — not this catalog entry — is the maintained source of truth;
    // when it is missing for any reason the static explain above stays the fallback.
    if (m.doc) {
      try {
        const docPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', m.doc);
        out += `\n\n${fs.readFileSync(docPath, 'utf-8').trim()}`;
      } catch {
        // doc file unavailable — the catalog's explain already covers the summary
      }
    }
    return out;
  });
  ws.send(JSON.stringify({
    type: 'answer',
    data: `Here's how, for **[${project.name}]**:\n\n${lines.join('\n')}\n\nType "help" for the full command reference, or ask "how do i <thing>" about anything else.${suffix}`,
  }));
  // Suggestion chips: a runnable shell command for direct execution (npm/npx/python/node
  // shapes — the frontend sends those through the direct-command path), otherwise the chat
  // phrasing (routes through the normal matcher + confirm flows). Deduped, up to three.
  const chips = [];
  for (const m of matches) {
    const shell = resolveShell(m);
    const chip = shell && /^(npm|npx|python|node)\s/.test(shell) ? shell : m.command;
    if (!chips.includes(chip)) chips.push(chip);
    if (chips.length === 3) break;
  }
  ws.send(JSON.stringify({ type: 'suggestions', data: chips }));
}

// The three-way push-target question (2026-08-26): the disambiguation asked by how_do_i for
// bare "how do i push" and re-asked by the interceptor after each answer.
export function pushTargetQuestion() {
  return {
    text: 'Where do you want to push — **npm** (publish a package), **git** (push a repo to GitHub), or **the app build** (build the desktop app)?',
    chips: ['npm', 'git', 'app build'],
  };
}