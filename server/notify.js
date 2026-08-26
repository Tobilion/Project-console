// Phase 2 notification orchestrator (2026-08-10). notify() fans one event out to whatever
// channels the user configured: the desktop channel (when enabled) plus every webhook URL,
// and is fire-and-forget — it never throws and never blocks its caller (the executor close
// handler and scheduleFire call it without awaiting). initNotifications() registers the
// taskQueue completion listener; call it once from server/index.js at startup.

import { state } from './state.js';
import { loadNotifyRules, getRules, getWebhooks, isEventEnabled } from './notify/notifyStore.js';
import { sendDesktopNotification, sendWebhook } from './notify/notifyChannels.js';
import { setTaskCompletionListener } from './taskQueue.js';
import { log } from './logger.js';

function projectNameOf(projectId) {
  return state.activeProjectsCache.find((p) => p.id === projectId)?.name || projectId;
}

/**
 * Deliver `event` for `projectId` to every configured channel. Returns per-channel results
 * ({ channel, url?, ok, status?/reason? }) for `test notification` reporting; other callers
 * ignore the return. A disabled event is a no-op, so default-off rules cost nothing.
 */
export async function notify(projectId, event, { title, body }) {
  const results = [];
  try {
    if (!isEventEnabled(event)) return results;
    const payload = {
      event,
      projectName: projectNameOf(projectId),
      title,
      body,
      timestamp: Date.now(),
      app: 'local-project-console',
    };
    if (getRules().desktop) {
      results.push({ channel: 'desktop', ...(await sendDesktopNotification(title, body)) });
    }
    for (const url of getWebhooks()) {
      results.push({ channel: 'webhook', url, ...(await sendWebhook(url, payload)) });
    }
  } catch (err) {
    // never let a notification failure propagate into whatever triggered it
    log.error('[notify] internal failure:', err.message);
  }
  return results;
}

/** Wire the taskQueue completion hook. Called once from server/index.js after initScheduler(). */
export function initNotifications() {
  // Rules must be in memory before the first connection can toggle anything — a connection
  // that created a rule before the load would have its rule overwritten by the boot-time
  // defaults. loadNotifyRules is only safe before any live rule change, i.e. at startup.
  loadNotifyRules();
  setTaskCompletionListener(({ projectId, label, failed }) => {
    notify(projectId, 'task-done', {
      title: `${projectNameOf(projectId)}: background task ${failed ? 'failed' : 'finished'}`,
      body: `"${label}" ${failed ? 'failed' : 'completed'}.`,
    });
  });
}