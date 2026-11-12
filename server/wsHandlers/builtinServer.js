import { handleStopServer } from './connectionDevServer.js';

/**
 * system.server.stop — canonical stop for server/site/app/website.
 * Permanent synonyms: stop/close/kill/shutdown + site/app/website/service/backend/api.
 * Typo-tolerant via preSemantic pin for sop/stop variants.
 *
 * 2026-11-12: this handler used to call stopTrackedProcess(project.id) with no target and no
 * untracked fallback, which produced two wrong answers in the live Matchday Exchange export:
 *
 *   - "Stop the site" stopped `npm run dev` but "Stop server" answered "No running server for
 *     Matchday Exchange" while `npm run server` (started earlier in the same session) was
 *     still running — the unscoped call had already killed everything, or the second
 *     process was never tracked at all.
 *   - A server that answers but is NOT console-tracked (started outside the console, or
 *     before a restart) was reported as un-stoppable, with no way forward.
 *
 * It now delegates to handleStopServer — the SAME path the pre-matcher stop check uses — so
 * scoping ("stop the site" vs "stop the server"), the multi-process "which one?" question,
 * and the untracked-server fallback all behave identically on both routes. sendEnd is
 * suppressed because the intent dispatcher owns the turn's 'end' message.
 */
export const serverHandlers = {
  async 'system.server.stop'(ws, _action, input, project, sessionContext) {
    const handled = await handleStopServer(
      ws,
      project,
      (input || '').trim().toLowerCase(),
      sessionContext,
      // checkUntracked: false — the untracked-server offer ("say 'stop it anyway'") belongs to
      // the pre-check in connectionExecute.js, which runs before the matcher for every stop
      // phrase. Probing a port from here made a plain "stop the site" on a project with
      // nothing running take seconds before it could answer, and made the answer depend on
      // whether some unrelated port on the machine happened to be listening.
      { sendEnd: false, checkUntracked: false },
    );
    if (handled) return true;
    // handleStopServer returns false when the phrase doesn't match its stricter stop-shape
    // test (the matcher knows the intent, but the pre-check demands a verb + a server noun).
    // Answer rather than ending the turn silently.
    ws.send(JSON.stringify({
      type: 'answer',
      data: `No running server for **${project.name}**. Say "run the site" to start one, or "is the site running" to check.`,
    }));
    return true;
  },
};
