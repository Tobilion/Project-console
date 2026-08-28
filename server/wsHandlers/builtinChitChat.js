import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performUndo, isGitRepo, pushCommandWithUpstream } from '../gitSafety.js';
import { executeCommand } from '../executor.js';
import { pendingConfirmations, state } from '../state.js';
import { injectContext } from '../contextInjector.js';
import { pickRandom, chatReplyPool, smartChitchatReply, enrichWithIndex, extractCommentMessage, assertSafeCommitMessage } from './builtinHelpers.js';
import { buildLiveStateLine, buildMemoryBlock } from './builtinLiveState.js';
import { buildHelpMessage } from './builtinHelp.js';
import { evaluateArithmetic, formatValue, convertUnits, percentageQuery } from '../mathEval.js';
import { lookupCommandDocs, resolveShell } from '../consoleCommandDocs.js';
import { aiDockInstruction } from '../aiDockHints.js';

/**
 * system.chit_chat.* handlers (Phase 10 step 3, extracted verbatim from builtinIntents.js).
 * Full (ws, action, input, project, sessionContext) signature for uniform dispatch.
 * `undo` is also reachable via the bare `'undo'` alias — the dispatcher maps it onto this
 * handler (key 'system.chit_chat.undo') before calling.
 */
export const chitChatHandlers = {
  'system.chit_chat.undo': async (ws, action, input, project, sessionContext) => {
    const undoResult = await performUndo(project.path);
    if (undoResult.success) {
      ws.send(JSON.stringify({ type: 'answer', data: undoResult.message }));
    } else {
      // When the last commit isn't a console checkpoint, point the user at history/logs
      // so they can see what *is* revertible (the guard itself is correct — we just add UX).
      const hint = undoResult.message.includes('not a Console checkpoint')
        ? '\n\nTip: Try `show history` to see recent console actions, or `git log --oneline -5` to see commits. Only `console-checkpoint:` commits can be undone this way.'
        : '';
      ws.send(JSON.stringify({ type: 'error_output', data: undoResult.message + hint + '\n' }));
    }
  },

  'system.chit_chat.greeting': async (ws, action, input, project, sessionContext) => {
    const ctx = injectContext(input, action, project.codebaseIndex);
    const hour = new Date().getHours();
    const timeOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const opener = pickRandom(chatReplyPool('greeting', project, [
      `Good ${timeOfDay}! Local Console is active for [${project.name}].`,
      `Hey there — [${project.name}] is loaded and ready.`,
      `Hi! Ready to help with [${project.name}].`,
      `Hey! [${project.name}] is up. What are we working on?`,
      `Good to see you — [${project.name}] is live.`,
      `Welcome back to [${project.name}] — ${timeOfDay} edition.`,
      `${timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1)}! [${project.name}] is standing by.`,
      `Hi again — [${project.name}] is still here.`,
    ]));
    let responseText = `${opener}\n\n` +
      `• Location: ${project.path}\n` +
      `• Type "help" to list all commands & topics.\n` +
      `• Type "overview" for architecture overview.\n` +
      `• Type "explain more" for deep details.`;
    responseText += await buildMemoryBlock(project);
    responseText += await buildLiveStateLine(project);
    if (ctx) responseText += `\n\n${ctx}`;
    const smartGreeting = await smartChitchatReply(project, sessionContext, input);
    ws.send(JSON.stringify({ type: 'answer', data: smartGreeting || responseText }));
  },

  'system.chit_chat.status': async (ws, action, input, project, sessionContext) => {
    const ctx = injectContext(input, action, project.codebaseIndex);
    const opener = pickRandom(chatReplyPool('status', project, [
      `I'm running and ready on **[${project.name}]**. What do you need?`,
      `All good here — standing by on **[${project.name}]**.`,
      `Still here, still watching **[${project.name}]**. What's next?`,
      `Running smoothly on **[${project.name}]** — what can I do?`,
      `Yep, I'm listening — **[${project.name}]** is active.`,
    ]));
    let statusMsg = enrichWithIndex(opener, project.codebaseIndex);
    statusMsg += await buildLiveStateLine(project);
    if (ctx) statusMsg += `\n\n${ctx}`;
    const smartStatus = await smartChitchatReply(project, sessionContext, input);
    ws.send(JSON.stringify({ type: 'answer', data: smartStatus || statusMsg }));
  },

  'system.chit_chat.gratitude': async (ws, action, input, project, sessionContext) => {
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom(chatReplyPool('gratitude', project, [
        `You're welcome! Ready for your next command on [${project.name}].`,
        `Anytime! What's next for [${project.name}]?`,
        `Happy to help — let me know what's next on [${project.name}].`,
        `No problem at all. What else can I do on [${project.name}]?`,
        `Glad that helped. Ready when you are.`,
      ])),
    }));
  },

  'system.chit_chat.farewell': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-07-30, requested directly — "richer canned chit-chat"): the chit-chat set
    // had no goodbye at all before, so "bye"/"see you later" either fell through to a no-match
    // fallback or got misclassified onto something else entirely.
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom(chatReplyPool('farewell', project, [
        `See you later! [${project.name}] will be here when you're back.`,
        `Bye for now — come back anytime.`,
        `Catch you later. [${project.name}] stays as you left it.`,
        `Goodbye! Nothing lost — just say hi when you're back.`,
        `Take care! I'll be right here on [${project.name}].`,
      ])),
    }));
  },

  'system.chit_chat.identity': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-07-30, requested directly): "who are you"/"what are you" previously had no
    // real answer — either misclassified onto system.chit_chat.help or fell to a generic fallback.
    // Distinct from "help" (which lists commands) — this answers what this thing *is*.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `I'm the local command console for **[${project.name}]** — a project-aware dispatcher that runs entirely on your machine. With AI mode off, I match what you type against a fixed set of known project actions (git, npm/build commands, file reads, project Q&A) using a local embedding model — no data leaves this machine, no cloud model involved. With AI mode on, I hand things off to your local Ollama model with read/write tools scoped to this project's folder. Type "help" for the full list of what I can do here.`,
    }));
  },

  'system.chit_chat.needs_ai_mode': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-08-03, Phase 3 of the intent-expansion spec): open-ended requests typed
    // while AI mode is off previously scattered onto identity/structure/commands or the generic
    // fallback. The AI toggle is a frontend-only control, so this can only answer with guidance —
    // it must NOT try to flip the toggle itself (no such server-side path exists by design).
    // Phase 7 (2026-08-11): the guidance now names the AI dock and gives a concrete phrasing
    // to use there (see aiDockHints.js) instead of stopping at "flip the toggle".
    const instruction = aiDockInstruction(input);
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom([
        `That one needs AI mode — flip the AI toggle at the top of this chat (next to the model picker) or open the AI dock, then ${instruction}. AI mode gives me read/write tools scoped to [${project.name}], so I can handle open-ended requests.`,
        `This is trigger mode, which only handles the fixed built-in actions. Turn AI mode on (toggle in the chat header, or use the AI dock) and ${instruction}.`,
        `AI mode isn't on right now. Flip the AI switch in the chat header or open the AI dock, then ${instruction} — with AI on I can work with files in [${project.name}] and answer open-ended questions.`,
      ]),
    }));
  },

  'system.chit_chat.ack': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-08-03, Phase 2.1): brief acknowledgment replies — "nice", "cool", etc.
    // Confirm-prompt responses go through handleConfirmResponse, NOT the matcher — so these
    // can never approve a pending command.
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom(chatReplyPool('ack', project, [
        `Glad it worked! What's next on [${project.name}]?`,
        `Nice — anything else on [${project.name}]?`,
        `Good stuff. Ready for the next one.`,
        `Awesome. What are we doing next?`,
        `Cool. Let me know what you need.`,
      ])),
    }));
  },

  'system.chit_chat.joke': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-08-03, Phase 2.3): programmer jokes — deterministic, no network, no AI.
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom([
        `Why do programmers prefer dark mode? Because light attracts bugs.`,
        `There are 10 types of people in the world: those who understand binary and those who don't.`,
        `A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"`,
        `Why did the developer go broke? Because he used up all his cache.`,
        `Hardware: the part of a computer that you can kick. Software: the part you can only curse at.`,
        `Debugging: removing the needles from the haystack.`,
        `It works on my machine — the classic production deployment strategy.`,
        `Why do Java developers wear glasses? Because they don't C#.`,
      ]),
    }));
  },

  'system.chit_chat.clear': async (ws, action, input, project, sessionContext) => {
    ws.send(JSON.stringify({ type: 'clear_console' }));
  },

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
    const { COMMAND_DOCS } = await import('../consoleCommandDocs.js');
    const lines = COMMAND_DOCS.map((e) => {
      const shell = resolveShell(e) ? ` → \`${resolveShell(e)}\`` : '';
      return `- \`${e.command}\`${shell}`;
    });
    ws.send(JSON.stringify({
      type: 'answer',
      data: `### Command reference (${COMMAND_DOCS.length} entries)\n\n${lines.join('\n')}\n\nAsk "how do i <thing>" about any of them for the full explanation.`,
    }));
  },

  'system.chit_chat.yes_no': async (ws, action, input, project, sessionContext) => {
    // Inline yes/no handled at the confirmation prompt level — this is a fallback
    // in case someone types "yes" or "no" when no confirmation is pending.
    ws.send(JSON.stringify({ type: 'answer', data: 'No pending confirmation to respond to. Type "help" for available commands.' }));
  },

  'system.chit_chat.port': async (ws, action, input, project, sessionContext) => {
    // See intentsData.js's 'system.chit_chat.port' comment — this used to have no real intent
    // and fell through to a generic status reply that never actually named a port.
    ws.send(JSON.stringify({
      type: 'answer',
      data: state.serverPort
        ? `This console itself is running on port **${state.serverPort}** (http://127.0.0.1:${state.serverPort}). If you meant this project's own dev server, ask "what is the link" instead.`
        : `I don't have a confirmed server port yet — try refreshing the page, or check the terminal that launched "npm run dev".`,
    }));
  },

  'system.chit_chat.time': async (ws, action, input, project, sessionContext) => {
    // Phase 0 utility intent. Deliberately NO smartChitchatReply (unlike greeting/status): this
    // must answer instantly with zero model call even while AI mode is on. Server-local wall
    // clock — the one correct answer for an offline single-user local tool with no user-side
    // timezone config anywhere in the app.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `It's **${new Date().toLocaleTimeString()}** — this machine's local time.`,
    }));
  },

  'system.chit_chat.date': async (ws, action, input, project, sessionContext) => {
    // Same deliberate no-model-call rule as system.chit_chat.time; server-local calendar date.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Today is **${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}**.`,
    }));
  },

  'system.chit_chat.calculate': async (ws, action, input, project, sessionContext) => {
    // Safe shunting-yard parser in mathEval.js — never eval()/new Function() on chat text, and
    // unsupported input gets an honest "can't do that" instead of a best-guess. Phase 6:
    // unit conversion + percentage/tax/tip phrases are tried before plain arithmetic. The
    // leading "what is/whats/calculate" phrase is stripped first so the dedicated parsers
    // see the bare shape ("whats 18% tip on 64.50" -> "18% tip on 64.50").
    const stripped = input.replace(/^(?:what\s+is|whats|what's|calculate|compute|calc|work\s+out|solve|what\s+does)\b/i, '').trim();
    const converted = convertUnits(stripped);
    if (converted) {
      ws.send(JSON.stringify({ type: 'answer', data: converted.ok
        ? `**${converted.expression}** = **${formatValue(converted.value)}**${converted.category ? ` (${converted.category})` : ''}`
        : converted.reason }));
      return;
    }
    const percent = percentageQuery(stripped);
    if (percent) {
      const suffix = percent.kind === 'tip' ? ' (tip)' : percent.kind === 'tax' ? ' (incl. tax)' : '';
      ws.send(JSON.stringify({ type: 'answer', data: `**${percent.expression}** = **${formatValue(percent.value)}**${suffix}` }));
      return;
    }
    const result = evaluateArithmetic(input);
    if (result.ok) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**${result.expression}** = **${formatValue(result.value)}**`,
      }));
    } else {
      const hint = result.reason === 'divide-by-zero'
        ? 'Can\'t divide by zero.'
        : 'I can only handle basic arithmetic — numbers with + - * / and parentheses, like "what is 12 times 7", or conversions like "convert 5 km to miles" and percentages like "15% of 80".';
      ws.send(JSON.stringify({ type: 'answer', data: hint }));
    }
  },

  'system.chit_chat.git_status': async (ws, action, input, project, sessionContext) => {
    executeCommand('git status --short', project.path, ws, project.id);
    return true;
  },

  'system.chit_chat.deploy': async (ws, action, input, project, sessionContext) => {
    // "Deploy" for Tobi's Vercel-connected projects is just "get my changes to GitHub" —
    // Vercel auto-deploys on push. If the user gave a custom comment ("push the site with
    // the comment 'bug fixes'"), commit with that message explicitly instead of relying on
    // the generic "console-checkpoint: before ..." auto-checkpoint — otherwise the comment
    // the user typed is silently discarded and never ends up in git history at all.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** isn't a git repository yet, so there's nothing to push. Run \`git init\`, add a remote, and push once manually — after that "deploy" will work here.`
      }));
    } else {
      const commitMsg = extractCommentMessage(input);
      const rejectReason = assertSafeCommitMessage(commitMsg);
      if (rejectReason) {
        ws.send(JSON.stringify({ type: 'answer', data: rejectReason }));
        return true;
      }
      const token = crypto.randomUUID();
      // pushCommandWithUpstream: a never-pushed branch would otherwise dead-end on the "no
      // upstream branch" fatal (the 2026-08-13 live failure) — the push part gains
      // --set-upstream so a first push succeeds in one step (2026-08-18).
      const command = commitMsg
        ? await pushCommandWithUpstream(project.path, `git add -A && git commit -m "${commitMsg}" && git push`)
        : await pushCommandWithUpstream(project.path, 'git push');
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt',
        token,
        command: commitMsg
          ? `${command}  (commits with your comment, then pushes — Vercel deploys on push)`
          : `${command}  (pushes local commits to the remote repository)`,
        trigger: 'deploy'
      }));
    }
  }
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
        const docPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', m.doc);
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
