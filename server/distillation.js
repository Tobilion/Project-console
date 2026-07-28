import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DISTILL_DIR = path.join(process.cwd(), 'data', 'distillations');
const KNOWN_SCRIPT_NAMES = ['dev', 'start', 'build', 'preview', 'lint', 'test', 'format', 'deploy', 'publish', 'release'];
// Pending suggestions nobody has acted on after this long are stale noise — drop them so the
// log doesn't grow unbounded and `review distillations` doesn't dredge up ancient guesses.
const PRUNE_PENDING_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function ensureDir() {
  if (!fs.existsSync(DISTILL_DIR)) {
    fs.mkdirSync(DISTILL_DIR, { recursive: true });
  }
}

function filePath(projectId) {
  return path.join(DISTILL_DIR, `${projectId}.jsonl`);
}

function logRecord(projectId, entry) {
  ensureDir();
  const record = { id: crypto.randomUUID(), timestamp: Date.now(), ...entry };
  const fp = filePath(projectId);
  const fd = fs.openSync(fp, 'a');
  fs.writeSync(fd, JSON.stringify(record) + '\n');
  fs.closeSync(fd);
  return record.id;
}

export function readDistillations(projectId) {
  const fp = filePath(projectId);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function clearDistillations(projectId) {
  const fp = filePath(projectId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

/**
 * Drop pending records older than PRUNE_PENDING_AFTER_MS (applied/rejected records are kept —
 * only unresolved noise gets swept) and rewrite the log. Called opportunistically before each
 * analyzeAIExchange() so the file self-trims without needing a separate scheduled job.
 */
function pruneStalePending(projectId) {
  const records = readDistillations(projectId);
  if (records.length === 0) return;
  const cutoff = Date.now() - PRUNE_PENDING_AFTER_MS;
  const kept = records.filter(r => r.status !== 'pending' || r.timestamp >= cutoff);
  if (kept.length !== records.length) {
    const fp = filePath(projectId);
    fs.writeFileSync(fp, kept.length ? kept.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
  }
}

/**
 * Analyze a completed AI exchange and log any distillation suggestions.
 * Called from aiQuery.js after the AI tool-call loop finishes.
 */
export function analyzeAIExchange(project, { input, finalText, toolHistory }) {
  if (!project || !toolHistory?.length) return [];
  pruneStalePending(project.id);

  const ids = [];
  const existingPending = readDistillations(project.id).filter(r => r.status === 'pending');

  for (const entry of toolHistory) {
    const { tool, args, result, approved } = entry;

    // Command entry suggestion: AI ran a script via executeCommand
    if (tool === 'executeCommand' && result?.success !== false && args?.command) {
      const cmd = args.command.trim();
      const scriptName = inferScriptName(cmd);
      if (scriptName) {
        ids.push(logRecord(project.id, {
          type: 'command_entry',
          trigger: `run ${scriptName}`,
          action: cmd,
          description: `AI ran \`${cmd}\` — suggest trigger-mode entry`,
          confidence: scriptName === 'custom' ? 'low' : 'medium',
          occurrences: 1,
          status: 'pending',
        }));
      }
    }

    // Knowledge entry suggestion: AI read a file and produced a substantial explanation.
    // Skip if an equivalent pending suggestion for this exact trigger already exists — without
    // this, re-reading the same file across sessions logged an identical record every time.
    if (tool === 'readFile' && result?.success !== false && finalText?.length > 200) {
      const fileName = args?.path ? path.basename(args.path) : 'file';
      const trigger = `what is ${fileName.replace(/\.\w+$/, '')}`;
      const alreadyPending = existingPending.some(r => r.type === 'knowledge_entry' && r.trigger === trigger);
      if (!alreadyPending) {
        // Extract a summary from the first paragraph of the final text
        const summary = finalText.split('\n\n')[0]?.trim() || finalText.slice(0, 300);
        ids.push(logRecord(project.id, {
          type: 'knowledge_entry',
          trigger,
          answer: summary.length > 500 ? summary.slice(0, 500) + '...' : summary,
          description: `AI explained \`${args.path}\` — suggest knowledge entry`,
          confidence: finalText.length > 500 ? 'high' : 'medium',
          filePath: args.path,
          occurrences: 1,
          status: 'pending',
        }));
      }
    }

    // Note: writeFile/editFile activity used to also log a low-confidence "file_pattern"
    // suggestion here, but it was never turned into anything actionable (dead weight per its
    // own comment) and is now fully covered by projectMemory.js's file-edit-frequency nudge
    // (see the memory_suggestion flow), so it was removed rather than kept as a duplicate.
  }

  if (ids.length > 0) {
    console.log(`[Distillation] ${ids.length} suggestion(s) logged for ${project.id}`);
  }

  return ids;
}

function inferScriptName(command) {
  // Direct npm run <script> match
  const npmRun = command.match(/^npm run (\S+)/);
  if (npmRun) return npmRun[1];

  // Known single-word commands that map to npm scripts
  for (const name of KNOWN_SCRIPT_NAMES) {
    if (command === `npm run ${name}` || command === name) return name;
  }

  // Try to match against common patterns
  if (/^node\s/.test(command) && !/^node\s+-/.test(command)) return 'custom';
  if (/^npx\s/.test(command)) return 'custom';

  return null;
}

/**
 * Group pending distillation records into actionable suggestions for display.
 */
export function generateDistillationSuggestions(projectId) {
  const records = readDistillations(projectId);
  const pending = records.filter(r => r.status === 'pending');
  if (pending.length === 0) return [];

  // Group command_entry by action, knowledge_entry by filePath
  const groups = new Map();
  for (const r of pending) {
    const key = r.type === 'command_entry' ? r.action
              : r.filePath || r.answer?.slice(0, 50) || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, { ...r, occurrences: 0, ids: [] });
    }
    const g = groups.get(key);
    g.occurrences++;
    g.ids.push(r.id);
  }

  const suggestions = [];
  for (const [, g] of groups) {
    suggestions.push({
      id: g.ids[0],
      ids: g.ids,
      type: g.type,
      trigger: g.trigger,
      action: g.action,
      answer: g.answer,
      description: g.description,
      confidence: g.occurrences >= 2 ? 'high' : g.confidence,
      occurrences: g.occurrences,
      filePath: g.filePath,
    });
  }

  suggestions.sort((a, b) => b.occurrences - a.occurrences);
  return suggestions;
}

/**
 * Apply approved distillations — add entries to the project's console.config.json
 * and let the file watcher propagate the change.
 */
export function applyDistillation(projectId, suggestionIds, projectsCache) {
  const suggestions = generateDistillationSuggestions(projectId);
  const approved = suggestions.filter(s => suggestionIds.includes(s.id));

  if (approved.length === 0) return [];

  // Find the project in the cache to get its path
  const project = projectsCache.find(p => p.id === projectId);
  if (!project) return [];

  const configPath = path.join(project.path, 'console.config.json');
  let config = { entries: [] };

  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  if (!Array.isArray(config.entries)) config.entries = [];

  const added = [];

  for (const s of approved) {
    if (s.type === 'command_entry') {
      // Check if this action already exists
      const exists = config.entries.some(
        e => e.type === 'command' && e.action?.trim() === s.action?.trim()
      );
      if (exists) continue;

      config.entries.push({
        triggers: [s.trigger || `run ${s.action?.split(' ').pop() || 'script'}`],
        type: 'command',
        action: s.action,
        risky: /deploy|publish|release|--prod|force/i.test(s.action || ''),
        auto: true,
      });
      added.push({ type: 'command_entry', action: s.action, trigger: s.trigger });

    } else if (s.type === 'knowledge_entry') {
      const exists = config.entries.some(
        e => e.type === 'knowledge' && e.triggers?.includes(s.trigger)
      );
      if (exists) continue;

      config.entries.push({
        triggers: [s.trigger],
        type: 'knowledge',
        answer: s.answer || 'Information derived from AI analysis.',
        auto: true,
      });
      added.push({ type: 'knowledge_entry', trigger: s.trigger });
    }
  }

  if (added.length > 0) {
    // Write the updated config back to disk — the file watcher will pick it up
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Mark these records as applied
    const allRecords = readDistillations(projectId);
    for (const record of allRecords) {
      if (suggestionIds.includes(record.id) || approved.some(s => s.ids?.includes(record.id))) {
        record.status = 'applied';
      }
    }
    const fp = filePath(projectId);
    fs.writeFileSync(fp, allRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  return added;
}
