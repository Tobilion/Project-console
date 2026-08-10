import { runningProcesses, stopTrackedProcess } from '../executor.js';
import { state, withPortCollisionWarning } from '../state.js';
import { probeUrl, candidateDevUrls } from '../livenessProbe.js';
import { recordDevUrl } from '../devUrlStore.js';

// "Where is the link / what is the url" pre-check patterns (hoisted + exported so the harness can
// assert the exact same truth the server uses — keep them in sync with any future edit here).
// Confirmed live 2026-08-03: "what is the dev url" used to slip past the old `(link|url|address)`
// immediacy (an in-between word like "dev" broke the match) and fell through to the NLP stage,
// which misrouted it to project.knowledge.stack. Both patterns now allow an optional determiner
// plus up to two in-between words ("what is the dev url", "what is the dev server link"), while
// the git-context guard below keeps git-remote questions ("what is the git remote url", "where is
// the github link") from ever being answered with a dev-server URL.
export const DEV_URL_WHERE_RE = /where\s+(is|can I find|do I go|did it go)\s+(?:(?:the|a|my|our|their|this)\s+)?(?:[\w.]+\s+){0,2}(link|url|site|server|page)/i;
export const DEV_URL_WHAT_RE = /\bwhat('s| is)\s+(?:(?:the|a|my|our|their|this)\s+)?(?:[\w.]+\s+){0,2}(link|url|address)\b/i;
export const DEV_URL_BARE_RE = /^(link|url)\??$/i;
const DEV_URL_GIT_CONTEXT_RE = /\b(git|github|gitlab|remote|repo|repository|branch|origin|merge|commit|push|pull|checkout|clone)\b/i;

// "stop server" / "kill server" — stop a running dev server. Also catches a bare "stop it" /
// "kill it" / "cancel it" (confirmed live 2026-07-30: "Stop it" typed right after a dev server
// was confirmed still running instead matched system.chit_chat.yes_no — 'stop' is a legitimate
// yes/no-reject example phrase there too — and returned a confusing "No pending confirmation"
// reply) but ONLY when a process is actually tracked for this project; a pronoun-only "stop it"
// with nothing running is ambiguous enough that falling through to the normal yes/no fallback
// is the safer default.
export async function handleStopServer(ws, project, lowerInput) {
  const hasTrackedProcess = runningProcesses.has(project.id);
  if (
    /^(stop|kill|shutdown|end)\s+(the\s+)?(server|process|dev)/i.test(lowerInput) ||
    (hasTrackedProcess && /^(stop|kill|cancel)\s+it\.?$/i.test(lowerInput.trim()))
  ) {
    const stopped = await stopTrackedProcess(project.id);
    if (stopped.ok) {
      const headsup = stopped.warning ? `\n\nHeads-up: ${stopped.warning}.` : '';
      ws.send(JSON.stringify({ type: 'answer', data: `Stopped \`${stopped.command}\`.${headsup}\n` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `No running server for **${project.name}**.\n` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  return false;
}

// "Where is the link?" — answer from the last detected dev server URL. Wide enough to catch
// "what is the dev url" / "where is the dev server" (confirmed misroute, fixed 2026-08-03),
// but never a git-remote question (gated by DEV_URL_GIT_CONTEXT_RE below — "what is the git
// remote url" should go to git_remote_info instead of being answered as the dev server).
export async function handleDevUrl(ws, project, lowerInput) {
  if (!(DEV_URL_WHERE_RE.test(lowerInput) || DEV_URL_WHAT_RE.test(lowerInput) || DEV_URL_BARE_RE.test(lowerInput.trim()))
    || DEV_URL_GIT_CONTEXT_RE.test(lowerInput)) {
    return false;
  }
  const devUrl = state.lastDevUrls.get(project.id);
  if (devUrl) {
    // Liveness-check the last-known URL (2026-08-04): the URL may survive a console restart
    // via devUrlStore.js even when the process itself isn't tracked anymore — probe before
    // claiming it's up. On-demand only, 3s bound.
    const probe = await probeUrl(devUrl, 3000);
    if (probe.alive) {
      const answer = withPortCollisionWarning(`The dev server is running at **${devUrl}** — open it in your browser.`, devUrl);
      ws.send(JSON.stringify({ type: 'answer', data: answer }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}**'s last-known address **${devUrl}** isn't responding right now. Say "run the site" to start it.` }));
    }
  } else {
    // Nothing recorded (2026-08-04, reported directly): a server started OUTSIDE the console
    // that it never observed was invisible. Best-effort discovery before giving guidance —
    // probe the ports the project's own package.json scripts reference (vite --port=N etc.,
    // console's own port excluded), 1.5s bound each, and answer honestly if one responds.
    const candidates = candidateDevUrls(project);
    let found = null;
    for (const candidate of candidates) {
      const probe = await probeUrl(candidate, 1500);
      if (probe.alive) { found = candidate; break; }
    }
    if (found) {
      recordDevUrl(project.id, found);
      const answer = withPortCollisionWarning(`The dev server is running at **${found}** — open it in your browser. It was started outside the console, so I found it by probing the ports its own \`package.json\` scripts reference.`, found);
      ws.send(JSON.stringify({ type: 'answer', data: answer }));
      ws.send(JSON.stringify({ type: 'end' }));
      return true;
    }
    const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
    let scripts = {};
    if (pkgJson) { try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {} }
    const hasDev = scripts.dev || scripts.start || scripts.serve;
    if (hasDev) {
      ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** has a dev script configured but I haven't detected a running server yet. Try saying "run the site" to start it.` }));
    } else {
      const langs = project.codebaseIndex?.languages || [];
      // Same bug as builtinIntents.js's projectTypeSuggestions() — codebaseIndex.languages
      // entries are always "Python (N files)", never the bare name, so `.includes('Python')`
      // could never match. Fixed alongside it (2026-07-29).
      if (langs.some((l) => l.startsWith('Python'))) {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** appears to be a Python project — it doesn't run a local web server in the traditional sense. Try "overview" to learn more.` }));
      } else if (project.codebaseIndex?.entryPoints?.some(e => e.endsWith('index.html'))) {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** is a static HTML project. Open the HTML file directly in your browser, or say "run the site" for instructions.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** doesn't have a dev server running. Try turning AI mode ON and asking "how do I run this project?"` }));
      }
    }
  }
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}
