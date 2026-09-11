import { stopTrackedProcess } from '../executor.js';

/**
 * system.server.stop — canonical stop for server/site/app/website.
 * Permanent synonyms: stop/close/kill/shutdown + site/app/website/service/backend/api.
 * Typo-tolerant via preSemantic pin for sop/stop variants.
 * Body mirrors connectionDevServer.handleStopServer so both pre-check and intent paths
 * behave identically (single kill path, same answer shape).
 */
export const serverHandlers = {
  async 'system.server.stop'(ws, _action, _input, project) {
    const stopped = await stopTrackedProcess(project.id);
    if (stopped.ok) {
      const headsup = stopped.warning ? `\n\nHeads-up: ${stopped.warning}.` : '';
      ws.send(JSON.stringify({ type: 'answer', data: `Stopped \`${stopped.command}\`.${headsup}\n` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `No running server for **${project.name}**.\n` }));
    }
    return true;
  },
};
