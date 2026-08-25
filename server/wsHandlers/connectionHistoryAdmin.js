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
  file_move: 'MOVE',
  command: 'CMD',
  git: 'GIT',
  revert: 'REVERT',
};

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));
const end = (ws) => ws.send(JSON.stringify({ type: 'end' }));

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
    end(ws);
    return true;
  }

  // Phase 4 (2026-08-10): `revert action <id>`. 2026-08-24: comma-separated ids are a BATCH
  // revert — the undo toast for multi-file ops (tidy / duplicate deletes journal one action
  // per file) sends `revert action <id1>,<id2>` with no other interface change. File actions
  // batch into ONE confirm card (each restore still runs through the same revertAction); a
  // mixed batch containing git/command/revert entries is refused — those are answer-only by
  // design and must stay one-at-a-time, so a batch can never silently bypass that contract.
  const revertMatch = lowerInput.match(/^revert\s+action\s+([\w,]+)$/);
  if (revertMatch) {
    const ids = [...new Set(revertMatch[1].split(',').filter(Boolean))];
    if (ids.length > 50) {
      answer(ws, `That's ${ids.length} actions — batch reverts are capped at 50. Run smaller batches.`);
      end(ws);
      return true;
    }
    const actions = ids.map((id) => ({ id, action: getAction(project.path, id) }));
    const missing = actions.find((a) => !a.action);
    if (missing) {
      answer(ws, `No action with id \`${missing.id}\` in **[${project.name}]** — try \`show history\`.`);
      end(ws);
      return true;
    }
    const nonFile = actions.find((a) => !a.action.type.startsWith('file_'));
    if (nonFile) {
      answer(ws, `\`${nonFile.id}\` is a ${TYPE_LABELS[nonFile.action.type] || 'git/command'} entry — batch revert is for file restores only. Revert git/command actions one at a time.`);
      end(ws);
      return true;
    }
    if (ids.length === 1) {
      const singleId = actions[0].id;
      const action = actions[0].action;
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: `revert action ${singleId} (${action.existed ? 'restores' : 'deletes'} ${action.path})`,
        trigger: `revert_action_${singleId}`,
        createdAt: Date.now(),
        revert: { actionId: singleId },
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt',
        token,
        command: `revert action ${singleId} — this ${action.existed ? 'overwrites the current' : 'deletes the'} file \`${action.path}\` with its state before that action`,
        trigger: 'revert_action',
      }));
      return true;
    }
    // Batch: one confirm card for all restores; the confirm branch loops revertAction per id.
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      owner: ws,
      projectId: project.id,
      command: `revert actions ${ids.join(', ')}`,
      trigger: `revert_action_${ids.join('_')}`,
      createdAt: Date.now(),
      revert: { actionIds: ids },
    });
    const fileList = actions.map((a) => `\`${a.action.path}\``).join(', ');
    ws.send(JSON.stringify({
      type: 'confirm_prompt',
      token,
      command: `revert ${ids.length} actions — restores/deletes ${fileList} to their state before those actions`,
      trigger: 'revert_action',
    }));
    return true;
  }

  return false;
}
