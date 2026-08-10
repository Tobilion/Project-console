import crypto from 'crypto';
import { executeCommand, runningProcesses } from '../executor.js';
import { state, pendingConfirmations } from '../state.js';
import { createProjectTools, findTestCommand } from '../tools.js';
import { parseFileNameAndContent, parseFileNameOnly, queueFileOpConfirmation } from './builtinHelpers.js';
import { projectTypeSuggestions, findMentionedScript } from './builtinRunSuggestions.js';
import { extractRequestedPort, applyRequestedPort } from '../requestedPort.js';

/**
 * npm/file/run handlers (Phase 10 step 4, extracted verbatim from builtinIntents.js).
 * Full (ws, action, input, project, sessionContext) signature for uniform dispatch.
 */
export const fileNpmHandlers = {
  npm_install: async (ws, action, input, project, sessionContext) => {
    executeCommand('npm install', project.path, ws, project.id);
    return true;
  },

  npm_build: async (ws, action, input, project, sessionContext) => {
    executeCommand('npm run build', project.path, ws, project.id);
    return true;
  },

  npm_run: async (ws, action, input, project, sessionContext) => {
    // Load scripts from codebase index
    let scripts = {};
    try { scripts = JSON.parse(project.codebaseIndex?.keyFiles?.['package.json'] || '{}').scripts || {}; } catch {}
    // "run the site on port 3010" — an explicit port overrides the script's default. When a
    // port is requested the duplicate-dev-server guard below is skipped: the user is
    // deliberately (re)starting on a different port, not re-spawning the same one (Phase 5).
    const requestedPort = extractRequestedPort(input);
    // Try to extract a script name from "run dev" / "run the dev script" patterns. Generic
    // site/app/server nouns are excluded from the capture: "run the site on port 3010" must
    // NOT read "site" as a script name — it falls through to the run-the-site branch below
    // (Phase 5, confirmed live: the port-request phrase dead-ended on "No script called site").
    // The (?!the\b) guard after the optional "the" stops the engine from backtracking and
    // starting the capture ON "the" ("run the site ..." captured "the" -> "No script called
    // the", confirmed live 2026-08-11).
    const runMatch = input.match(/(?:run|execute)\s+(?:the\s+)?["']?(?!the\b)((?!(?:site|app|server|project|live|it|thing|something|program|application)\b)\w+(?:-\w+)*)["']?/i);
    if (runMatch) {
      const scriptName = runMatch[1];
      if (scripts[scriptName]) {
        // Same duplicate-dev-server guard as run_project — see that handler's comment for the
        // real transcript this fixes. Only applies to dev-server-shaped script names; anything
        // else (test, build, lint, the project's own custom scripts) always re-runs freely.
        // Matches only when a tracked process IS this script (same reasoning as run_project:
        // a project running a backend on 4400 must still be able to start vite on 3001).
        const expected = scriptName === 'dev' ? 'npm run dev' : scriptName === 'start' ? 'npm start' : 'npm run serve';
        const tracked = !requestedPort && ['dev', 'start', 'serve'].includes(scriptName)
          ? [...(runningProcesses.get(project.id)?.values() || [])].find((p) => p.command && p.command.trim() === expected)
          : null;
        if (tracked && tracked.command && tracked.command.trim() === expected) {
          const url = state.lastDevUrls.get(project.id);
          ws.send(JSON.stringify({
            type: 'answer',
            data: `**[${project.name}]** already has \`${tracked.command}\` running${url ? ` at ${url}` : ''} — say "stop server" first if you want to restart it.\n`
          }));
          return true;
        }
        executeCommand(applyRequestedPort(`npm run ${scriptName}`, requestedPort, { script: scripts[scriptName] }), project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No script called **\`${scriptName}\`** found in \`package.json\`.` }));
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // "npm serve" / "npm start" shortcut — no "run" keyword
    const serveMatch = input.match(/\bnpm\s+serve\b/i);
    if (serveMatch && scripts.serve) {
      executeCommand(applyRequestedPort('npm run serve', requestedPort, { script: scripts.serve }), project.path, ws, project.id);
      return true;
    }
    const startDirect = input.match(/\bnpm\s+start\b/i);
    if (startDirect && scripts.start) {
      executeCommand(applyRequestedPort('npm start', requestedPort, { script: scripts.start }), project.path, ws, project.id);
      return true;
    }
    // Try "start the dev server" / "start a live server" patterns
    const startMatch = input.match(/start\s+(?:the\s+|a\s+)?(?:live\s+)?(?:dev\s+)?(?:server|site|app)\b/i);
    if (startMatch) {
      if (scripts.dev) {
        executeCommand(applyRequestedPort('npm run dev', requestedPort, { script: scripts.dev }), project.path, ws, project.id);
      } else if (scripts.start) {
        executeCommand(applyRequestedPort('npm start', requestedPort, { script: scripts.start }), project.path, ws, project.id);
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `No \`dev\` or \`start\` script found in \`package.json\`.` }));
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // Try "start developing" / "start dev mode"
    if (/\bstart\s+developing\b|\bstart\s+dev\s+mode\b/i.test(input)) {
      if (scripts.dev) {
        executeCommand(applyRequestedPort('npm run dev', requestedPort, { script: scripts.dev }), project.path, ws, project.id);
      } else if (scripts.start) {
        executeCommand(applyRequestedPort('npm start', requestedPort, { script: scripts.start }), project.path, ws, project.id);
      } else {
        await projectTypeSuggestions(ws, project, input, scripts);
      }
      return true;
    }
    // "run/serve/start the site[/app/server] on port N" — the runMatch capture above
    // deliberately skips these generic nouns, so port-shaped run requests land here and run
    // the dev script with the requested port (Phase 5). Without a port these phrases mostly
    // route to run_project; this branch also catches "serve the site" variants that reach
    // npm_run directly. "start the server" normally goes to run_project via a pre-semantic
    // override, so the start variant here is belt-and-braces for a same-script re-run.
    if (/\b(?:run|serve|start)\s+(?:the\s+|a\s+)?(?:live\s+)?(?:site|app|server|application)\b/i.test(input)) {
      let command = null;
      if (scripts.dev) {
        command = applyRequestedPort('npm run dev', requestedPort, { script: scripts.dev });
      } else if (scripts.start) {
        command = applyRequestedPort('npm start', requestedPort, { script: scripts.start });
      } else if (scripts.serve) {
        command = applyRequestedPort('npm run serve', requestedPort, { script: scripts.serve });
      } else {
        await projectTypeSuggestions(ws, project, input, scripts);
        return true;
      }
      // Parity with the config-entry path: "run the site on port 3010" confirms when the
      // project's own dev-script entry wins the match (confirmed live Phase 5), so the
      // same phrase reaching this builtin branch must confirm identically instead of
      // running the dev server unasked. Without a requested port the builtin run stays
      // immediate — matching plain "run the site", which also runs immediately.
      if (requestedPort) {
        const token = crypto.randomUUID();
        pendingConfirmations.set(token, {
          owner: ws, projectId: project.id, command, trigger: input, createdAt: Date.now(),
        });
        ws.send(JSON.stringify({
          type: 'confirm_prompt',
          token,
          command: `${command}  (starts the dev server on the requested port)`,
          trigger: 'run_server',
        }));
      } else {
        executeCommand(command, project.path, ws, project.id);
      }
      return true;
    }
    // Fallback: show available scripts or project type suggestions
    await projectTypeSuggestions(ws, project, input, scripts);
    return true;
  },

  file_create: async (ws, action, input, project, sessionContext) => {
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
        ? `⚠ Overwrite existing "${parsed.fileName}" (${existing.data.length} chars) with new content (${parsed.content.length} chars)`
        : `Write "${parsed.fileName}" (${parsed.content.length} chars)`;
      queueFileOpConfirmation(ws, project, input, {
        tool: 'writeFile',
        args: { path: parsed.fileName, content: parsed.content },
        summary,
      });
    }
  },

  file_append: async (ws, action, input, project, sessionContext) => {
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
  },

  run_tests: async (ws, action, input, project, sessionContext) => {
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
  },

  file_read: async (ws, action, input, project, sessionContext) => {
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
  },

  file_find: async (ws, action, input, project, sessionContext) => {
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
  },

  file_delete: async (ws, action, input, project, sessionContext) => {
    ws.send(JSON.stringify({ type: 'answer', data: `To delete files, turn **AI mode** ON and say "delete the file X" or "remove file Y" — I'll ask for confirmation before making destructive changes.` }));
  },

  run_project: async (ws, action, input, project, sessionContext) => {
    // Try to detect the project type and run appropriately
    const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
    let scripts = {};
    if (pkgJson) {
      try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {}
    }

    // Prefer a script the user actually named ("run its server", "is the server running") over
    // the generic dev/start/serve default — see findMentionedScript's own comment for the real
    // transcript this fixes. dev/start/serve fall through to the normal path below unchanged.
    const requestedPort = extractRequestedPort(input);
    const mentioned = findMentionedScript(input, scripts);
    if (mentioned && !['dev', 'start', 'serve'].includes(mentioned)) {
      executeCommand(applyRequestedPort(`npm run ${mentioned}`, requestedPort, { script: scripts[mentioned] }), project.path, ws, project.id);
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
    // duplicate instances of one script, not to freeze the whole project. Skipped entirely when
    // the user requested a specific port (Phase 5) — that's an explicit re-run on a new port.
    const targetScript = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null;
    const targetCommand = targetScript === 'dev' ? 'npm run dev' : targetScript === 'start' ? 'npm start' : targetScript === 'serve' ? 'npm run serve' : null;
    const tracked = !requestedPort && targetCommand
      ? [...(runningProcesses.get(project.id)?.values() || [])]
          .find((p) => p.command && p.command.trim() === targetCommand) || null
      : null;
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
      executeCommand(applyRequestedPort('npm run dev', requestedPort, { script: scripts.dev }), project.path, ws, project.id);
    } else if (scripts.start) {
      executeCommand(applyRequestedPort('npm start', requestedPort, { script: scripts.start }), project.path, ws, project.id);
    } else if (scripts.serve) {
      executeCommand(applyRequestedPort('npm run serve', requestedPort, { script: scripts.serve }), project.path, ws, project.id);
    } else {
      await projectTypeSuggestions(ws, project, input, scripts);
    }
    return true;
  }
};
