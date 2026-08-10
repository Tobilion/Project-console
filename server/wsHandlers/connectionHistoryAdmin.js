// Phase 4 (2026-08-10): action-history admin commands (`show history` / `revert action`).
// Dispatched from connectionExecute.js in the same pre-matcher admin tier as schedules and
// notifications. File restores are confirm-gated (they overwrite the current file), git/command
// entries are answer-only (the exact git command to run yourself — the console never rewrites
// git history on its own). Every revert that actually executes is itself logged as an action
// (see revertAction in actionHistory.js) so the history stays complete.

import crypto from 'crypto';
import { pendingConfirmations } from '../state.js';
import { getAction, listActions, revertAction } from '../actionHistory.js';

const TYPE_LABELS = {
  file_write: 'WRITE',
  file_edit: 'EDIT',
  file_insert: 'INSERT',
  file_append: 'APPEND',
  command: 'CMD',
  git: 'GIT',
  revert: 'REVERT',
};

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));

function formatList(project, actions) {
  if (actions.length === 0) {
    return `No actions recorded yet in **[${project.name}]** — file writes and confirmed commands will show up here.`;
  }
  const rows = actions.map((a) => {
    const at = new Date(a.ts).toLocaleString();
    const tag = TYPE_LABELS[a.type] || a.type.toUpperCase();
    return `- \`${a.id}\` \`${tag}\` ${at} — ${a.description}`;
  });
  return `### Recent actions in **[${project.name}]**\n\n${rows.join('\n')}\n\nRevert one with \`revert action <id>\` (file actions ask for confirmation; git actions answer with the command to run).`;
}

export async function handleHistoryCommand(ws, project, lowerInput, input) {
  const showMatch = lowerInput.match(/^(?:show\s+history|recent\s+actions)(?:\s+(\d{1,3}))?$/);
  if (showMatch) {
    const limit = showMatch[1] ? Math.min(parseInt(showMatch[1], 10), 100) : 15;
    answer(ws, formatList(project, listActions(project.path, { limit })));
    return true;
  }

  const revertMatch = lowerInput.match(/^revert\s+action\s+(\S+)$/);
  if (revertMatch) {
    const id = revertMatch[1];
    const action = getAction(project.path, id);
    if (!action) {
      answer(ws, `No action with id \`${id}\` in **[${project.name}]** — try \`show history\`.`);
      return true;
    }
    if (action.type.startsWith('file_')) {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: `revert action ${id} (${action.existed ? 'restores' : 'deletes'} ${action.path})`,
        trigger: `revert_action_${id}`,
        createdAt: Date.now(),
        revert: { actionId: id },
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt',
        token,
        command: `revert action ${id} — this ${action.existed ? 'overwrites the current' : 'deletes the'} file \`${action.path}\` with its state before that action`,
        trigger: 'revert_action',
      }));
      return true;
    }
    // git / command / revert entries: answer-only advice, never auto-run.
    const result = await revertAction(project.path, id);
    if (result.ok) {
      answer(ws, result.data);
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: `${result.error}\n` }));
    }
    return true;
  }

  return false;
}
