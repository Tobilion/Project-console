import crypto from 'crypto';
import { injectContext } from '../contextInjector.js';
import { executeCommand, runningProcesses } from '../executor.js';
import { performUndo, isGitRepo, createCheckpoint } from '../gitSafety.js';
import { pendingConfirmations, state, withPortCollisionWarning } from '../state.js';
import { createProjectTools, findTestCommand } from '../tools.js';
import { findDocumentedRunCommands } from '../readmeRunParser.js';
import { formatApiRoutes, findTodos, findBiggestFiles, findRecentActivity } from '../codebaseIndexer.js';
import { isSafeParamValue } from '../paramCommand.js';
import { probeUrl, scanProjectServers, candidateDevUrls } from '../livenessProbe.js';
import { recordDevUrl } from '../devUrlStore.js';
import { parseFileNameAndContent, parseFileNameOnly, extractCommentMessage, queueFileOpConfirmation, pickRandom, chatReplyPool, smartChitchatReply, enrichWithIndex } from './builtinHelpers.js';
import { buildLiveStateLine, buildMemoryBlock } from './builtinLiveState.js';
import { buildHelpMessage } from './builtinHelp.js';
import { projectTypeSuggestions, findMentionedScript } from './builtinRunSuggestions.js';

/**
 * Confirmed live 2026-07-30 (Matchday Exchange transcript): "run its server" and "run .bat" both
/** Handles all built-in (non-project-config, non-AI) conversational intents. Returns false if the action wasn't recognized. */
export async function handleBuiltinIntent(ws, action, input, project, sessionContext) {
  if (action === 'system.chit_chat.undo' || action === 'undo') {
    const undoResult = await performUndo(project.path);
    if (undoResult.success) {
      ws.send(JSON.stringify({ type: 'answer', data: undoResult.message }));
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: undoResult.message + '\n' }));
    }
  } else if (action === 'system.chit_chat.greeting') {
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
  } else if (action === 'system.chit_chat.status') {
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
  } else if (action === 'system.chit_chat.gratitude') {
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
  } else if (action === 'system.chit_chat.farewell') {
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
  } else if (action === 'system.chit_chat.identity') {
    // New intent (2026-07-30, requested directly): "who are you"/"what are you" previously had no
    // real answer — either misclassified onto system.chit_chat.help or fell to a generic fallback.
    // Distinct from "help" (which lists commands) — this answers what this thing *is*.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `I'm the local command console for **[${project.name}]** — a project-aware dispatcher that runs entirely on your machine. With AI mode off, I match what you type against a fixed set of known project actions (git, npm/build commands, file reads, project Q&A) using a local embedding model — no data leaves this machine, no cloud model involved. With AI mode on, I hand things off to your local Ollama model with read/write tools scoped to this project's folder. Type "help" for the full list of what I can do here.`,
    }));
  } else if (action === 'system.chit_chat.needs_ai_mode') {
    // New intent (2026-08-03, Phase 3 of the intent-expansion spec): open-ended requests typed
    // while AI mode is off previously scattered onto identity/structure/commands or the generic
    // fallback. The AI toggle is a frontend-only control, so this can only answer with guidance —
    // it must NOT try to flip the toggle itself (no such server-side path exists by design).
    ws.send(JSON.stringify({
      type: 'answer',
      data: pickRandom([
        `That one needs AI mode — flip the AI toggle at the top of this chat (next to the model picker) and ask again. AI mode gives me read/write tools scoped to [${project.name}], so I can handle open-ended requests.`,
        `This is trigger mode, which only handles the fixed built-in actions. Use the AI toggle in the header of this chat to switch AI mode on for requests like that, then re-ask.`,
        `AI mode isn't on right now. Flip the AI switch in the chat header, then ask me again — with AI on I can work with files in [${project.name}] and answer open-ended questions.`,
      ]),
    }));
  } else if (action === 'system.chit_chat.ack') {
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
  } else if (action === 'system.chit_chat.joke') {
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
  } else if (action === 'system.chit_chat.clear') {
    ws.send(JSON.stringify({ type: 'clear_console' }));
  } else if (action === 'system.chit_chat.help') {
    ws.send(JSON.stringify({ type: 'answer', data: buildHelpMessage(project, sessionContext) }));
  } else if (action === 'project.knowledge.overview') {
    const descEntry = project.config.entries?.find((e) => e.type === 'answer' && e.triggers?.some((t) => t.includes('describe') || t.includes('overview') || t.includes('what')));
    let responseText = `### ${project.name}\n\n**Path:** \`${project.path}\`\n**Config Entries:** ${project.config.entries?.length || 0} actions/answers.`;
    if (descEntry) {
      responseText = descEntry.response;
    } else if (project.contextFiles && project.contextFiles.length > 0) {
      const mainDoc = project.contextFiles[0];
      const snippet = mainDoc.content.substring(0, 500) + '...';
      responseText = `### Overview from ${mainDoc.filename}\n\n${snippet}`;
    }
    responseText = enrichWithIndex(responseText, project.codebaseIndex);
    const ctx = injectContext(input, action, project.codebaseIndex);
    if (ctx) responseText += `\n\n${ctx}`;
    responseText += '\n\n*Type "explain more" for deeper details.*';
    ws.send(JSON.stringify({ type: 'answer', data: responseText }));
  } else if (action === 'project.knowledge.stack') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Tech Stack\n\n${project.parsedKnowledge?.stack || 'No stack information parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.commands') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Commands\n\n${project.parsedKnowledge?.commands || 'No commands parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.gotchas') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Gotchas / Known Issues\n\n${project.parsedKnowledge?.gotchas || 'No known issues parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.architecture') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Architecture\n\n${project.parsedKnowledge?.architecture || 'No architecture information parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.how_to_run') {
    // Requested directly (2026-07-30): a purely informational "how do I run/install/set this up"
    // answer — distinct from `run_project`, which actually executes a command. This is meant to
    // answer "how much can trigger mode (no AI) understand from the README" specifically: it
    // never guesses silently, it always says where the answer came from (a documented command
    // vs. a language-based inference vs. "nothing found, turn on AI mode").
    const documented = findDocumentedRunCommands(project);
    const idx = project.codebaseIndex;
    let msg;
    if (documented.length) {
      const single = documented.length === 1;
      const lines = documented.map((d, i) => {
        const srcLabel = d.header
          ? `Documented in **${d.doc}** under "${d.header}"`
          : `Found this command in **${d.doc}**`;
        const code = `\`\`\`\n${d.command}\n\`\`\``;
        return single ? `${srcLabel}:\n\n${code}` : `${i + 1}. ${srcLabel}:\n\n${code}`;
      });
      msg = lines.join('\n\n');
    } else if (idx?.frameworks?.length || idx?.languages?.length) {
      const parts = [];
      if (idx.languages?.length) parts.push(`**Languages:** ${idx.languages.slice(0, 4).join(', ')}`);
      if (idx.frameworks?.length) parts.push(`**Detected stack:** ${idx.frameworks.join(', ')}`);
      if (idx.entryPoints?.length) parts.push(`**Entry point(s):** ${idx.entryPoints.join(', ')}`);
      msg = `No documented run command found in this project's README/CLAUDE.md, but here's what was detected from the code itself:\n\n${parts.join('\n')}\n\nSay "run project" and I'll suggest a command based on this, or turn AI mode on for it to work it out from the source directly.`;
    }
    // 2026-08-03 (requested directly): always also list every exact command this project has
    // configured (console.config.json entries), so "how do I run/do X" gets the full precise
    // command list even when the README documents nothing — and without duplicating an entry
    // already shown as the documented command above.
    const documentedCmds = new Set(documented.map((d) => d.command));
    const configured = (project.config?.entries || []).filter((e) => e.type === 'command' && e.action && !documentedCmds.has(e.action));
    if (configured.length) {
      const list = configured
        .map((e) => `- \`${e.action}\`${e.params?.length ? ` (asks for: ${e.params.map((p) => p.name).join(', ')})` : ''}`)
        .join('\n');
      msg = msg ? `${msg}\n\n**Configured commands (exact):**\n${list}` : `**Configured commands (exact):**\n${list}`;
    }
    if (!msg) {
      msg = `Nothing documented or detected about how to run this project. Try "run project" for a best-effort guess, or turn AI mode on.`;
    }
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  } else if (action === 'system.chit_chat.explain_followup') {
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
        const treeLines = idx.directoryTree.slice(0, 20).map((d) => `  📁 ${d}`).join('\n');
        detailText += `\n\n**Directory Structure:**\n${treeLines}`;
        if (idx.directoryTree.length > 20) detailText += `\n  ... and ${idx.directoryTree.length - 20} more`;
      }
      if (idx?.fileSample?.length) {
        const sample = idx.fileSample.slice(0, 10).map((f) => `  📄 ${f}`).join('\n');
        detailText += `\n\n**Key Files:**\n${sample}`;
      }
      const ctx = injectContext(input, action, project.codebaseIndex);
      if (ctx) detailText += `\n\n${ctx}`;
      ws.send(JSON.stringify({ type: 'answer', data: detailText }));
    }
  } else if (action === 'system.chit_chat.yes_no') {
    // Inline yes/no handled at the confirmation prompt level — this is a fallback
    // in case someone types "yes" or "no" when no confirmation is pending.
    ws.send(JSON.stringify({ type: 'answer', data: 'No pending confirmation to respond to. Type "help" for available commands.' }));
  } else if (action === 'git_push') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then add a remote origin.` }));
    } else {
      // "push the site with the comment 'bug fixes'" can match this plain git_push intent
      // instead of system.chit_chat.deploy (their example phrases overlap heavily — both are
      // full of "push ..." variants), and this branch used to always push bare, silently
      // dropping any comment the user typed. Parse it the same way deploy does so the comment
      // isn't lost regardless of which of the two intents wins the match.
      const commitMsg = extractCommentMessage(input);
      const token = crypto.randomUUID();
      const command = commitMsg
        ? `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`
        : 'git push';
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: commitMsg
          ? `git add -A && git commit -m "${commitMsg}" && git push  (commits with your comment, then pushes)`
          : 'git push (pushes local commits to the remote repository)',
        trigger: 'git_push'
      }));
    }
  } else if (action === 'git_remote_add') {
    // "Can I attach the github link" had nowhere to go before — no intent existed for setting
    // up a remote at all, so it fell through to an unrelated generic help response. Parse a
    // URL out of the input; if there isn't one, ask for it instead of guessing.
    const urlMatch = input.match(/(https?:\/\/\S+|git@[\w.-]+:\S+)/i);
    if (!urlMatch) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Paste the GitHub repository URL (e.g. \`https://github.com/you/repo.git\`) and I'll set it as the remote.`
      }));
    } else if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then I can add the remote.` }));
    } else {
      const url = urlMatch[1].replace(/["').,]+$/, '');
      const token = crypto.randomUUID();
      // Works whether "origin" already exists or not, without needing an extra round trip to check.
      const command = `git remote add origin ${url} || git remote set-url origin ${url}`;
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `${command}  (sets "origin" to ${url})`,
        trigger: 'git_remote_add'
      }));
    }
  } else if (action === 'git_commit') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first.` }));
    } else {
      // Extract a commit message from the user's input if possible
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `git add -A && git commit -m "${commitMsg}" (stages all and commits)`,
        trigger: 'git_commit'
      }));
    }
  } else if (action === 'git_commit_push') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. Run \`git init\` first, then add a remote origin.` }));
    } else {
      const commitMsg = extractCommentMessage(input) || 'update';
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id,
        command: `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: `git add -A && git commit -m "${commitMsg}" && git push (stages all, commits, and pushes)`,
        trigger: 'git_commit_push'
      }));
    }
  } else if (action === 'git_add') {
    executeCommand('git add -A', project.path, ws, project.id);
    return true;
  } else if (action === 'git_init') {
    // Confirmed live 2026-07-29: "set up git for this folder" was tried twice in one session —
    // every other git-setup intent here already checks isGitRepo() before acting (git_push/
    // git_commit/deploy all tell the user to run git init first if there's *no* repo yet), but
    // this was the one path that didn't check the other direction. `git init` on an already-
    // initialized repo is technically harmless (git just reinitializes in place, same .git
    // folder, no data loss), but there's no reason to even offer a confirm prompt for a no-op —
    // short-circuit with a clear "already set up" message instead.
    if (await isGitRepo(project.path)) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** is already a git repository — nothing to set up. Try "git status" to see its current state.`
      }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id,
        command: 'git init',
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt', token,
        command: 'git init (creates a new git repository here)',
        trigger: 'git_init'
      }));
    }
  } else if (action === 'git_ignore_add') {
    // Extract what to ignore from input, default to node_modules
    const ignoreMatch = input.match(/(?:add|ignore)\s+(.+?)\s+(?:to\s+)?gi?ignore/i);
    const toIgnore = ignoreMatch ? ignoreMatch[1].trim() : 'node_modules';
    // Use windows-compatible echo to append
    executeCommand(`echo "${toIgnore}" >> .gitignore`, project.path, ws, project.id);
    return true;
  } else if (action === 'git_rm_cached') {
    const rmMatch = input.match(/(?:remove|untrack|rm)\s+(.+?)\s+(?:from\s+)?(?:git|tracking)/i);
    const toRemove = rmMatch ? rmMatch[1].trim() : 'node_modules';
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      projectId: project.id,
      command: `git rm --cached -r "${toRemove}"`,
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: `git rm --cached -r "${toRemove}" (removes from tracking, keeps on disk)`,
      trigger: 'git_rm_cached'
    }));
  } else if (action === 'npm_install') {
    executeCommand('npm install', project.path, ws, project.id);
    return true;
  } else if (action === 'npm_build') {
    executeCommand('npm run build', project.path, ws, project.id);
    return true;
  } else if (action === 'npm_run') {
    // Load scripts from codebase index
    let scripts = {};
    try { scripts = JSON.parse(project.codebaseIndex?.keyFiles?.['package.json'] || '{}').scripts || {}; } catch {}
    // Try to extract a script name from "run dev" / "run the dev script" patterns
    const runMatch = input.match(/(?:run|execute)\s+(?:the\s+)?["']?(\w+(?:-\w+)*)["']?/i);
    if (runMatch) {
      const scriptName = runMatch[1];
      if (scripts[scriptName]) {
        // Same duplicate-dev-server guard as run_project — see that handler's comment for the
        // real transcript this fixes. Only applies to dev-server-shaped script names; anything
        // else (test, build, lint, the project's own custom scripts) always re-runs freely.
        // Matches only when the tracked process IS this script (same reasoning as run_project:
        // a project running a backend on 4400 must still be able to start vite on 3001).
        const tracked = ['dev', 'start', 'serve'].includes(scriptName) ? runningProcesses.get(project.id) : null;
        const expected = scriptName === 'dev' ? 'npm run dev' : scriptName === 'start' ? 'npm start' : 'npm run serve';
        if (tracked && tracked.command && tracked.command.trim() === expected) {
          const url = state.lastDevUrls.get(project.id);
          ws.send(JSON.stringify({
            type: 'answer',
            data: `**[${project.name}]** already has \`${tracked.command}\` running${url ? ` at ${url}` : ''} — say "stop server" first if you want to restart it.\n`
          }));
          return true;
        }
        executeCommand(`npm run ${scriptName}`, project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No script called **\`${scriptName}\`** found in \`package.json\`.` }));
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // "npm serve" / "npm start" shortcut — no "run" keyword
    const serveMatch = input.match(/\bnpm\s+serve\b/i);
    if (serveMatch && scripts.serve) {
      executeCommand('npm run serve', project.path, ws, project.id);
      return true;
    }
    const startDirect = input.match(/\bnpm\s+start\b/i);
    if (startDirect && scripts.start) {
      executeCommand('npm start', project.path, ws, project.id);
      return true;
    }
    // Try "start the dev server" / "start a live server" patterns
    const startMatch = input.match(/start\s+(?:the\s+|a\s+)?(?:live\s+)?(?:dev\s+)?(?:server|site|app)\b/i);
    if (startMatch) {
      if (scripts.dev) {
        executeCommand('npm run dev', project.path, ws, project.id);
      } else if (scripts.start) {
        executeCommand('npm start', project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No \`dev\` or \`start\` script found in \`package.json\`.` }));
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // Try "start developing" / "start dev mode"
    if (/\bstart\s+developing\b|\bstart\s+dev\s+mode\b/i.test(input)) {
      if (scripts.dev) {
        executeCommand('npm run dev', project.path, ws, project.id);
      } else if (scripts.start) {
        executeCommand('npm start', project.path, ws, project.id);
      } else {
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // Fallback: show available scripts or project type suggestions
    await projectTypeSuggestions(ws, project, input, scripts);
    return true;
  } else if (action === 'file_create') {
    // Trigger mode never had a route to actually create a file — "add a file" always bounced
    // to "turn on AI mode", which meant the whole feature was blocked on having Ollama running.
    // Reading/writing/appending a file for an unambiguous, explicitly-named request doesn't need
    // an LLM's judgment at all — it's the same deterministic sandboxed tools.js functions the AI
    // path already uses, just invoked directly from a regex-parsed request instead of a model's
    // tool call. Still gated behind the same confirm-before-write flow as every other mutation.
    const parsed = parseFileNameAndContent(input);
    if (!parsed.fileName) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `What should I name the file, and what should it contain? Try: "create a file called notes.md with the text 'Hello World'".`
      }));
    } else if (!parsed.content) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `What should **${parsed.fileName}** contain? Try: "create a file called ${parsed.fileName} with the text '...'" — or turn AI mode ON for open-ended content.`
      }));
    } else {
      // Confirmed live 2026-07-29, in the same spirit as the git_init fix above: writeFile
      // overwrites unconditionally with no existence check, and the confirm prompt used to say
      // the same generic "Write X (N chars)" whether the file was brand new or about to replace
      // something already there. Check first so an existing file gets an explicit overwrite
      // warning instead of a silently identical-looking prompt.
      const tools = await createProjectTools(project);
      const existing = await tools.readFile({ path: parsed.fileName });
      const summary = existing.success
        ? `⚠️ Overwrite existing "${parsed.fileName}" (${existing.data.length} chars) with new content (${parsed.content.length} chars)`
        : `Write "${parsed.fileName}" (${parsed.content.length} chars)`;
      queueFileOpConfirmation(ws, project, input, {
        tool: 'writeFile',
        args: { path: parsed.fileName, content: parsed.content },
        summary,
      });
    }
  } else if (action === 'file_append') {
    const parsed = parseFileNameAndContent(input);
    if (!parsed.fileName || !parsed.content) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Tell me the file and the text to add, e.g. "append to notes.md the text 'remember to test this'".`
      }));
    } else {
      queueFileOpConfirmation(ws, project, input, {
        tool: 'appendToFile',
        args: { path: parsed.fileName, content: parsed.content },
        summary: `Append to "${parsed.fileName}" (${parsed.content.length} chars)`,
      });
    }
  } else if (action === 'run_tests') {
    // Intent expansion (Phase 1, 2026-08-03): "run the tests" previously only answered ABOUT
    // tests (project.context.tests, informational). This executes the project's real test command
    // by marker detection — same style as run_project's marker checks below. Tests re-run
    // freely (no dev-server duplicate guard, no confirm) per the existing npm_run rule.
    // Detection shares runTests's single source of truth (tools.js findTestCommand) so the two
    // paths can never drift — see Phase 5 PASS 5.3.
    const testCommand = findTestCommand(project);
    if (testCommand) {
      executeCommand(testCommand, project.path, ws, project.id);
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `No test setup detected for **[${project.name}]** (no package.json test script, Cargo.toml, go.mod, or Python test marker). Say "tell me about the tests" to see what's here.` }));
    }
    return true;
  } else if (action === 'file_read') {
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file would you like me to read?` }));
    } else {
      const tools = await createProjectTools(project);
      const result = await tools.readFile({ path: fileName });
      if (result.success) {
        const body = result.data.length > 3000 ? result.data.slice(0, 3000) + '\n… (truncated)' : result.data;
        ws.send(JSON.stringify({ type: 'answer', data: `**${fileName}**\n\`\`\`\n${body}\n\`\`\`` }));
      } else {
        // Ambiguous or missing file — suggest real matches instead of just failing, same
        // convention the AI path already follows (findFiles before guessing at the wrong file).
        const matches = await tools.findFiles({ pattern: fileName });
        if (matches.success && matches.data.length > 0) {
          const list = matches.data.slice(0, 8).map(f => `  - ${f}`).join('\n');
          ws.send(JSON.stringify({ type: 'answer', data: `Couldn't find "${fileName}" exactly. Did you mean one of these?\n${list}` }));
        } else {
          ws.send(JSON.stringify({ type: 'answer', data: result.error }));
        }
      }
    }
  } else if (action === 'file_find') {
    // Intent expansion (Phase 1, 2026-08-03): the dedicated "where is the file X" / "find the
    // config file" path — parses the name loosely (same parseFileNameOnly as file_read) and
    // runs the same sandboxed findFiles() the AI path uses. Read-only, immediate; "no matches"
    // is stated plainly instead of a generic failure.
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file are you looking for? Try "where is main.py" or "find the config file".` }));
    } else {
      const tools = await createProjectTools(project);
      const matches = await tools.findFiles({ pattern: fileName });
      if (matches.success && matches.data.length > 0) {
        const capped = matches.data.slice(0, 15);
        const list = capped.map((f) => `  - \`${f}\``).join('\n');
        let msg = `Found ${matches.data.length} match${matches.data.length === 1 ? '' : 'es'} for **${fileName}** in **[${project.name}]**:\n${list}`;
        if (matches.data.length > capped.length) msg += `\n  … and ${matches.data.length - capped.length} more`;
        ws.send(JSON.stringify({ type: 'answer', data: msg }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No files match **"${fileName}"** in **[${project.name}]**. Try a different name, or "show me the project structure" to see what's here.` }));
      }
    }
  } else if (action === 'file_delete') {
    ws.send(JSON.stringify({ type: 'answer', data: `To delete files, turn **AI mode** ON and say "delete the file X" or "remove file Y" — I'll ask for confirmation before making destructive changes.` }));
  } else if (action === 'project_scan') {
    ws.send(JSON.stringify({ type: 'answer', data: `To reindex this project, select it again in the project list (web UI) or type "projects" (CLI chat) — either one triggers a fresh index.` }));
  } else if (action === 'project_list') {
    // Confirmed live 2026-07-29: this used to fall through to project_scan's reindex answer and
    // tell people to "restart the console" — wrong on both counts (nothing here is about
    // reindexing, and switching projects never required a restart). Real fix: a dedicated intent
    // that lists what's actually available and points at the real switch mechanism for whichever
    // interface the user is in — a project card click in the web UI, or the CLI's own "projects"
    // command (added alongside this).
    const projects = state.activeProjectsCache || [];
    const list = projects.length > 0
      ? projects.map((p) => `  - ${p.name}`).join('\n')
      : '  (none found — is the scan directory set correctly?)';
    ws.send(JSON.stringify({
      type: 'answer',
      data: `**Available projects:**\n${list}\n\nIn the web UI, click a different project card in the sidebar to switch — no restart needed. In CLI chat, type "projects" to rescan and pick a different one.`,
    }));
  } else if (action === 'system.chit_chat.port') {
    // See intentsData.js's 'system.chit_chat.port' comment — this used to have no real intent
    // and fell through to a generic status reply that never actually named a port.
    ws.send(JSON.stringify({
      type: 'answer',
      data: state.serverPort
        ? `This console itself is running on port **${state.serverPort}** (http://127.0.0.1:${state.serverPort}). If you meant this project's own dev server, ask "what is the link" instead.`
        : `I don't have a confirmed server port yet — try refreshing the page, or check the terminal that launched "npm run dev".`,
    }));
  } else if (action === 'git_log') {
    executeCommand('git log --oneline -10', project.path, ws, project.id);
    return true;
  } else if (action === 'git_branch') {
    executeCommand('git branch', project.path, ws, project.id);
    return true;
  } else if (action === 'git_checkout') {
    ws.send(JSON.stringify({ type: 'answer', data: `To switch branches, use AI mode or run \`git checkout <branch-name>\` directly. You can also tell me the branch name and I'll set up the command for confirmation.` }));
  } else if (action === 'git_diff') {
    // Safe/read-only, same treatment as git_log/git_branch — no confirmation needed.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      executeCommand('git diff', project.path, ws, project.id);
      return true;
    }
  } else if (action === 'git_stash') {
    // New (2026-07-30, requested directly). Confirm-gated even though `git stash` is technically
    // reversible via `git stash pop` — it can look like uncommitted work "disappeared" from the
    // working tree, which is exactly the kind of surprising-but-recoverable action this app's
    // existing safety model (see CLAUDE.md) already requires a confirm step for.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { projectId: project.id, command: 'git stash', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash (shelves uncommitted changes — restore later with "git stash pop")', trigger: 'git_stash' }));
    }
  } else if (action === 'git_stash_list') {
    // New (2026-08-03, Phase 3 of the intent-expansion spec). Read-only listing, same immediate
    // treatment as git_log/git_branch — never touches the stash itself.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      executeCommand('git stash list', project.path, ws, project.id);
      return true;
    }
  } else if (action === 'git_stash_pop') {
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, { projectId: project.id, command: 'git stash pop', trigger: input, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: 'git stash pop (restores the most recently stashed changes — can conflict with current changes)', trigger: 'git_stash_pop' }));
    }
  } else if (action === 'git_branch_create') {
    // New (2026-07-30, requested directly). Same injection-safety check paramCommand.js's
    // parameterized commands already use for user-supplied values substituted into a command
    // string — a branch name is exactly that kind of value.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const branchMatch = input.match(/(?:branch|create a branch|new branch|make a branch)(?:\s+called|\s+named)?\s+["'`]?([\w./-]+)["'`]?/i);
      const branchName = branchMatch?.[1];
      if (!branchName || !isSafeParamValue(branchName)) {
        ws.send(JSON.stringify({ type: 'answer', data: `What should the new branch be called? Try "create a branch called feature-x".` }));
      } else {
        const token = crypto.randomUUID();
        const command = `git checkout -b ${branchName}`;
        pendingConfirmations.set(token, { projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates and switches to a new branch)`, trigger: 'git_branch_create' }));
      }
    }
  } else if (action === 'git_pull') {
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      projectId: project.id,
      command: 'git pull',
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: 'git pull (fetches and merges remote changes)',
      trigger: 'git_pull'
    }));
  } else if (action === 'git_fetch') {
    // Intent expansion (Phase 2, 2026-08-03): read-only — updates remote-tracking refs, never
    // touches the working tree. Same immediate treatment as git_log/git_branch.
    executeCommand('git fetch', project.path, ws, project.id);
    return true;
  } else if (action === 'git_ahead_behind') {
    // Intent expansion (Phase 2, 2026-08-03): "am I behind origin" — git status -sb prints the
    // "[origin/main: ahead 2, behind 1]" line directly; no parsing needed. Read-only, immediate.
    executeCommand('git status -sb', project.path, ws, project.id);
    return true;
  } else if (action === 'git_tag') {
    // Intent expansion (Phase 2, 2026-08-03): no tag name -> list (read-only, immediate, same
    // as git_log); a tag name -> confirm-gated `git tag <name>`. The name is validated with
    // isSafeParamValue BEFORE the confirm prompt, exactly like git_branch_create, since it
    // substitutes straight into the command string.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet.` }));
    } else {
      const tagName = (input.match(/(?:called|named)\s+([A-Za-z0-9._/-]+)/i) ||
                       input.match(/\btag(?: this)?(?: as)?\s+([A-Za-z0-9._/-]+)/i))?.[1] || null;
      if (!tagName) {
        executeCommand('git tag', project.path, ws, project.id);
      } else if (!isSafeParamValue(tagName)) {
        ws.send(JSON.stringify({ type: 'answer', data: `Tag name **${tagName}** contains characters that aren't allowed. Use letters, numbers, dots, underscores, slashes, and hyphens.` }));
      } else {
        const token = crypto.randomUUID();
        const command = `git tag ${tagName}`;
        pendingConfirmations.set(token, { projectId: project.id, command, trigger: input, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${command} (creates a tag on the current commit)`, trigger: 'git_tag' }));
      }
    }
  } else if (action === 'project.workflow.checkpoint') {
    // Intent expansion (Phase 2, 2026-08-03, requested directly): an explicit user-asked
    // checkpoint commit — same createCheckpoint the auto-checkpoint-before-risky-commands flow
    // uses. A normal, recoverable commit, so no confirm; non-git projects get createCheckpoint's
    // own message surfaced as-is.
    const result = await createCheckpoint(project.path, input);
    if (result.success) {
      ws.send(JSON.stringify({ type: 'answer', data: result.message }));
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: (result.message || result.error || 'Checkpoint failed.') + '\n' }));
    }
    return true;
  } else if (action === 'run_project') {
    // Try to detect the project type and run appropriately
    const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
    let scripts = {};
    if (pkgJson) {
      try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {}
    }

    // Prefer a script the user actually named ("run its server", "is the server running") over
    // the generic dev/start/serve default — see findMentionedScript's own comment for the real
    // transcript this fixes. dev/start/serve fall through to the normal path below unchanged.
    const mentioned = findMentionedScript(input, scripts);
    if (mentioned && !['dev', 'start', 'serve'].includes(mentioned)) {
      executeCommand(`npm run ${mentioned}`, project.path, ws, project.id);
      return true;
    }

    // Confirmed live 2026-07-30: nothing here ever checked whether a dev server was already
    // running for this project before spawning another one — three separate "run ..." messages
    // in one session ("run dev", "run its server", "run .bat") each blindly launched a fresh
    // `npm run dev`, leaving three redundant Vite instances on 3001/3002/3003 all serving the
    // same project. `runningProcesses` (executor.js) is the same map "stop server" already reads.
    // Matches only when the tracked process is the SAME script we're about to spawn — Matchday
    // Exchange runs two independent servers (vite on 3001 AND a tsx backend on 4400), so "run
    // the site" must still start `dev` while `server` is tracked; the guard exists to stop
    // duplicate instances of one script, not to freeze the whole project.
    const tracked = runningProcesses.get(project.id);
    const targetScript = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null;
    const targetCommand = targetScript === 'dev' ? 'npm run dev' : targetScript === 'start' ? 'npm start' : targetScript === 'serve' ? 'npm run serve' : null;
    if (tracked && targetCommand && tracked.command && tracked.command.trim() === targetCommand) {
      const url = state.lastDevUrls.get(project.id);
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**[${project.name}]** already has \`${tracked.command}\` running${url ? ` at ${url}` : ''} — say "stop server" first if you want to restart it.\n`
      }));
      return true;
    }

    // Check for known dev/start scripts first
    if (scripts.dev) {
      executeCommand('npm run dev', project.path, ws, project.id);
    } else if (scripts.start) {
      executeCommand('npm start', project.path, ws, project.id);
    } else if (scripts.serve) {
      executeCommand('npm run serve', project.path, ws, project.id);
    } else {
      await projectTypeSuggestions(ws, project, input, scripts);
    }
    return true;
  } else if (action === 'system.chit_chat.git_status') {
    executeCommand('git status --short', project.path, ws, project.id);
    return true;
  } else if (action === 'system.chit_chat.deploy') {
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
      const token = crypto.randomUUID();
      const command = commitMsg
        ? `git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`
        : 'git push';
      pendingConfirmations.set(token, {
        projectId: project.id,
        command,
        trigger: input,
        createdAt: Date.now()
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt',
        token,
        command: commitMsg
          ? `git add -A && git commit -m "${commitMsg}" && git push  (commits with your comment, then pushes — Vercel deploys on push)`
          : 'git push  (commits all changes first, then pushes — Vercel deploys on push)',
        trigger: 'deploy'
      }));
    }
  } else if (action === 'project.context.structure') {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No indexed structure available for **[${project.name}]**. Run a re-index first.` }));
    } else {
      let msg = `### Directory Structure [${project.name}]\n\n**${idx.totalDirs} directories, ${idx.totalFiles} files**\n`;
      if (idx.directoryTree.length) {
        msg += '\n```\n' + idx.directoryTree.join('\n') + '\n```';
      }
      if (idx.fileSample.length) {
        msg += `\n\n**Sample files (${idx.fileSample.length} shown):**\n` + idx.fileSample.map((f) => `- ${f}`).join('\n');
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  } else if (action === 'project.context.languages') {
    const idx = project.codebaseIndex;
    if (!idx?.languages?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No language data indexed for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Languages in [${project.name}]\n\n${idx.languages.map((l) => `- ${l}`).join('\n')}` }));
    }
  } else if (action === 'project.context.file_count') {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No index data for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Project Size [${project.name}]\n\n- **Total files:** ${idx.totalFiles}\n- **Total directories:** ${idx.totalDirs}\n- **Languages:** ${(idx.languages || []).slice(0, 5).join(', ') || 'N/A'}` }));
    }
  } else if (action === 'project.context.entry_point') {
    const idx = project.codebaseIndex;
    if (!idx?.entryPoints?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No entry point detected for **[${project.name}]**. Try "show me the project structure" to explore.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Entry Points [${project.name}]\n\n${idx.entryPoints.map((e) => `- \`${e}\``).join('\n')}` }));
    }
  } else if (action === 'project.context.tech_preview') {
    const idx = project.codebaseIndex;
    let msg = `### Tech Preview [${project.name}]\n\n`;
    if (idx) {
      msg += `**${idx.totalFiles} files** across **${idx.totalDirs} directories**.\n\n`;
      if (idx.languages?.length) msg += `**Languages:** ${idx.languages.slice(0, 4).join(', ')}\n`;
      if (idx.entryPoints?.length) msg += `**Entry points:** ${idx.entryPoints.join(', ')}\n`;
      if (idx.hasTests) msg += '**Has tests**\n';
      if (idx.hasCli) msg += '**Has CLI**\n';
      if (idx.hasConfig) msg += '**Has config**\n';
      if (idx.directoryTree?.length) {
        msg += `\n**Top-level dirs:** ${idx.directoryTree.filter((d) => !d.includes('\\')).join(', ')}\n`;
      }
    } else {
      msg += 'No codebase index available. Use a tool to scan the project first.';
    }
    const ctxTp = injectContext(input, action, project.codebaseIndex);
    if (ctxTp) msg += `\n\n${ctxTp}`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  } else if (action === 'project.context.tests') {
    const idx = project.codebaseIndex;
    if (!idx || !idx.hasTests) {
      ws.send(JSON.stringify({ type: 'answer', data: `No tests detected for **[${project.name}]**.` }));
    } else {
      let msg = `### Tests [${project.name}]\n\n✅ Test files detected.\n`;
      if (idx.fileSample) {
        const testFiles = idx.fileSample.filter((f) =>
          f.includes('test') || f.includes('spec') || f.includes('.test.')
        );
        if (testFiles.length > 0) {
          msg += `\n**Test files found:**\n${testFiles.map((f) => `- \`${f}\``).join('\n')}`;
        }
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  } else if (action === 'project.context.dependencies') {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dependency information for **[${project.name}]**.` }));
    } else {
      const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'go.mod'];
      let found = false;
      let msg = `### Dependencies [${project.name}]\n\n`;
      for (const name of depFiles) {
        if (idx.keyFiles[name]) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
          found = true;
        }
      }
      if (!found) msg += 'No standard dependency files detected.';
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  } else if (action === 'project.context.config') {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No config information for **[${project.name}]**.` }));
    } else {
      const configFiles = Object.keys(idx.keyFiles).filter(
        (name) => name.includes('.env') || name.includes('config') || name.endsWith('.json')
      );
      if (configFiles.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: `No config files detected for **[${project.name}]**.` }));
      } else {
        let msg = `### Configuration [${project.name}]\n\n`;
        for (const name of configFiles.slice(0, 3)) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
        }
        ws.send(JSON.stringify({ type: 'answer', data: msg }));
      }
    }
  } else if (action === 'project.context.routes') {
    // New (2026-07-30, requested directly): surfaces idx.apiRoutes (Express/Flask/FastAPI/Django
    // route declarations — see codebaseIndexer.js's extractRoutes()) that was already being
    // collected for the AI system prompt but had no trigger-mode-visible way to ask for it.
    const idx = project.codebaseIndex;
    const routesText = formatApiRoutes(idx?.apiRoutes, 3000);
    if (!routesText) {
      ws.send(JSON.stringify({ type: 'answer', data: `No API routes detected for **[${project.name}]** (only Express/Flask/FastAPI/Django route declarations are recognized).` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Detected API routes [${project.name}]\n\n\`\`\`\n${routesText}\n\`\`\`` }));
    }
  } else if (action === 'project.context.file_relations') {
    // New (2026-07-30, requested directly): "which files import X" / "who uses this file" —
    // leverages the reverse-import index already attached to each repoMap entry
    // (buildReverseImportIndex() in codebaseIndexer.js) instead of scanning anything fresh.
    const idx = project.codebaseIndex;
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file? Try "which files import utils.js" or "what does state.js import".` }));
    } else {
      const entry = (idx?.repoMap || []).find((e) => e.path === fileName || e.path.endsWith('/' + fileName) || e.path.endsWith('\\' + fileName));
      if (!entry) {
        ws.send(JSON.stringify({ type: 'answer', data: `Couldn't find "${fileName}" in the indexed repo map. Try "read file ${fileName}" to check the exact path, or re-scan the project.` }));
      } else {
        const parts = [`### ${entry.path}`];
        parts.push(entry.imports?.length ? `**Imports:** ${entry.imports.join(', ')}` : '**Imports:** (none detected)');
        parts.push(entry.importedBy?.length ? `**Imported by:** ${entry.importedBy.join(', ')}` : '**Imported by:** (no other indexed file imports this — or it\'s not a local import)');
        ws.send(JSON.stringify({ type: 'answer', data: parts.join('\n') }));
      }
    }
  } else if (action === 'project.context.monorepo') {
    // New (2026-07-30, requested directly): surfaces idx.subPackages/isMonorepo (see
    // codebaseIndexer.js's detectSubPackages()).
    const idx = project.codebaseIndex;
    if (!idx?.isMonorepo) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** doesn't look like a monorepo — only one manifest file (package.json/pyproject.toml/Cargo.toml/etc.) was found.` }));
    } else {
      const list = idx.subPackages.map((p) => `- \`${p.path}\` (${p.manifests.join(', ')})`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### [${project.name}] looks like a monorepo\n\n${idx.subPackages.length} sub-packages detected:\n\n${list}\n\nEach should likely be run/installed independently.` }));
    }
  } else if (action === 'project.context.todos') {
    // New (2026-07-30, requested directly): "find all todos" — a fresh on-demand scan (see
    // codebaseIndexer.js's findTodos()), not part of the cached index since it's asked for
    // rarely enough that paying the cost on-demand beats slowing down every project select.
    const todos = await findTodos(project.path);
    if (!todos.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No TODO/FIXME/HACK/XXX comments found in **[${project.name}]** (scanned up to 150 code files).` }));
    } else {
      const list = todos.map((t) => `- **${t.tag}** \`${t.file}:${t.line}\`${t.text ? ` — ${t.text}` : ''}`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### TODO/FIXME markers in [${project.name}]\n\n${list}${todos.length >= 60 ? '\n\n_(capped at 60 results)_' : ''}` }));
    }
  } else if (action === 'project.context.biggest_files') {
    // New (2026-07-30, requested directly): "what's the biggest file" — on-demand fs.stat scan
    // (see codebaseIndexer.js's findBiggestFiles()), same on-demand-only reasoning as TODOs above.
    const biggest = await findBiggestFiles(project.path, 10);
    if (!biggest.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `Couldn't determine file sizes for **[${project.name}]**.` }));
    } else {
      const list = biggest.map((f) => `- \`${f.path}\` — ${(f.bytes / 1024).toFixed(1)} KB`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Largest files in [${project.name}]\n\n${list}` }));
    }
  } else if (action === 'project.context.dev_server_status') {
    // Intent expansion (Phase 1, 2026-08-03): "is the server running" / "is the site live" /
    // "what's the URL" now has a real intent instead of depending on a config entry or the
    // "what is the link" pre-check in connection.js happening to catch the phrasing. Reads the
    // same runningProcesses + lastDevUrls the pre-check reports — read-only, immediate, and the
    // port-collision heads-up is applied the same way the pre-check applies it.
    const proc = runningProcesses.get(project.id);
    const url = state.lastDevUrls.get(project.id);
    if (proc) {
      let msg = `**[${project.name}]** has \`${proc.command}\` running right now.`;
      if (url) msg += `\n\nOpen it at **${url}** — or say "what is the link" to see it again.`;
      else msg += `\n\nThe process is tracked but no local URL was detected yet — it may still be starting up, or it doesn't expose an HTTP server.`;
      ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(msg, url) }));
    } else if (url) {
      // Not console-tracked (started outside the console or before a restart) but we have a
      // persisted last-known URL — probe it instead of guessing. On-demand only, 3s bound.
      const probe = await probeUrl(url, 3000);
      if (probe.alive) {
        ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(
          `**[${project.name}]** is still responding at **${url}** — but it was started outside the console (or before a restart), so I can't stop it from here.`,
          url
        ) }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has no console-tracked server, and its last-known address **${url}** isn't responding${probe.error === 'timeout' ? ' (timed out)' : ''}. Say "run the site" to start it.` }));
      }
    } else {
      // Nothing tracked and no recorded URL (2026-08-04, reported directly: a server started
      // OUTSIDE the console that it never observed was invisible). Best-effort discovery —
      // probe the ports the project's own package.json scripts reference (vite --port=N etc.,
      // console's own port excluded), each bounded at 1.5s, and report honestly if one answers.
      const candidates = candidateDevUrls(project);
      let found = null;
      for (const candidate of candidates) {
        const probe = await probeUrl(candidate, 1500);
        if (probe.alive) { found = candidate; break; }
      }
      if (found) {
        recordDevUrl(project.id, found);
        ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(
          `**[${project.name}]** is responding at **${found}** — started outside the console (I probed the ports its own \`package.json\` scripts reference), so I can't stop it from here.`,
          found
        ) }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has no server running right now. Say "run the site" to start it, or "how do I run this" for instructions.` }));
      }
    }
  } else if (action === 'project.context.scan_servers') {
    // Requested directly (2026-08-04): probe every project's last-known dev URL on demand and
    // report which are still alive. Deliberately never runs in the background — a scan happens
    // only when asked, with a 2s per-URL bound and a small worker pool, and only projects that
    // HAVE a recorded URL are probed at all.
    const found = await scanProjectServers(state.activeProjectsCache, { timeoutMs: 2000, concurrency: 3 });
    if (found.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dev-server URLs are known for any project right now, and none of the ports its \`package.json\` scripts reference are responding either. Start something with "run the site" first, then scan again.` }));
    } else {
      const lines = found.map((f) =>
        `- **[${f.projectName}]** ${f.url} — ${f.alive ? `✅ responding${f.status ? ` (HTTP ${f.status})` : ''}${f.viaCandidate ? ' *(found by probing its package.json ports — not previously recorded)*' : ''}` : `❌ not responding${f.viaCandidate ? ' *(candidate port from its package.json)*' : ''}`}`
      ).join('\n');
      const liveCount = found.filter((f) => f.alive).length;
      ws.send(JSON.stringify({ type: 'answer', data: `### Server scan (${liveCount}/${found.length} alive)\n\n${lines}\n\nServers started outside the console (or before a restart) show as not console-tracked — I can only probe their URLs, not stop them.` }));
    }
  } else if (action === 'project.context.recent_activity') {
    // Intent expansion (Phase 2, 2026-08-03): on-demand file-mtime scan via findRecentActivity
    // (same readProjectTree walk findBiggestFiles uses — IGNORE_DIRS + dotfile skipping included),
    // deliberately not part of the cached index since it's asked for rarely.
    try {
      const recent = await findRecentActivity(project.path, { limit: 10 });
      if (!recent.length) {
        ws.send(JSON.stringify({ type: 'answer', data: `No recently modified files found for **[${project.name}]**.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `### Recently modified [${project.name}]\n\n` + recent.map(f => `- \`${f.path}\` — ${new Date(f.mtime).toLocaleString()}`).join('\n') }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Could not scan recent activity: ${err.message}\n` }));
    }
    return true;
  } else if (action === 'system.monitoring.metrics') {
    const { default: fetch } = await import('node-fetch');
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/metrics`);
      const snap = await res.json();
      const counters = Object.entries(snap.counters || {}).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
      let histoLines = '';
      for (const [name, stats] of Object.entries(snap.histograms || {})) {
        if (stats) {
          histoLines += `\n**${name}** — count: ${stats.count}, avg: ${stats.avg.toFixed(0)}ms, p95: ${stats.p95}ms, p99: ${stats.p99}ms`;
        }
      }
      const recent = (snap.recentEvents || []).slice(-10).map((e) =>
        `- ${e.type} (${new Date(e.ts).toLocaleTimeString()})${e.duration ? ` ${e.duration}ms` : ''}${e.outcome ? ` → ${e.outcome}` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\n**Counters:**\n${counters || '_(none)_'}\n\n**Latency:**${histoLines || ' _(none)_'}\n\n**Recent Events:**\n${recent || ' _(none)_'}` }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\nCould not fetch metrics: ${err.message}` }));
    }
  } else if (action === 'project.action.open_in_vscode') {
    // Phase 3 (2026-08-03): open project folder in VS Code. If `code` not on PATH, answer with
    // guidance instead of the raw error.
    const { spawn } = await import('child_process');
    const child = spawn('code', [project.path], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH. Open VS Code manually and use File → Open Folder → \`${project.path}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open VS Code: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** in VS Code...` }));
  } else if (action === 'project.action.open_in_explorer') {
    // Phase 3 (2026-08-03): open project folder in OS file explorer — branch on platform.
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let cmd, args;
    if (isWindows) {
      cmd = 'explorer';
      args = [project.path];
    } else if (isMac) {
      cmd = 'open';
      args = [project.path];
    } else {
      cmd = 'xdg-open';
      args = [project.path];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open folder: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** folder in file explorer...` }));
  } else if (action === 'project.action.open_site') {
    // Phase 3 (2026-08-03): open the dev server URL in browser. Reads state.lastDevUrls.
    const url = state.lastDevUrls.get(project.id);
    if (!url) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dev server URL recorded for **[${project.name}]**. Say "run the site" to start it, or "what is the link" if you think it's already running.` }));
      return true;
    }
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
    const args = isWindows ? ['', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **${url}** in your browser...` }));
  } else if (action === 'project.action.copy_path') {
    // Phase 3 (2026-08-03): emit copy_to_clipboard WS event — frontend handles clipboard write.
    ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: project.path }));
    ws.send(JSON.stringify({ type: 'answer', data: `Copied **[${project.name}]** path to clipboard:\n\`${project.path}\`` }));
  } else if (action === 'git_remote_info') {
    // Phase 3 (2026-08-03): read-only `git remote -v` — same isGitRepo gate as git_diff.
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** isn't a git repository yet. No remotes to show.` }));
    } else {
      executeCommand('git remote -v', project.path, ws, project.id);
    }
  } else if (action === 'project.context.running_processes') {
    // Phase 3 (2026-08-03): GLOBAL list across ALL projects from runningProcesses + lastDevUrls.
    const procs = [];
    for (const [pid, info] of runningProcesses) {
      const proj = state.activeProjectsCache.find((p) => p.id === pid);
      const url = state.lastDevUrls.get(pid);
      procs.push({ project: proj?.name || pid, command: info.command, url, runningSince: info.startedAt });
    }
    if (procs.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `Nothing running across all projects. Say "run the site" in a project to start one.` }));
    } else {
      const lines = procs.map((p) =>
        `- **[${p.project}]** \`${p.command}\`${p.url ? ` — ${p.url}` : ''}${p.runningSince ? ` (since ${new Date(p.runningSince).toLocaleTimeString()})` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Running processes\n\n${lines}` }));
    }
  } else if (action === 'project.context.session_info') {
    // Phase 3 (2026-08-03): session count + most recent 3 from conversationStore index.
    const { listSessions } = await import('../conversationStore.js');
    const sessions = await listSessions();
    if (sessions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No chat sessions found.` }));
    } else {
      const recent = sessions.slice(0, 3).map((s) =>
        `- **${s.title}** ([${s.projectName}] — ${new Date(s.updatedAt).toLocaleString()})`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Chat sessions (${sessions.length} total)\n\n${recent}${sessions.length > 3 ? `\n\n...and ${sessions.length - 3} more` : ''}` }));
    }
  } else {
    return false; // unrecognized intent
  }
  return true;
}
