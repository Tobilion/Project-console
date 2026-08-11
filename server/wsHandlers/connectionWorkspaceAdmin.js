import path from 'path';
import { state } from '../state.js';
import {
  collectCoreBundle, exportableProjectCandidates, attachProjectFiles,
  writeWorkspaceBundle, readWorkspaceBundle, applyWorkspaceBundle,
} from '../workspaceTransfer.js';

// Phase 6 (2026-08-11): `export workspace` / `import workspace <path>` admin commands.
// Same two-step preview-then-confirm shape as the pack installer: export first asks which
// projects' memory/tools to include (an opt-in list, never silent), import previews exactly
// what will be overwritten before anything is written. Local files only — no network.
const PENDING_TTL_MS = 5 * 60 * 1000;

function send(ws, type, data) {
  ws.send(JSON.stringify({ type, data }));
}

function downloadLink(fileName) {
  return state.serverPort
    ? `http://127.0.0.1:${state.serverPort}/api/workspace/export?file=${fileName}`
    : null;
}

function finalizeExport(ws, sessionContext, bundle, summary) {
  const { filePath, fileName } = writeWorkspaceBundle(bundle);
  let msg = `✓ Workspace exported to \`${filePath}\`\n\n**Included:** ${summary}`;
  const link = downloadLink(fileName);
  if (link) msg += `\n\n[Download workspace export](${link})`;
  msg += '\n\nTo restore this on another machine: `import workspace <path>` (or `import workspace` followed by the full path).';
  send(ws, 'answer', msg);
  send(ws, 'end');
  sessionContext.pendingWorkspaceExport = null;
}

function candidateListMessage(candidates) {
  const lines = candidates.map((c, i) => {
    const parts = [];
    if (c.hasMemory) parts.push('memory.md');
    if (c.hasTools) parts.push('console.tools.json');
    return `  ${i + 1}. **${c.name}** — ${parts.join(' + ')}`;
  });
  return lines.join('\n');
}

function parseProjectNumbers(raw, count) {
  const nums = raw.split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));
  const unique = [...new Set(nums)];
  const valid = unique.filter((n) => n >= 1 && n <= count);
  return valid.length === unique.length ? valid : null;
}

/** "export workspace" / "import workspace <path>" — the preview half of the flow. */
export async function handleWorkspaceCommand(ws, project, lowerInput, rawInput, sessionContext) {
  if (lowerInput === 'export workspace') {
    const bundle = collectCoreBundle();
    const candidates = exportableProjectCandidates();
    if (candidates.length === 0) {
      finalizeExport(ws, sessionContext, bundle, 'profile, confidence model, tuning and intent-threshold overrides (no projects have memory/tools yet)');
      return true;
    }
    sessionContext.pendingWorkspaceExport = { bundle, candidates, createdAt: Date.now() };
    let msg = `**Workspace export — project opt-in**\n\nThe core bundle (profile, confidence model, tuning + intent-threshold overrides) is ready. These projects have exportable memory/tools:\n\n${candidateListMessage(candidates)}\n\nReply \`export workspace with projects 1 3\` (or \`with all projects\`), or \`export workspace without projects\` to skip them.`;
    send(ws, 'answer', msg);
    send(ws, 'end');
    return true;
  }

  const match = rawInput.trim().match(/^import workspace\s+(.+)$/i);
  if (match) {
    const rawPath = match[1].trim().replace(/^["']|["']$/g, '');
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    const result = readWorkspaceBundle(resolvedPath);
    if (result.error) {
      send(ws, 'error_output', `${result.error}\n`);
      send(ws, 'end');
      return true;
    }
    const bundle = result.bundle;
    const sections = bundle.sections;
    const lines = [];
    lines.push(`**Workspace import preview** — "${resolvedPath}"`);
    if (bundle.exportedAt) lines.push(`\nExported ${bundle.exportedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}${bundle.consoleVersion ? ` by console v${bundle.consoleVersion}` : ''}.`);
    const parts = [];
    if (sections.profile && typeof sections.profile === 'object') {
      parts.push(`profile (name: ${sections.profile.name || '(empty)'})`);
    }
    if (sections.confidenceModel && typeof sections.confidenceModel === 'object') {
      parts.push('trained confidence model');
    }
    const tuningCount = sections.tuning && typeof sections.tuning === 'object' ? Object.keys(sections.tuning).length : 0;
    if (tuningCount > 0) parts.push(`${tuningCount} tuning override(s)`);
    const thresholdCount = sections.thresholds && typeof sections.thresholds === 'object' ? Object.keys(sections.thresholds).length : 0;
    if (thresholdCount > 0) parts.push(`${thresholdCount} intent-threshold override(s)`);
    const projects = Array.isArray(sections.projects) ? sections.projects.filter((p) => p && typeof p === 'object') : [];
    if (projects.length > 0) {
      parts.push(`${projects.length} project(s)`);
      for (const p of projects) {
        const what = [];
        if (typeof p.memoryMd === 'string') what.push('memory.md');
        if (p.toolsJson && typeof p.toolsJson === 'object') what.push('console.tools.json');
        lines.push(`\n  - **${p.name || p.id}** — ${what.length ? what.join(' + ') : '(no readable content)'}`);
      }
    }
    if (parts.length === 0) {
      send(ws, 'answer', `Nothing importable in "${resolvedPath}" — the bundle has no recognized sections.`);
      send(ws, 'end');
      return true;
    }
    lines.push(`\nThis will **overwrite** your current ${parts.join(', ')}. Projects whose id isn't on this machine will be skipped (rescan first).`);
    lines.push('\nReply `confirm import workspace` to import, or `cancel import workspace` to discard.');
    sessionContext.pendingWorkspaceImport = { bundle, resolvedPath, createdAt: Date.now() };
    send(ws, 'answer', lines.join('\n'));
    send(ws, 'end');
    return true;
  }

  return false;
}

/** "export workspace with/without ..." + "confirm/cancel import workspace" — the commit half.
 *  Runs in the interceptor chain (before the admin tier) exactly like the pack reply handler,
 *  so these phrases can never reach the matcher. */
export async function handlePendingWorkspaceReply(ws, project, lowerInput, sessionContext) {
  const pendingExport = sessionContext.pendingWorkspaceExport;
  if (pendingExport && (lowerInput.startsWith('export workspace with') || lowerInput === 'export workspace without projects')) {
    if (Date.now() - pendingExport.createdAt > PENDING_TTL_MS) {
      sessionContext.pendingWorkspaceExport = null;
      send(ws, 'answer', 'That workspace export draft expired — run `export workspace` again.');
      send(ws, 'end');
      return true;
    }
    const { bundle, candidates } = pendingExport;
    let selectedIds = [];
    if (lowerInput === 'export workspace without projects') {
      selectedIds = [];
    } else if (/with all projects/.test(lowerInput)) {
      selectedIds = candidates.map((c) => c.id);
    } else {
      const numsMatch = lowerInput.match(/with projects\s+([\d,\s]+)$/);
      if (!numsMatch) {
        send(ws, 'answer', 'Couldn\'t read project numbers — try `export workspace with projects 1 3` or `export workspace with all projects`.');
        send(ws, 'end');
        return true;
      }
      const nums = parseProjectNumbers(numsMatch[1], candidates.length);
      if (!nums) {
        send(ws, 'answer', `Invalid project numbers — pick from 1 to ${candidates.length} (e.g. \`export workspace with projects 1 3\`).`);
        send(ws, 'end');
        return true;
      }
      selectedIds = nums.map((n) => candidates[n - 1].id);
    }
    const attached = attachProjectFiles(bundle, candidates, selectedIds);
    const summary = 'profile, confidence model, tuning + intent-threshold overrides' +
      (attached.length ? `\n\nProjects included:\n${attached.map((p) => `  - ${p.name}`).join('\n')}` : '');
    finalizeExport(ws, sessionContext, bundle, summary);
    return true;
  }

  // An export/import phrase with no matching pending state is consumed with a hint rather
  // than leaked into the matcher (mirrors the pack installer's expired-preview answer).
  if (lowerInput === 'export workspace without projects' || lowerInput.startsWith('export workspace with')) {
    send(ws, 'answer', 'No workspace export draft is pending — start with `export workspace` first.');
    send(ws, 'end');
    return true;
  }

  const pendingImport = sessionContext.pendingWorkspaceImport;
  if (!pendingImport) return false;
  if (lowerInput !== 'confirm import workspace' && lowerInput !== 'cancel import workspace') return false;

  const pending = pendingImport;
  sessionContext.pendingWorkspaceImport = null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    send(ws, 'answer', 'That workspace import preview expired — run `import workspace <path>` again.');
    send(ws, 'end');
    return true;
  }
  if (lowerInput === 'cancel import workspace') {
    send(ws, 'answer', 'Cancelled — nothing was imported.');
    send(ws, 'end');
    return true;
  }

  const { applied, skipped } = applyWorkspaceBundle(pending.bundle);
  let msg = '✓ Workspace imported.';
  if (applied.length) {
    msg += `\n\n**Applied:**\n${applied.map((a) => `  - ${a}`).join('\n')}`;
  }
  if (skipped.length) {
    msg += `\n\n**Skipped:**\n${skipped.map((s) => `  - ${s.name}: ${s.skipped}`).join('\n')}`;
  }
  if (applied.length === 0 && skipped.length === 0) {
    msg = 'Nothing to import — the bundle contains no recognized sections.';
  }
  send(ws, 'answer', msg);
  send(ws, 'end');
  return true;
}
