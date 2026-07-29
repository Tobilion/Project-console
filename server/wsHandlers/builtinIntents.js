import crypto from 'crypto';
import { injectContext } from '../contextInjector.js';
import { executeCommand } from '../executor.js';
import { performUndo, isGitRepo } from '../gitSafety.js';
import { pendingConfirmations } from '../state.js';
import { createProjectTools } from '../tools.js';

/**
 * Pulls a filename and (optionally) quoted content out of a natural-language trigger-mode
 * request, e.g. "add file Tobijagz to folder with text 'I am the goat'" or "create a file
 * called notes.md with the text 'Hello World'". Deliberately conservative — if either piece
 * can't be found with reasonable confidence, the caller asks the user instead of guessing,
 * same policy this app already follows for ambiguous file targets on the AI path.
 */
function parseFileNameAndContent(input) {
  const fileName = parseFileNameOnly(input);

  // Content: prefer an explicit "with/containing/saying (the) text/content/message ... '...'"
  // clause; fall back to the first quoted string anywhere in the input.
  const withClause = input.match(/\b(?:with|containing|saying)\b\s*(?:the\s+)?(?:text|content|message)?\s*[:]?\s*["']([^"']+)["']/i);
  const anyQuoted = input.match(/["']([^"']{1,2000})["']/);
  const content = (withClause?.[1] ?? anyQuoted?.[1])?.trim() || null;

  return { fileName, content };
}

/**
 * Just the filename half of parseFileNameAndContent, for read-only requests. Tries an explicit
 * filename with an extension first ("notes.md", "src/utils/helpers.js" — the reliable case,
 * doesn't require the word "file" to appear at all), then falls back to whatever follows the
 * literal word "file" for extensionless names like "add file Tobijagz to folder...".
 */
function parseFileNameOnly(input) {
  const withExt = input.match(/\b([\w.\-/\\]+\.[a-zA-Z0-9]{1,10})\b/);
  if (withExt) return withExt[1];
  const afterFileWord = input.match(/\bfile\b\s+(?:called\s+|named\s+)?["'`]?([^\s"'`]+?)["'`]?(?=\s+(?:to|in|with|containing|saying|that|and|$)|$)/i);
  return afterFileWord?.[1] || null;
}

/**
 * Queues a direct file-tool call (writeFile/appendToFile/etc.) behind the same
 * confirm-before-execute flow risky shell commands already use, instead of routing it through
 * executeCommand — there's no shell command to run here, just a sandboxed tools.js function.
 * See handleConfirmResponse's `pending.fileOp` branch in connection.js for the execution side.
 */
function queueFileOpConfirmation(ws, project, input, { tool, args, summary }) {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    projectId: project.id,
    fileOp: { tool, args },
    command: summary, // so the generic "Cancelled: ..." path (keyed off pending.command) still works
    trigger: input,
    createdAt: Date.now(),
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: summary,
    trigger: tool,
  }));
}

/** Enrich a plain-text response with a summary of the project's codebase index, if present. */
export function enrichWithIndex(baseMsg, idx) {
  if (!idx) return baseMsg;
  let lines = [baseMsg];
  const info = [];
  if (idx.totalFiles) info.push(`${idx.totalFiles} files`);
  if (idx.totalDirs) info.push(`${idx.totalDirs} directories`);
  if (idx.languages?.length) info.push(`Languages: ${idx.languages.slice(0, 3).join(', ')}`);
  if (idx.entryPoints?.length) info.push(`Entry: ${idx.entryPoints.join(', ')}`);
  if (info.length) lines.push(`\n**Project Stats:** ${info.join(' — ')}`);
  if (idx.hasTests) lines.push('*Has test files*');
  if (idx.hasCli) lines.push('*Has CLI entry point*');
  return lines.join('\n');
}

/**
 * Builds the "help" response: a categorized prompt library. Ground truth was scattered across
 * NLP training phrases, semantic-matcher examples, and per-project config before this — this is
 * the single place a real, copy-pasteable example lives for every capability the console has,
 * so "help" is actually useful instead of just listing raw trigger strings.
 */
function buildHelpMessage(project, sessionContext) {
  const lines = [`### What you can ask in [${project.name}]`];

  lines.push(
    `\n**Trigger mode (works with AI off — instant, no model needed):**`,
    `  - "overview" / "describe" — what this project is`,
    `  - "tech stack" — languages & frameworks in use`,
    `  - "project structure" / "show me the folders" — directory tree`,
    `  - "what are the commands" — how to run this project`,
    `  - "known issues" / "gotchas" — parsed from your CLAUDE.md`,
    `  - "architecture" — how it's built`,
    `  - "entry point" — where the app starts`,
    `  - "how many files" — project size stats`,
    `  - "run tests" — test file detection`,
    `  - "show dependencies" / "show config" — package.json, .env, etc.`,
    `  - "git status" — uncommitted changes`,
    `  - "deploy" / "push live" — commits everything and pushes (asks to confirm first)`,
    `  - "attach the github link <url>" — sets/updates the git remote origin`,
    `  - "create a file called X with the text '...'" — creates a file (asks to confirm first)`,
    `  - "append to X the text '...'" — adds to the end of a file (asks to confirm first)`,
    `  - "read file X" / "what's in X" — shows a file's contents`,
    `  - "run the site" / "run the project" — detects project type, shows runnable suggestions`,
    `  - "where is the link" / "link?" / "url?" — shows dev server URL if running`,
    `  - "stop server" / "kill server" — stops a running dev server`,
    `  - "npx serve ." / "python -m http.server" — direct shell commands (skips matching)`,
    `  - "explain more" — deeper detail on whatever you just asked about`,
    `  - "undo" — reverts the last risky command via git`,
    `  - "clear" — wipes this chat window`,
  );

  const commands = [];
  const answers = [];
  (project.config?.entries || []).forEach((e) => {
    const primaryTrigger = e.triggers?.[0] || 'unknown';
    if (e.type === 'command') {
      commands.push(`  - "${primaryTrigger}" -> \`${e.action}\`${e.risky ? ' (Risky)' : ''}${e.auto ? ' (auto: package.json)' : ''}`);
    } else if (e.type === 'answer') {
      answers.push(`  - "${primaryTrigger}"`);
    }
  });
  if (commands.length > 0) lines.push(`\n**This project's configured commands:**`, ...commands);
  if (answers.length > 0) lines.push(`\n**This project's configured Q&A topics:**`, ...answers);

  // System commands — always shown
  lines.push(
    `\n**Monitoring & metrics:**`,
    `  - "monitoring" / "show metrics" / "health check" — latency, counters, recent events`,
    `\n**Learning & telemetry commands:**`,
    `  - "review learning" / "check learning" — see near-miss suggestions for new trigger phrases`,
    `  - "approve suggestions" — add suggested phrases to intent matching`,
    `  - "telemetry review" / "telemetry stats" — intent match statistics`,
    `  - "telemetry suggest" — get threshold tuning recommendations`,
    `  - "threshold set <intent> <floor>" — override confidence floor for an intent`,
    `  - "threshold reset <intent>" — restore default threshold`,
    `  - "telemetry auto-apply" — auto-apply threshold suggestions for this project`,
    `  - "check collisions" — check which intents overlap in embedding space`,
    `  - "review distillations" — see AI-derived trigger suggestions from past AI sessions`,
    `  - "apply distillation <n>" — add a suggested command/answer to console.config.json`,
    `  - "review memory" / "project memory" — usage patterns (frequent commands, files, questions)`,
    `  - "telemetry clear" — reset telemetry data for this project`,
  );

  if (sessionContext?.aiEnabled) {
    lines.push(
      `\n**AI is ON — natural language works too, e.g.:**`,
      `  - "Write a file CHANGELOG.md and add a line about the new deploy feature"`,
      `  - "Add a line to CLAUDE.md under Known gotchas about X"`,
      `  - "Find where the login handler is defined"`,
      `  - "Read package.json and tell me what scripts are available"`,
      `  - "Fix the bug where X happens when Y"`,
      `  - "Remove node_modules from git tracking"`,
      `  - Writes/edits and risky commands still ask you to approve before running.`,
    );
  } else {
    lines.push(
      `\n**Want free-form requests (file edits, "fix this bug", multi-step tasks)?**`,
      `  Turn AI ON (top-right toggle) — it hands the request to your local Ollama model with`,
      `  read/write/search tools scoped to this project's folder. Trigger mode above only`,
      `  matches the exact phrasings listed — it can't improvise.`,
    );
  }

  return lines.join('\n');
}

/**
 * Shared helper: detect project type and emit suggestion chips with runnable commands.
 * Used by both `npm_run` and `run_project` when no matching script is found.
 */
function projectTypeSuggestions(ws, project, scripts) {
  const idx = project.codebaseIndex;
  const langs = idx?.languages || [];
  const entries = idx?.entryPoints || [];
  const hasIndexHtml = entries.some(e => e.endsWith('index.html'));
  const isPython = langs.includes('Python');
  const isJs = langs.includes('JavaScript') || langs.includes('TypeScript');
  const scriptNames = Object.keys(scripts);
  const suggestions = [];

  if (isPython) {
    ws.send(JSON.stringify({ type: 'answer', data: `This appears to be a **Python** project. Click a suggestion to run it:` }));
    suggestions.push('python main.py', 'python app.py');
  } else if (hasIndexHtml && !scriptNames.length) {
    ws.send(JSON.stringify({ type: 'answer', data: `This is a **static site** (no build step). Click a suggestion to serve it locally:` }));
    suggestions.push('npx serve .', 'python -m http.server 8080');
  } else if (isJs && scriptNames.length > 0) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Available Scripts\n\nClick one to run it:` }));
    scriptNames.forEach(s => suggestions.push(`npm run ${s}`));
  } else if (isJs) {
    ws.send(JSON.stringify({ type: 'answer', data: `JavaScript project with no npm scripts. Try:` }));
    suggestions.push('npx serve .', 'npx vite', 'npm install');
  } else if (entries.length > 0) {
    ws.send(JSON.stringify({ type: 'answer', data: `**Entry point:** \`${entries[0]}\`. Try:` }));
    suggestions.push(`start ${entries[0]}`);
  } else {
    ws.send(JSON.stringify({ type: 'answer', data: `Could not detect project type. Try "help" for available commands or turn AI mode ON.` }));
  }
  if (suggestions.length > 0) {
    ws.send(JSON.stringify({ type: 'suggestions', data: suggestions }));
  }
}

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
    let responseText = `Hello! Local Console is active for [${project.name}].\n\n` +
      `• Location: ${project.path}\n` +
      `• Type "help" to list all commands & topics.\n` +
      `• Type "overview" for architecture overview.\n` +
      `• Type "explain more" for deep details.`;
    if (ctx) responseText += `\n\n${ctx}`;
    ws.send(JSON.stringify({ type: 'answer', data: responseText }));
  } else if (action === 'system.chit_chat.status') {
    const ctx = injectContext(input, action, project.codebaseIndex);
    let statusMsg = enrichWithIndex(`I'm running and ready on **[${project.name}]**. What do you need?`, project.codebaseIndex);
    if (ctx) statusMsg += `\n\n${ctx}`;
    ws.send(JSON.stringify({ type: 'answer', data: statusMsg }));
  } else if (action === 'system.chit_chat.gratitude') {
    ws.send(JSON.stringify({ type: 'answer', data: `You're welcome! Ready for your next command on [${project.name}].` }));
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
      const msgMatch = input.match(/(?:with (?:the )?(?:comment|message) ["']?|(?:comment|message):?\s*["']?)(.+?)(?:["']?\s*$|["']?\s+and)/i);
      const commitMsg = msgMatch ? msgMatch[1].trim() : null;
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
      const msgMatch = input.match(/(?:with message ["']?|message:?\s*["']?)(.+?)(?:["']?\s*$|["']?\s+and)/i);
      const commitMsg = msgMatch ? msgMatch[1].trim() : 'update';
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
      const msgMatch = input.match(/(?:with message ["']?|message:?\s*["']?)(.+?)(?:["']?\s*$|["']?\s+and)/i);
      const commitMsg = msgMatch ? msgMatch[1].trim() : 'update';
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
        executeCommand(`npm run ${scriptName}`, project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No script called **\`${scriptName}\`** found in \`package.json\`.` }));
        projectTypeSuggestions(ws, project, scripts);
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
        projectTypeSuggestions(ws, project, scripts);
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
        projectTypeSuggestions(ws, project, scripts);
      }
      return true;
    }
    // Fallback: show available scripts or project type suggestions
    projectTypeSuggestions(ws, project, scripts);
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
      queueFileOpConfirmation(ws, project, input, {
        tool: 'writeFile',
        args: { path: parsed.fileName, content: parsed.content },
        summary: `Write "${parsed.fileName}" (${parsed.content.length} chars)`,
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
  } else if (action === 'file_delete') {
    ws.send(JSON.stringify({ type: 'answer', data: `To delete files, turn **AI mode** ON and say "delete the file X" or "remove file Y" — I'll ask for confirmation before making destructive changes.` }));
  } else if (action === 'project_scan') {
    ws.send(JSON.stringify({ type: 'answer', data: `To reindex this project, select it again in the project list — that triggers a fresh index. Or restart the console with "npm run dev".` }));
  } else if (action === 'git_log') {
    executeCommand('git log --oneline -10', project.path, ws, project.id);
    return true;
  } else if (action === 'git_branch') {
    executeCommand('git branch', project.path, ws, project.id);
    return true;
  } else if (action === 'git_checkout') {
    ws.send(JSON.stringify({ type: 'answer', data: `To switch branches, use AI mode or run \`git checkout <branch-name>\` directly. You can also tell me the branch name and I'll set up the command for confirmation.` }));
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
  } else if (action === 'run_project') {
    // Try to detect the project type and run appropriately
    const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
    let scripts = {};
    if (pkgJson) {
      try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {}
    }
    // Check for known dev/start scripts first
    if (scripts.dev) {
      executeCommand('npm run dev', project.path, ws, project.id);
    } else if (scripts.start) {
      executeCommand('npm start', project.path, ws, project.id);
    } else if (scripts.serve) {
      executeCommand('npm run serve', project.path, ws, project.id);
    } else {
      projectTypeSuggestions(ws, project, scripts);
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
      const msgMatch = input.match(/(?:with (?:the )?(?:comment|message) ["']?|(?:comment|message):?\s*["']?)(.+?)(?:["']?\s*$|["']?\s+and)/i);
      const commitMsg = msgMatch ? msgMatch[1].trim() : null;
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
  } else {
    return false; // unrecognized intent
  }
  return true;
}
