# Natural Voice Prompt — making the console sound like a person

**Status:** live. Wired into the running app (not a suggestion).
**Runtime source of truth:** `server/aiNaturalVoicePrompt.js`
**Applies to:** AI-mode answers, trigger-mode small talk, and the paraphrase of canned replies.

---

## Why this exists

The exported live chats (NetPulse, Matchday Exchange, Dream Kick — 2026-11-09/10) were read
end to end and every reply that read like a form instead of a person was listed. The failures
were not about facts. They were about **shape**:

| What the user typed | What they got |
|---|---|
| `Hi` | A five-bullet cheat-sheet: location, "type help", "type overview", "type explain more", live state. |
| `I love you` | `I don't have a command configured for that in [Project]` + a stack summary. |
| `That is wrong` | `No pending confirmation to respond to. Type "help" for available commands.` |
| `Yes` | `No pending confirmation to respond to. Type "help" for available commands.` |
| `Explain more` | `### Detailed Follow-up regarding "run server": Last triggered action was "run server" (`npm run server`).` |
| `Open tools` | A paragraph about the **Calculator** panel. |
| `git status` (8 files modified) | `✓ Completed with no errors detected (14 lines of output above).` |
| `Hi` (AI mode on) | `AI error: Ollama error (410): Gone This is an Ollama Cloud model - make sure you're signed in…` |

Nobody greets a colleague with a tooltip list, nobody answers "I love you" with a stack
summary, and nobody is told "no errors detected" while eight files sit uncommitted. So the
prompt is not "be friendly" — it is a set of concrete rules about answer **shape**, anchored
to the shapes that actually failed.

---

## The prompt (copy-paste it anywhere)

```text
You are the local command console for a developer's own machine. Be a competent colleague, not a form.

HOW TO ANSWER
- Lead with the answer. The first sentence must be the thing the user actually asked for.
- One or two sentences for small talk and simple questions. Depth when depth is needed, not by default.
- Say one true thing rather than three hedged ones. Cut anything that repeats the answer.
- Never open with "Sure!", "Great question!", "Certainly!", "I'd be happy to help" or any similar filler.

HOW TO SOUND
- Plain, direct language. Short sentences. Contractions are fine.
- No corporate voice, no enthusiasm padding, no emoji, no exclamation marks unless the user used them first.
- Address the user as "you". Do not narrate yourself as "the console", "the assistant" or "I".

WHAT NOT TO DO
- Do not list what the user could ask next unless you are genuinely unsure what they meant. A menu of commands is a manual, not a conversation.
- Do not repeat the user's own question back to them before answering it.
- Do not describe your own internals. Never mention intent names, match stages, confidence scores, "the last triggered action", or which rule fired. The user is asking for an answer, not a trace.
- Do not claim something succeeded when it did not. If a command failed, say what failed and what to try. "Completed with no errors" is only ever true when the output was actually clean.
- Do not invent facts, file contents, commands, URLs or port numbers. If you do not know, say so and say what would let you find out.
- Do not paste a whole file or a whole document as the answer when one relevant part would do.

WHEN THE USER IS VULNERABLE OR UNSURE
- If the user says something is wrong ("that's wrong", "that is broken"), acknowledge it in one sentence, then say what you will do about it. Do not explain that you have no pending confirmation, and do not treat it as a new command.
- If a request is too ambiguous to act on, ask one specific question. Do not guess and do not answer something adjacent.
- If the user asks "why" or "what" without an object, ask what they mean instead of answering about the project at large.

WHEN THE USER IS JUST CHATTING
- A greeting gets a greeting back, plus one line about what you can do here. Nothing more.
- "Thank you", "ok", "nice" and similar get a short, warm reply — not a status report.
- Silence about the project is fine. Do not append a project summary to small talk.
```

---

## Where it runs

| Path | Prompt used |
|---|---|
| AI-mode chat (any mode: default / coding / tutor / creative / consultant / structured) | `buildNaturalVoicePrompt()` prepended to the mode instruction in `server/ollamaContext.js` — the answer shape is decided before the mode flavour, so every mode obeys the same rules. |
| Trigger-mode small talk with AI mode ON | `smartChitchatReply()` in `server/wsHandlers/builtinHelpers.js` — one bounded, non-streaming model reply. |
| Paraphrase of a canned reply | `paraphrasePoolReply()` — rewording only; every fact, name and number is kept. |
| Trigger mode with AI OFF | No model call. The canned pools in `server/wsHandlers/chitChat/basic.js` were rewritten to the same shape (no bullet menus, no status dumps on a greeting). |

**The model is never load-bearing.** `smartChitchatReply` and `paraphrasePoolReply` return
`null` on any failure (model down, cloud model not signed in, timeout, empty reply) and the
caller falls back to the canned pool. A broken model produces a plain reply, never an error
in the chat.

---

## What changed because of this prompt

### The prompt itself
- `server/aiNaturalVoicePrompt.js` (new) — `NATURAL_VOICE_RULES`, `buildNaturalVoicePrompt()`,
  `PARAPHRASE_RULES`.
- `server/ollamaContext.js` — the natural-voice prompt now leads the AI-mode system prompt.
- `server/wsHandlers/builtinHelpers.js` — `smartChitchatReply` / `paraphrasePoolReply` use it
  instead of their one-line instructions.

### The replies the prompt could not fix
A prompt only shapes what a model writes. The replies that never reached a model had to be
fixed in code — that is the "bad responses" list in the changelog below.

### A real bug the prompt exposed
`smartChitchatReply` referenced `TUNING_DEFAULTS` **without importing it**. Every call threw a
`ReferenceError` that the surrounding `catch` swallowed, so the AI-mode chit-chat features
had been silently dead: the console always used the canned reply, and a "Hi" in AI mode went
to Ollama instead (which is how the 410 error reached the chat in the first place). Fixed by
importing `TUNING_DEFAULTS` from `server/tuningStore.js`.

---

## Using it outside this console

The prompt is deliberately tool-agnostic. Paste it as a system prompt (or as the first line of
a project context file) in any assistant and it will change the shape of the answers in the
same way. Two things to adjust if the assistant has tools:

- Keep the tool list separate from the voice rules. The rules here are about how the answer
  is shaped, not about which tools exist.
- The `WHEN THE USER IS VULNERABLE OR UNSURE` block assumes the assistant can ask a question
  and wait. If it cannot, drop that block rather than leaving it in as a promise it can't keep.

---

## How to tell it worked

A reply passes if a colleague reading only that message would know what happened and what to
do next — without needing the console's internal state to make sense of it.

Concretely, these are now regressions, not preferences:

- `Hi` must not produce a bullet list of console commands.
- `That's wrong` must not produce anything mentioning a pending confirmation.
- `Explain more` must not mention a trigger name, an intent, or a command name it just ran.
- A summary must not claim success over output that shows otherwise.
- A question must never cause a command to run.
