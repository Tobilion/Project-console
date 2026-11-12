import { injectContext } from '../../contextInjector.js';
import { pickRandom, chatReplyPool, smartChitchatReply, paraphrasePoolReply } from '../builtinHelpers.js';
import { buildLiveStateLine, buildMemoryBlock } from '../builtinLiveState.js';
import { aiDockInstruction } from '../../aiDockHints.js';
import { state } from '../../state.js';

/**
 * system.chit_chat.* canned/personal handlers (extracted verbatim from builtinChitChat.js).
 * Each has the full (ws, action, input, project, sessionContext) signature for uniform dispatch.
 */
export const basicHandlers = {
  'system.chit_chat.greeting': async (ws, action, input, project, sessionContext) => {
    const ctx = injectContext(input, action, project.codebaseIndex);
    const hour = new Date().getHours();
    const timeOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    // 2026-11-12 (live corpus): the greeting used to answer with a five-bullet cheat-sheet —
    // the project path plus three "Type X" tips plus a live-state line. Nobody greets a
    // colleague with a tooltip list, and the natural-voice rules say a greeting gets a
    // greeting plus ONE line about what the console can do. The tips are still one click
    // away ("help" lists all of them), so nothing is lost.
    const opener = pickRandom(chatReplyPool('greeting', project, [
      `Good ${timeOfDay}! [${project.name}] is loaded and ready.`,
      `Hey there — [${project.name}] is loaded and ready.`,
      `Hi! Ready to help with [${project.name}].`,
      `Hey — [${project.name}] is up.`,
      `Good to see you — [${project.name}] is live.`,
      `Welcome back to [${project.name}].`,
      `${timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1)}! [${project.name}] is standing by.`,
      `Hi again — [${project.name}] is still here.`,
      `Yo — [${project.name}] is awake and listening.`,
      `Morning! [${project.name}] is ready when you are.`,
      `Hey hey — [${project.name}] is good to go.`,
      `Back at it — [${project.name}] is loaded.`,
    ]));
    let responseText = `${opener} I can run its commands, read the files, and answer questions about it — say "help" for the full list.`;
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
      `Online and idle on **[${project.name}]** — say the word.`,
      `All systems nominal on **[${project.name}]**. What's the task?`,
      `Here and healthy on **[${project.name}]** — what are we doing?`,
      `Standing by on **[${project.name}]** — ready when you are.`,
    ]));
    // 2026-11-12: the project-stats block used to be appended to "how are you" — a file
    // count in answer to a greeting. The live-state line below already says the useful
    // part (is anything running, is the tree dirty).
    let statusMsg = opener;
    statusMsg += await buildLiveStateLine(project);
    if (ctx) statusMsg += `\n\n${ctx}`;
    const smartStatus = await smartChitchatReply(project, sessionContext, input);
    ws.send(JSON.stringify({ type: 'answer', data: smartStatus || statusMsg }));
  },

  'system.chit_chat.gratitude': async (ws, action, input, project, sessionContext) => {
    // Step 7: AI-on paraphrase of the chosen template (verbatim pool when AI is off or the
    // model call fails) — same pattern in farewell/ack/empathy below.
    const template = pickRandom(chatReplyPool('gratitude', project, [
      `You're welcome! Ready for your next command on [${project.name}].`,
      `Anytime! What's next for [${project.name}]?`,
      `Happy to help — let me know what's next on [${project.name}].`,
      `No problem at all. What else can I do on [${project.name}]?`,
      `Glad that helped. Ready when you are.`,
      `My pleasure — [${project.name}] is all yours. What's next?`,
      `Don't mention it. Ready for the next one on [${project.name}].`,
      `Always happy to help out on [${project.name}].`,
      `You got it. What else do you need?`,
      // 2026-11-12: affection lines ("i love you") route here now — "You're welcome!" is the
      // wrong register for "I love you", so these read as a person would.
      `Appreciate that — glad it's useful. What's next on [${project.name}]?`,
      `That's nice to hear. What else can I do for you?`,
      `Thanks — I'm here whenever you need something on [${project.name}].`,
    ]));
    ws.send(JSON.stringify({
      type: 'answer',
      data: await paraphrasePoolReply(project, sessionContext, template) || template,
    }));
  },

  // New intent (2026-11-12, live NetPulse corpus): the user is telling the console its
  // last answer was wrong. There was no route for this at all — "That is wrong" matched
  // system.chit_chat.yes_no and was answered with "No pending confirmation to respond to.
  // Type "help" for available commands.", which reads as a bug report about the console's
  // state machine rather than an answer to the person.
  'system.chit_chat.correction': async (ws, action, input, project, sessionContext) => {
    const template = pickRandom(chatReplyPool('correction', project, [
      `Fair enough — that wasn't right. Tell me what you were actually after and I'll redo it.`,
      `Understood. What did you expect instead? I'll take another run at it.`,
      `You're right, my mistake. Say the word and I'll do it differently.`,
      `Got it. What's the right answer for you, so I can match it next time?`,
    ]));
    const reply = await paraphrasePoolReply(project, sessionContext, template) || template;
    // Point at the two ways forward, without a wall of text: name the last thing the console
    // did (so the correction has something to attach to) and offer AI mode for the open-ended
    // cases trigger mode genuinely cannot answer.
    const last = sessionContext?.lastAnswer?.text;
    const tail = last
      ? `\n\nLast thing I said: _${last.split('\n')[0].slice(0, 140)}_`
      : '';
    const aiNote = sessionContext?.aiEnabled
      ? ''
      : `\n\nIf it's an open-ended request, turn AI mode on and I'll handle it properly.`;
    ws.send(JSON.stringify({ type: 'answer', data: `${reply}${tail}${aiNote}` }));
  },

  // New intent (2026-11-12, live Matchday Exchange corpus): a bare question word with no
  // object. "Why" used to be answered with the entire project overview — 166 files, 18
  // directories, three languages — which buried whatever the user was actually asking
  // about. The console cannot know what "why" refers to, so it asks.
  'system.chit_chat.clarify': async (ws, action, input, project, sessionContext) => {
    const template = pickRandom(chatReplyPool('clarify', project, [
      `What do you mean? Point me at the file, command or topic and I'll dig in.`,
      `Say more — what should I be looking at?`,
      `Could you be more specific? Name the file, command or topic and I'll answer it.`,
      `Which part do you mean?`,
    ]));
    ws.send(JSON.stringify({
      type: 'answer',
      data: await paraphrasePoolReply(project, sessionContext, template) || template,
    }));
  },

  'system.chit_chat.farewell': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-07-30, requested directly — "richer canned chit-chat"): the chit-chat set
    // had no goodbye at all before, so "bye"/"see you later" either fell through to a no-match
    // fallback or got misclassified onto something else entirely.
    const template = pickRandom(chatReplyPool('farewell', project, [
      `See you later! [${project.name}] will be here when you're back.`,
      `Bye for now — come back anytime.`,
      `Catch you later. [${project.name}] stays as you left it.`,
      `Goodbye! Nothing lost — just say hi when you're back.`,
      `Take care! I'll be right here on [${project.name}].`,
      `Later! [${project.name}] keeps ticking without you.`,
      `Off you go — I'll hold down [${project.name}] till you're back.`,
      `Adios! Your spot on [${project.name}] is saved.`,
      `See you soon — nothing here moves unless you say so.`,
    ]));
    ws.send(JSON.stringify({
      type: 'answer',
      data: await paraphrasePoolReply(project, sessionContext, template) || template,
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
    // 2026-09-03: the CLI has no header toggle or AI dock — its `ai on`/`ai off` commands (and
    // the ai_status echo) make AI mode work in the terminal, so the guidance must say that
    // when this connection is the CLI (client_info marker), not point at web-only UI.
    if (sessionContext && sessionContext.client === 'cli') {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `That one needs AI mode, and this terminal is in trigger mode. Type \`ai on\` to switch this session to AI mode (type \`ai off\` to switch back), then repeat your request. With AI mode on I can read and edit files in [${project.name}] and handle open-ended requests.`,
      }));
      return;
    }
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
    const template = pickRandom(chatReplyPool('ack', project, [
      `Glad it worked! What's next on [${project.name}]?`,
      `Nice — anything else on [${project.name}]?`,
      `Good stuff. Ready for the next one.`,
      `Awesome. What are we doing next?`,
      `Cool. Let me know what you need.`,
      `Sweet — what’s next?`,
      `Got it. Anything else?`,
      `Haha, love it. What’s next on [${project.name}]?`,
      `Lol — noted. What do you want to tackle?`,
      `Love to hear it. What's the next move?`,
      `Perfect. I'm here if you need anything else.`,
      `Right on. What shall we do now?`,
    ]));
    ws.send(JSON.stringify({
      type: 'answer',
      data: await paraphrasePoolReply(project, sessionContext, template) || template,
    }));
  },

  'system.chit_chat.empathy': async (ws, action, input, project, sessionContext) => {
    // New intent (2026-09-03, live CLI report): tired/exhausted/frustrated small talk ("Ugh I
    // am tired") previously drifted onto tech_preview/overview. Zero-argument canned sympathy
    // with a soft nudge — never a troubleshooting text (nothing is necessarily broken), never
    // an action. Customizable per project via chatReplies like every other chit-chat pool.
    const template = pickRandom(chatReplyPool('empathy', project, [
      `Take a break — [${project.name}] will be right here when you're back.`,
      `Long days happen. I'm standing by on [${project.name}] whenever you're ready.`,
      `No rush at all. [${project.name}] isn't going anywhere.`,
      `That's fair. Rest up a bit — just say the word when you want to pick [${project.name}] back up.`,
      `I hear you. If it helps, I can run a quick "git status" to catch you up when you're back.`,
      `Hydrate and take a breather. [${project.name}] will be waiting.`,
      `Totally get it — we all hit that wall. [${project.name}] will be here.`,
      `No worries. Grab some air and ping me when you’re ready to jump back in.`,
      `Burnout is real. [${project.name}] isn’t going anywhere — take your time.`,
      `Easy does it. [${project.name}] will keep for later.`,
      `Rest is productive too. Holler when you're recharged.`,
      `Understood — no pressure from this side. [${project.name}] waits.`,
    ]));
    ws.send(JSON.stringify({
      type: 'answer',
      data: await paraphrasePoolReply(project, sessionContext, template) || template,
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

  'system.chit_chat.yes_no': async (ws, action, input, project, sessionContext) => {
    // Inline yes/no handled at the confirmation prompt level — this is a fallback
    // in case someone types "yes" or "no" when no confirmation is pending.
    // 2026-11-12: the reply used to be "No pending confirmation to respond to. Type "help"
    // for available commands." — which reads like a system error and sends the user to a
    // command list they did not ask for. Say the same thing as a person would.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Nothing's waiting on a yes or no right now. What would you like to do on [${project.name}]?`,
    }));
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
};