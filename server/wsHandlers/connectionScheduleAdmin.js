// Phase 1 scheduler admin commands (`schedule` / `list schedules` / `remove schedule` /
// `review schedule log`). Dispatched from connectionExecute.js in the same pre-matcher admin
// tier as telemetry/pack/distillation commands — each command returns true when it consumed
// the message. A schedule is validated AT CREATION through the SAME matching pipeline a typed
// message would use (matchInput), and only read-only intents survive (see scheduleIntents.js);
// anything mutating, unambiguous, unresolved, or that resolves to a config-entry command is
// rejected with a clear error instead of being silently created and skipped later.

import { state } from '../state.js';
import { matchInput } from '../matcher.js';
import { parseIntervalPhrase } from '../schedules/scheduleParser.js';
import { addSchedule, getSchedules, removeSchedule } from '../schedules/scheduleStore.js';
import { isReadOnlyIntent, readOnlySummary } from '../schedules/scheduleIntents.js';
import { syncEventTriggerWatchers } from '../schedules/scheduler.js';
import { readScheduleLog } from '../schedules/scheduleFire.js';

// The interval phrase can span several words ("every 5 minutes"), so capture the longest
// recognized prefix and treat the rest as the trigger command. The optional "schedule "
// prefix is required for the bare phrases too ("schedule on file save X" reads exactly like
// "every ... X", just with an event interval instead of a time interval).
const SCHEDULE_RE = /^(?:schedule\s+)?(every\s+\d+\s*(?:minute|minutes|min|mins|hour|hours|hr|hrs)|daily\s+at\s+\d{1,2}:\d{2}|on\s+file\s+save|on\s+git\s+commit)\s+(.+)$/i;

export async function handleScheduleCommand(ws, project, lowerInput, input) {
  if (/^review\s+schedule\s*log$/.test(lowerInput)) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Schedule log\n\n\`\`\`\n${readScheduleLog()}\n\`\`\`` }));
    return true;
  }

  if (/^(list\s+schedules|my\s+schedules)$/.test(lowerInput)) {
    const schedules = getSchedules();
    if (schedules.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No schedules yet. Try \`schedule every 10 minutes "git status"\` — ${readOnlySummary()}.` }));
      return true;
    }
    const rows = schedules.map((s, i) => {
      const when = s.type === 'interval' ? `every ${s.everyMs / 60000} min` : s.type === 'daily' ? `daily ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}` : s.label;
      const last = s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString() : 'never';
      const owner = s.projectId === project.id ? '' : ` (${s.projectName || s.projectId})`;
      return `${i + 1}. **${s.id}**${owner} — ${when} → \`${s.command}\` — last fired ${last}`;
    });
    ws.send(JSON.stringify({ type: 'answer', data: `### Schedules\n\n${rows.join('\n')}` }));
    return true;
  }

  const removeMatch = lowerInput.match(/^remove\s+schedule\s+(\S+)$/);
  if (removeMatch) {
    const removed = removeSchedule(project.id, removeMatch[1]);
    syncEventTriggerWatchers();
    ws.send(JSON.stringify({
      type: 'answer',
      data: removed
        ? `Removed schedule \`${removed.id}\` ("${removed.command}", ${removed.label}).`
        : `No schedule \`${removeMatch[1]}\` exists for **[${project.name}]** — try \`list schedules\`.`,
    }));
    return true;
  }

  const scheduleMatch = lowerInput.match(SCHEDULE_RE);
  if (scheduleMatch) {
    await createSchedule(ws, project, input, scheduleMatch[1], stripTriggerQuotes(scheduleMatch[2].trim()));
    return true;
  }

  return false;
}

// Users often wrap the trigger command in quotes ("schedule every 10 minutes "git status"") —
// strip one matching outer pair so the matcher sees the bare command.
function stripTriggerQuotes(command) {
  const first = command[0];
  if (command.length >= 2 && (first === '"' || first === "'") && command[command.length - 1] === first) {
    return command.slice(1, -1).trim();
  }
  return command;
}

async function createSchedule(ws, project, rawInput, intervalPhrase, command) {
  const parsed = parseIntervalPhrase(intervalPhrase);
  if (!parsed.ok) {
    ws.send(JSON.stringify({ type: 'answer', data: parsed.reason }));
    return;
  }

  const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === project.id);
  let matchResult;
  try {
    matchResult = await matchInput(command, project, projectIndex, { model: null });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'answer', data: `Couldn't validate "${command}" — ${err.message}` }));
    return;
  }

  const intentId = matchResult.builtin || null;
  if (!intentId) {
    ws.send(JSON.stringify({ type: 'answer', data: `I can't schedule that: "${command}" didn't resolve to an intent. Scheduled commands must be ${readOnlySummary()}.` }));
    return;
  }
  if (matchResult.multi || matchResult.disambiguate) {
    ws.send(JSON.stringify({ type: 'answer', data: `Keep a scheduled command to one clear read-only intent — "${command}" reads as ambiguous.` }));
    return;
  }
  if (!isReadOnlyIntent(intentId)) {
    ws.send(JSON.stringify({ type: 'answer', data: `**Can't schedule "${command}"** — it resolves to a mutating or confirm-gated action (\`${intentId}\`), which can never run unattended. Scheduled commands must be ${readOnlySummary()}.` }));
    return;
  }
  if (matchResult.match) {
    ws.send(JSON.stringify({ type: 'answer', data: `**Can't schedule "${command}"** — it resolves to a project config command, and command schedules aren't supported yet (a config command could mutate anything). Scheduled commands must be ${readOnlySummary()}.` }));
    return;
  }

  const schedule = addSchedule({ projectId: project.id, projectName: project.name, spec: parsed, command, intentId });
  syncEventTriggerWatchers();
  ws.send(JSON.stringify({
    type: 'answer',
    data: `Scheduled ✅ — **${schedule.id}**: ${schedule.label} → \`${schedule.command}\` (intent \`${intentId}\`).\n\nResults post to this chat when someone is connected, otherwise to the schedule log (\`review schedule log\`). Manage with \`list schedules\` / \`remove schedule ${schedule.id}\`.`,
  }));
}