// Phase 2 notification admin commands (`notify me when <event>` / `stop notifying me about
// <event>` / `list notifications` / `webhook add <url>` / `webhook remove <url>` / `test
// notification`). Dispatched from connectionExecute.js in the same pre-matcher admin tier as
// telemetry/pack/schedule commands — each returns true when it consumed the message. No new
// intents or WS message types: everything answers through the existing `answer` bubble.
//
// Every branch must send a trailing `end` after its answer: the frontend only clears its
// `commandPending` flag on `end` (wsMessageCases.ts), so an answer without one leaves the
// terminal stuck on "Running..." forever — the 2026-08-14 mode-switch bug class.

import { resolveEventName, eventListText } from '../notify/notifyEvents.js';
import { getRules, setEventEnabled, getWebhooks, addWebhook, removeWebhook } from '../notify/notifyStore.js';
import { notify } from '../notify.js';
import { isSafeExternalUrl } from '../urlSafety.js';
import { addWatchRule, removeWatchRule, getWatchRules, setWatchRuleEnabled } from '../watchRules.js';
import { syncWatchRules } from '../watchEngine.js';

const end = (ws) => ws.send(JSON.stringify({ type: 'end' }));

export async function handleNotifyCommand(ws, project, lowerInput, input) {
  if (/^test\s+notification$/.test(lowerInput)) {
    await runTestNotification(ws, project);
    return true;
  }

  // Phase 15 (2026-08-12): generalized file-watch rules — "notify me when files change in
  // <folder>", "notify me if <folder> hasn't changed in N days", "stop watching <folder>",
  // "list watched folders". Notification-only by design: the rule fires notify.js channels,
  // never a command.
  const watchMatch = lowerInput.match(/^notify\s+me\s+(?:when|if)\s+(?:files?\s+)?(change|are\s+added|is\s+added|a\s+new\s+file\s+appears)\s+in\s+(.+)$/);
  if (watchMatch) {
    const folder = watchMatch[2].trim().replace(/["'`]/g, '');
    if (!folder) {
      ws.send(JSON.stringify({ type: 'answer', data: 'Which folder? Try `notify me when files change in C:\\Users\\you\\Documents`.' }));
      end(ws);
      return true;
    }
    const event = watchMatch[1].includes('change') ? 'file-changed' : 'file-added';
    const rule = addWatchRule({ folder, event, projectId: project.id, projectName: project.name });
    syncWatchRules();
    // Phase 15 audit: carrying openPanel on the answer opens the Notifications panel for the
    // web client (CLI ignores openPanel — the text stays self-sufficient).
    ws.send(JSON.stringify({ type: 'answer', data: `Watching **${folder}** for ${event === 'file-changed' ? 'file changes' : 'new files'} — desktop/webhook notifications will fire when the event is enabled (\`notify me when ${event}\`).`, openPanel: 'notifications' }));
    end(ws);
    return true;
  }

  const staleMatch = lowerInput.match(/^notify\s+me\s+if\s+(.+?)\s+hasn'?t\s+changed\s+in\s+(\d+)\s+days?$/);
  if (staleMatch) {
    const folder = staleMatch[1].trim().replace(/["'`]/g, '');
    const days = parseInt(staleMatch[2], 10);
    if (!folder || !days || days < 1 || days > 365) {
      ws.send(JSON.stringify({ type: 'answer', data: 'Say it like: `notify me if C:\\Users\\you\\Downloads hasn\'t changed in 7 days`.' }));
      end(ws);
      return true;
    }
    const rule = addWatchRule({ folder, event: 'folder-stale', days, projectId: project.id, projectName: project.name });
    ws.send(JSON.stringify({ type: 'answer', data: `Stale-check watching **${folder}** (no changes for ${days} days) — fires once per day once it goes stale.`, openPanel: 'notifications' }));
    end(ws);
    return true;
  }

  if (/^stop\s+watching\s+(.+)$/.test(lowerInput)) {
    const folder = lowerInput.match(/^stop\s+watching\s+(.+)$/)[1].trim().replace(/["'`]/g, '');
    const matches = getWatchRules().filter((r) => r.folder.toLowerCase() === folder.toLowerCase());
    if (matches.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No watch rule for **${folder}** — \`list watched folders\` shows what's being watched.` }));
      end(ws);
      return true;
    }
    matches.forEach((r) => removeWatchRule(r.id));
    syncWatchRules();
    ws.send(JSON.stringify({ type: 'answer', data: `Stopped watching **${folder}** (${matches.length} rule${matches.length === 1 ? '' : 's'} removed).` }));
    end(ws);
    return true;
  }

  // Per-rule enable/disable (audit 2026-08-17): the Notifications panel's per-rule toggle.
  // Disabling keeps the rule but stops it firing; re-enabling restores it.
  const enableRuleMatch = lowerInput.match(/^enable\s+watch\s+rule\s+(.+)$/);
  if (enableRuleMatch) {
    const rule = setWatchRuleEnabled(enableRuleMatch[1].trim(), true);
    ws.send(JSON.stringify({ type: 'answer', data: rule ? `Watch rule \`${rule.id}\` (**${rule.folder}**) is now enabled.` : `No watch rule \`${enableRuleMatch[1].trim()}\` — \`list watched folders\` shows the ids.` }));
    end(ws);
    return true;
  }

  const disableRuleMatch = lowerInput.match(/^disable\s+watch\s+rule\s+(.+)$/);
  if (disableRuleMatch) {
    const rule = setWatchRuleEnabled(disableRuleMatch[1].trim(), false);
    ws.send(JSON.stringify({ type: 'answer', data: rule ? `Watch rule \`${rule.id}\` (**${rule.folder}**) is now disabled — it won't fire until re-enabled.` : `No watch rule \`${disableRuleMatch[1].trim()}\` — \`list watched folders\` shows the ids.` }));
    end(ws);
    return true;
  }

  if (lowerInput === 'list watched folders') {
    const rules = getWatchRules();
    if (rules.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No watched folders yet. Try `notify me when files change in C:\\Users\\you\\Documents`.' }));
      end(ws);
      return true;
    }
    const rows = rules.map((r, i) => `${i + 1}. **${r.folder}** — ${r.event === 'folder-stale' ? `stale after ${r.days} days` : r.event === 'file-changed' ? 'file changes' : 'new files'} (\`${r.id}\`)`);
    ws.send(JSON.stringify({ type: 'answer', data: `### Watched folders (${rules.length})\n\n${rows.join('\n')}\n\nStop one with \`stop watching <folder>\`.` }));
    end(ws);
    return true;
  }

  const enableMatch = lowerInput.match(/^notify\s+me\s+(?:when|on|about)\s+(.+)$/);
  if (enableMatch) {
    const event = resolveEventName(enableMatch[1]);
    if (!event) {
      ws.send(JSON.stringify({ type: 'answer', data: `I know these notification events:\n\n${eventListText()}\n\nTry \`notify me when dev-server-crash\`.` }));
      end(ws);
      return true;
    }
    setEventEnabled(event, true);
    ws.send(JSON.stringify({ type: 'answer', data: `**${event}** notifications are now ON for **[${project.name}]**. Channels: desktop${getWebhooks().length ? ` + ${getWebhooks().length} webhook${getWebhooks().length === 1 ? '' : 's'}` : ''}. Try \`test notification\` to verify.` }));
    end(ws);
    return true;
  }

  const disableMatch = lowerInput.match(/^stop\s+notifying\s+me\s+(?:about|on|when)\s+(.+)$/);
  if (disableMatch) {
    const event = resolveEventName(disableMatch[1]);
    if (!event) {
      ws.send(JSON.stringify({ type: 'answer', data: `I know these notification events:\n\n${eventListText()}` }));
      end(ws);
      return true;
    }
    setEventEnabled(event, false);
    ws.send(JSON.stringify({ type: 'answer', data: `**${event}** notifications are now OFF.` }));
    end(ws);
    return true;
  }

  if (lowerInput === 'list notifications') {
    const rules = getRules();
    const enabled = Object.entries(rules.events).filter(([, v]) => v).map(([k]) => k);
    const webhooks = getWebhooks();
    ws.send(JSON.stringify({
      type: 'answer',
      data: `### Notifications\n\n` +
        `**Events:** ${enabled.length ? enabled.map((e) => `\`${e}\``).join(', ') : 'none enabled — try \`notify me when dev-server-crash\`'}\n` +
        `**Desktop channel:** ${rules.desktop ? 'on' : 'off'} (turns on automatically when an event is enabled)\n` +
        `**Webhooks:** ${webhooks.length === 0 ? 'none — try \`webhook add https://example.com/hook\`' : webhooks.map((u, i) => `${i + 1}. ${u}`).join('\n')}`,
    }));
    end(ws);
    return true;
  }

  const addMatch = lowerInput.match(/^webhook\s+add\s+(\S+)$/);
  if (addMatch) {
    await addWebhookCommand(ws, project, addMatch[1]);
    return true;
  }

  const removeMatch = lowerInput.match(/^webhook\s+remove\s+(\S+)$/);
  if (removeMatch) {
    const removed = removeWebhook(removeMatch[1]);
    ws.send(JSON.stringify({
      type: 'answer',
      data: removed ? `Removed webhook \`${removed}\`.` : `No webhook \`${removeMatch[1]}\` configured — \`list notifications\` shows what's there.`,
    }));
    end(ws);
    return true;
  }

  return false;
}

async function addWebhookCommand(ws, project, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    ws.send(JSON.stringify({ type: 'answer', data: `\`${rawUrl}\` isn't a valid URL.` }));
    end(ws);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ws.send(JSON.stringify({ type: 'answer', data: `Webhooks must be http(s) URLs — \`${rawUrl}\` isn't.` }));
    end(ws);
    return;
  }
  if (!isSafeExternalUrl(parsed)) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `**Rejected: \`${rawUrl}\`** — internal/private addresses (localhost, 127.x, 10.x, 192.168.x, 169.254.x, ::1, fe80::) are blocked by the same SSRF guard the web-search fetch uses. Use a public https webhook URL (e.g. a Slack/Discord incoming webhook).`,
    }));
    end(ws);
    return;
  }
  if (addWebhook(rawUrl)) {
    ws.send(JSON.stringify({ type: 'answer', data: `Webhook added: \`${rawUrl}\`. Events fire to it as soon as a notification event is enabled. Try \`test notification\`.` }));
  } else {
    ws.send(JSON.stringify({ type: 'answer', data: `\`${rawUrl}\` is already configured.` }));
  }
  end(ws);
}

async function runTestNotification(ws, project) {
  const rules = getRules();
  if (!rules.desktop && getWebhooks().length === 0) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Nothing configured yet — enable an event (\`notify me when dev-server-crash\`) and/or add a webhook (\`webhook add https://example.com/hook\`), then run \`test notification\` again.`,
    }));
    end(ws);
    return;
  }
  const results = await notify(project.id, 'dev-server-crash', {
    title: `Project Console test — ${project.name}`,
    body: 'This is a test notification. If you can read this (desktop or webhook), notifications are working.',
  });
  const lines = results.map((r) => {
    const target = r.channel === 'webhook' ? ` (\`${r.url}\`)` : '';
    return r.ok
      ? `  - ${r.channel}${target}: sent ✅`
      : `  - ${r.channel}${target}: failed — ${r.reason || `HTTP ${r.status}`}`;
  });
  ws.send(JSON.stringify({
    type: 'answer',
    data: `**Test notification** for **[${project.name}]**:\n\n${lines.join('\n')}\n\n(Desktop toasts may silently no-op on Windows 11 without a registered app id — the webhook is the verifiable channel.)`,
  }));
  end(ws);
}