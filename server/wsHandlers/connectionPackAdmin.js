import fs from 'fs/promises';
import path from 'path';
import { validateToolEntry, sanitizePermissions, MANIFEST_FILENAME } from '../pluginTools.js';

// Plugin/pack install mechanism — infrastructure expansion (2026-08-10, "new infrastructure,
// not just more intents"). console.tools.json (pluginTools.js) was already a real per-project
// plugin surface — custom shell-command tools the AI can call, gated by the same
// isSafeParamValue/isCommandBlocked runtime checks as everything else. What it lacked was any
// way to SHARE one: every custom tool had to be hand-typed into a project's own manifest. This
// adds a two-step install flow — preview, then explicit confirm — for merging someone else's
// exported console.tools.json-shaped file into your own project. It deliberately does NOT fetch
// packs from a URL/registry: that would mean this app deciding what's safe to download and run,
// which is a real hosting/vetting commitment, not a chat command. Local file only, same trust
// model as "you chose to open this file on your own machine."
//
// Nothing about tool EXECUTION changes here — an installed pack tool is invoked through the
// exact same createPluginToolFn() path (with its own isSafeParamValue/isCommandBlocked checks)
// as a tool you'd typed into console.tools.json by hand. This only adds a safer way to get it
// there than manual copy-paste.
const PENDING_TTL_MS = 5 * 60 * 1000;
const PREVIEW_MAX_TOOLS = 12;

function summarizeTool(t) {
  const risky = t.risky ? ' [risky]' : '';
  return `  - **${t.name}**${risky}: ${t.description}\n    \`${t.command}\``;
}

/** Reads and schema-validates a pack file (same shape as console.tools.json). Returns
 *  { tools, permissions, errors } or null if the file couldn't be read/parsed at all. */
async function readPackFile(resolvedPath) {
  let raw;
  try {
    raw = await fs.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    return { error: `Couldn't read "${resolvedPath}": ${err.code === 'ENOENT' ? 'file not found' : err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `"${resolvedPath}" isn't valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) {
    return { error: `"${resolvedPath}" doesn't look like a pack — expected an object with a "tools" array (same shape as console.tools.json).` };
  }
  const tools = [];
  const errors = [];
  parsed.tools.forEach((entry, i) => {
    const result = validateToolEntry(entry, i);
    if (result.valid) tools.push(entry);
    else errors.push(...result.errors);
  });
  const permissions = sanitizePermissions(parsed.permissions);
  return { tools, permissions, errors };
}

/** "install pack <path>" / "list packs" / "pack list" — the preview half of the flow. Returns
 *  true when the input matched and was consumed. */
export async function handlePackCommand(ws, project, lowerInput, rawInput, sessionContext) {
  if (lowerInput === 'list packs' || lowerInput === 'pack list' || lowerInput === 'list tools' || lowerInput === 'list custom tools') {
    const manifestPath = path.join(project.path, MANIFEST_FILENAME);
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
      if (tools.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has a ${MANIFEST_FILENAME} but no custom tools defined.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**Custom tools in [${project.name}]** (${tools.length}):\n\n${tools.map(summarizeTool).join('\n')}` }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'answer', data: err.code === 'ENOENT' ? `**[${project.name}]** has no ${MANIFEST_FILENAME} yet — no custom tools installed. Use \`install pack <path>\` to add one.` : `Couldn't read ${MANIFEST_FILENAME}: ${err.message}` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  const match = rawInput.trim().match(/^install pack\s+(.+)$/i);
  if (match) {
    const rawPath = match[1].trim().replace(/^["']|["']$/g, '');
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.join(project.path, rawPath);
    const result = await readPackFile(resolvedPath);
    if (result.error) {
      ws.send(JSON.stringify({ type: 'error_output', data: `${result.error}\n` }));
      ws.send(JSON.stringify({ type: 'end' }));
      return true;
    }
    const { tools, permissions, errors } = result;
    if (tools.length === 0 && !permissions) {
      ws.send(JSON.stringify({ type: 'answer', data: `Nothing installable in "${resolvedPath}"${errors.length ? ` — every entry failed validation:\n${errors.join('\n')}` : '.'}` }));
      ws.send(JSON.stringify({ type: 'end' }));
      return true;
    }
    sessionContext.pendingPackInstall = { resolvedPath, tools, permissions, createdAt: Date.now() };
    let msg = `**Pack preview** — "${resolvedPath}"\n\n`;
    msg += `${tools.length} tool(s) to install:\n\n${tools.slice(0, PREVIEW_MAX_TOOLS).map(summarizeTool).join('\n')}`;
    if (tools.length > PREVIEW_MAX_TOOLS) msg += `\n  …and ${tools.length - PREVIEW_MAX_TOOLS} more`;
    if (permissions) msg += `\n\nAlso sets permission overrides for: ${Object.keys(permissions).join(', ')}`;
    if (errors.length) msg += `\n\n${errors.length} entr(y/ies) skipped for failing validation:\n${errors.join('\n')}`;
    msg += `\n\nA tool with the same name as one you already have will be overwritten. \`risky\`-flagged tools still require confirmation every time they're actually called — this only installs them, it doesn't grant standing permission.\n\nReply \`confirm install pack\` to install, or \`cancel install pack\` to discard.`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  return false;
}

/** "confirm install pack" / "cancel install pack" — the commit half. Checked early in the
 *  interceptor chain (connectionExecute.js), same tier as the other pendingX reply handlers, so
 *  it fires before typed-command bypass or the matcher ever sees these two phrases. */
export async function handlePendingPackInstallReply(ws, project, lowerInput, sessionContext) {
  const pending = sessionContext.pendingPackInstall;
  if (!pending) return false;
  if (lowerInput !== 'confirm install pack' && lowerInput !== 'cancel install pack') return false;

  sessionContext.pendingPackInstall = null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    ws.send(JSON.stringify({ type: 'answer', data: 'That pack preview expired — run `install pack <path>` again.' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'cancel install pack') {
    ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled — nothing was installed.' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  const manifestPath = path.join(project.path, MANIFEST_FILENAME);
  let manifest = { tools: [] };
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') manifest = parsed;
    if (!Array.isArray(manifest.tools)) manifest.tools = [];
  } catch {
    // No existing manifest (or unreadable) — start fresh rather than fail the install.
  }

  const byName = new Map(manifest.tools.map((t) => [t.name, t]));
  let added = 0, overwritten = 0;
  for (const tool of pending.tools) {
    if (byName.has(tool.name)) overwritten++; else added++;
    byName.set(tool.name, tool);
  }
  manifest.tools = [...byName.values()];
  if (pending.permissions) {
    manifest.permissions = { ...(manifest.permissions || {}), ...pending.permissions };
  }

  try {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    ws.send(JSON.stringify({
      type: 'answer',
      data: `✓ Installed. ${added} new tool(s), ${overwritten} overwritten. ${project.name}'s ${MANIFEST_FILENAME} now has ${manifest.tools.length} custom tool(s) — the file watcher picks them up automatically.`,
    }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error_output', data: `Couldn't write ${MANIFEST_FILENAME}: ${err.message}\n` }));
  }
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}
