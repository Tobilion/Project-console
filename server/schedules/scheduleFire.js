// The unattended fire path for Phase 1 schedules. A fired schedule must run through the
// SAME matching pipeline a typed message would use (spec requirement) but with no human to
// answer confirm prompts, so:
//   - the schedule's phrase is re-matched at fire time (embedding match is in-memory/cheap)
//     and the resolved intent re-checked against the read-only allowlist — if it drifted to
//     something mutating, unresolvable, or a config entry, the fire is skipped and logged;
//   - the handler runs with a fake `ws` whose send() collects output instead of streaming,
//     and a minimal ephemeral session context (no session -> nothing gets persisted);
//   - the run is wrapped in taskQueue.js's per-project FIFO so it can never block a chat turn
//     or collide with a type-check on the same project.
// Results go to the first currently-connected session of that project (through the real
// connection's intercepted send, so it renders AND persists like a normal answer); with
// nobody connected, they land in data/schedule-log.md for `review schedule log`.

import fs from 'fs';
import path from 'path';
import { state, connectionRegistry } from '../state.js';
import { enqueueTask } from '../taskQueue.js';
import { matchInput } from '../matcher.js';
import { handleBuiltinIntent } from '../wsHandlers/builtinIntents.js';
import { isReadOnlyIntent, readOnlySummary } from './scheduleIntents.js';
import { resolveData } from '../dataPath.js';
import { markFired } from './scheduleStore.js';
import { notify } from '../notify.js';

const SCHEDULE_LOG_FILE = resolveData('schedule-log.md');
const SCHEDULE_LOG_CAP_LINES = 400;

/** Header prefix that marks a fire result as scheduled, not user-typed. */
export function scheduleHeader(schedule) {
  return `⏰ Scheduled ("${schedule.label}" — \`${schedule.command}\`)`;
}

/** Append a line to data/schedule-log.md, trimming to the last ~400 lines. */
export function appendScheduleLog(line) {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_LOG_FILE), { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(SCHEDULE_LOG_FILE, 'utf8');
    } catch {}
    const lines = (existing.split('\n').filter(Boolean));
    lines.push(`- **${new Date().toLocaleString()}** ${line}`);
    fs.writeFileSync(SCHEDULE_LOG_FILE, lines.slice(-SCHEDULE_LOG_CAP_LINES).join('\n') + '\n');
  } catch {
    // best-effort — a failed log write must never take a fire down with it
  }
}

/** Last N lines of the schedule log, for `review schedule log`. */
export function readScheduleLog(n = 40) {
  try {
    if (!fs.existsSync(SCHEDULE_LOG_FILE)) return '(empty — no scheduled runs have logged anything yet)';
    const lines = fs.readFileSync(SCHEDULE_LOG_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).join('\n') || '(empty)';
  } catch {
    return '(could not read the schedule log)';
  }
}

/**
 * Deliver a fire result: real connection for the project (renders + persists) wins over the
 * log file. The target's answer is sent through the connection's real ws.send, which is the
 * intercepted one from connectionLifecycle.js — that is what persists the bubble into the
 * session's NDJSON history, exactly like a normal typed answer.
 */
function deliverResult(schedule, text) {
  // connectionRegistry is a NAMED export of state.js, not a state.* property — iterating the
  // property was a live-found crash (2026-08-10 live pass) that made EVERY fire lose its
  // output before it reached a session or the schedule log.
  for (const [ws, ctx] of connectionRegistry) {
    // Any live chat on the project counts (web chats are session-bound, CLI chats are not —
    // the CLI sends sessionId null; persistence inside the interceptor stays gated on
    // currentSessionId, so a session-less delivery renders without persisting).
    if (ctx.activeProjectId === schedule.projectId && ws.readyState === 1) {
      // toast: true — the web client fires a toast for this out-of-band answer (the bubble
      // still renders + persists); the CLI ignores the field like openPanel. The user may
      // not be looking at the chat when a scheduled command fires.
      ws.send(JSON.stringify({ type: 'answer', data: text, toast: true }));
      return 'connected session';
    }
  }
  appendScheduleLog(`${schedule.projectName || schedule.projectId} — "${schedule.command}": ${text}`);
  return 'schedule log';
}

/**
 * Run one schedule fire. Marks the schedule fired immediately (before the async work) so
 * the tick can never double-fire while a task waits in the queue; the actual run goes
 * through taskQueue to stay off the chat-turn path. `alreadyMarked` is set by callers that
 * recorded the fire time themselves (the scheduler tick batches every due schedule into one
 * persist; the file-event path marks its single throttled fire) so no second immediate
 * write happens (audit 2026-08-17). Phase 4: reminders are deliberately NOT queued or
 * re-matched — they are plain text with nothing to validate, so they deliver synchronously
 * (a single ws.send, trivially cheap on the tick).
 */
export function fireSchedule(schedule, alreadyMarked = false) {
  if (!alreadyMarked) markFired(schedule.id);
  if (schedule.kind === 'reminder') {
    deliverReminder(schedule);
    return;
  }
  enqueueTask(schedule.projectId, `schedule:${schedule.intentId}`, () => runScheduled(schedule));
}

/**
 * Deliver a fired reminder: prefer the creating project's live session (web or CLI — both
 * appear in the registry), else ANY live session (reminders are personal, not project
 * assets), else the schedule log. Delivery rides the connection's intercepted ws.send, so
 * it renders AND persists exactly like a typed answer.
 */
function deliverReminder(schedule) {
  const text = `🔔 Reminder ("${schedule.label}"): ${schedule.text}`;
  let target = null;
  // Phase 19: when a multi-user reminder names its creator and that user is connected,
  // deliver to THEIR session specifically (the roadmap's explicit attribution rule); the
  // creator's session wins over the generic project-session preference below.
  if (schedule.createdBy && schedule.createdBy !== 'local') {
    for (const [ws, ctx] of connectionRegistry) {
      if (ctx.displayName === schedule.createdBy && ws.readyState === 1) {
        target = ws;
        break;
      }
    }
  }
  if (!target) {
    for (const [ws, ctx] of connectionRegistry) {
      if (ctx.activeProjectId === schedule.projectId && ws.readyState === 1) {
        target = ws;
        break;
      }
    }
  }
  if (!target) {
    for (const [ws, ctx] of connectionRegistry) {
      if (ctx.activeProjectId && ws.readyState === 1) {
        target = ws;
        break;
      }
    }
  }
  if (target) {
    target.send(JSON.stringify({ type: 'answer', data: text, toast: true }));
    // Phase 15: fired reminders are ALSO eligible for desktop/webhook notification (a user
    // who isn't watching the console still gets buzzed). Delivery to the live session is
    // unaffected — the notification is additive.
    notify(schedule.projectId, 'reminder-fired', {
      title: `Reminder: ${schedule.text}`,
      body: `${schedule.label}`,
    });
    return 'connected session';
  }
  appendScheduleLog(`🔔 Reminder (${schedule.projectName || schedule.projectId}): "${schedule.text}" — ${schedule.label}`);
  return 'schedule log';
}

async function runScheduled(schedule) {
  const project = state.activeProjectsCache.find((p) => p.id === schedule.projectId);
  if (!project) {
    appendScheduleLog(`${schedule.projectName || schedule.projectId}: skipped — project no longer scanned. Remove the schedule with \`remove schedule ${schedule.id}\`.`);
    return;
  }
  const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === schedule.projectId);

  let matchResult;
  try {
    matchResult = await matchInput(schedule.command, project, projectIndex, { model: null });
  } catch (err) {
    appendScheduleLog(`${project.name}: match failed — ${err.message}`);
    return;
  }

  const intentId = matchResult.builtin || null;
  if (!intentId || !isReadOnlyIntent(intentId)) {
    // Drift guard: same check as schedule creation, at fire time. Never run anything the
    // creation-time gate would have rejected — a changed embedding/learned-intent set could
    // send the phrase somewhere mutating after the schedule was created.
    appendScheduleLog(`${project.name}: skipped fire — "${schedule.command}" no longer resolves to a read-only intent (${readOnlySummary()}).`);
    return;
  }

  // Fake ws: builtin handlers only ever call ws.send({type:'answer'|'error_output'|...})
  // and read ws.readyState — collect everything instead of streaming to nobody.
  let output = '';
  const fakeWs = {
    readyState: 1,
    send: (data) => {
      try {
        const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
        if ((parsed.type === 'answer' || parsed.type === 'error_output' || parsed.type === 'warning') && parsed.data) {
          const text = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);
          output += output ? `\n\n${text}` : text;
        }
      } catch {
        // unparseable — nothing to collect
      }
    },
  };
  const context = {
    activeProjectId: project.id,
    currentSessionId: null,
    workspaceProjectIds: [],
    aiEnabled: false,
    aiModel: null,
    aiMode: 'default',
    conversationHistory: [],
    aiAbortController: null,
    executeInFlight: false,
    toolGrants: new Set(),
  };

  try {
    await handleBuiltinIntent(fakeWs, intentId, schedule.command, project, context);
  } catch (err) {
    appendScheduleLog(`${project.name}: fire crashed — ${err.message}`);
    return;
  }

  const text = `${scheduleHeader(schedule)}:\n\n${output || '(ran with no output)'}`;
  deliverResult(schedule, text);

  // Phase 2: only fires worth a notification are ones that produced output — an empty
  // "all clear" still answers the chat/log but doesn't buzz anyone.
  if (output.trim()) {
    notify(project.id, 'schedule-find', {
      title: `${project.name}: scheduled check has results`,
      body: `${schedule.label} — \`${schedule.command}\`\n${output.slice(0, 400)}`,
    });
  }
}