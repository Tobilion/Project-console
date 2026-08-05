import { generateDistillationSuggestions, applyDistillation, clearDistillations } from '../distillation.js';
import { getMemorySummary } from '../projectMemory.js';
import { generateSuggestions, applySuggestions } from '../learningEngine.js';
import { state } from '../state.js';

// Distillation / memory / learning admin commands (handleExecute blocks G, H, L). Each
// returns true when the input matched its phrasing and was consumed.

export async function handleDistillationCommand(ws, project, lowerInput) {
  // Distillation commands — review and apply AI-derived trigger-mode suggestions
  if (lowerInput === 'review distillations' || lowerInput === 'distillation review' || lowerInput === 'check distillations') {
    const suggestions = generateDistillationSuggestions(project.id);
    if (suggestions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No pending AI distillations. Use AI mode to run commands and generate suggestions.\n' }));
    } else {
      let reply = `**AI Distillations for ${project.name}**\n\n`;
      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        reply += `**${i + 1}.** ${s.type === 'command_entry' ? '⚡' : s.type === 'knowledge_entry' ? '📖' : '📁'} `;
        reply += `[${s.confidence}] ${s.description}\n`;
        if (s.trigger) reply += `   Trigger: \`${s.trigger}\`\n`;
        if (s.action) reply += `   Action: \`${s.action}\`\n`;
        if (s.occurrences > 1) reply += `   Occurrences: ${s.occurrences}\n`;
      }
      reply += '\nApply with: `apply distillation <number>` or `apply all distillations`\n';
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput.startsWith('apply distillation ') || lowerInput.startsWith('apply distillations ')) {
    const parts = lowerInput.replace(/^apply distillations? /, '').trim();
    const suggestions = generateDistillationSuggestions(project.id);
    let ids;
    if (parts === 'all') {
      ids = suggestions.map(s => s.id);
    } else {
      const indices = parts.split(/\s+/).map(p => parseInt(p, 10) - 1).filter(n => !isNaN(n) && n >= 0);
      ids = indices.map(i => suggestions[i]?.id).filter(Boolean);
    }
    if (!ids.length) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No valid distillation suggestions to apply.\n' }));
    } else {
      const added = applyDistillation(project.id, ids, state.activeProjectsCache);
      if (added.length > 0) {
        const types = [...new Set(added.map(a => a.type === 'command_entry' ? 'commands' : 'knowledge entries'))];
        ws.send(JSON.stringify({
          type: 'answer',
          data: `✅ Applied ${added.length} distillation(s) to ${project.name}'s console.config.json as ${types.join(', ')}.\nThe file watcher will reload them automatically.\n`
        }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: 'No new distillations to apply (entries already exist or nothing to add).\n' }));
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'clear distillations' || lowerInput === 'distillation clear') {
    clearDistillations(project.id);
    ws.send(JSON.stringify({ type: 'answer', data: `Cleared distillation records for ${project.name}.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  return false;
}

export async function handleMemoryReview(ws, project, lowerInput) {
  // Memory / adaptive context commands
  if (lowerInput === 'review memory' || lowerInput === 'memory review' || lowerInput === 'project memory') {
    const summary = getMemorySummary(project.path);
    let reply = `**Project Memory for ${project.name}**\n\n`;
    if (summary.topCommands.length > 0) {
      reply += `**Top commands:**\n${summary.topCommands.map((c, i) => `  ${i + 1}. \`${c.command}\` (${c.count}x)`).join('\n')}\n\n`;
    }
    if (summary.topEditedFiles.length > 0) {
      reply += `**Top edited files:**\n${summary.topEditedFiles.map((f, i) => `  ${i + 1}. \`${f.file}\` (${f.count}x)`).join('\n')}\n\n`;
    }
    if (summary.repeatedQuestions.length > 0) {
      reply += `**Repeated questions:**\n${summary.repeatedQuestions.map((q, i) => `  ${i + 1}. "${q.topic}" (${q.count}x${q.suggested ? ', already suggested' : ''})`).join('\n')}\n\n`;
    }
    reply += `Candidate additions pending: ${summary.candidateAdditions}\n`;
    reply += `Last updated: ${new Date(summary.lastUpdated).toLocaleDateString()}\n`;
    ws.send(JSON.stringify({ type: 'answer', data: reply }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  return false;
}

export async function handleLearningCommand(ws, project, lowerInput) {
  // Special learning commands — intercept before the matching pipeline
  if (lowerInput === 'review learning' || lowerInput === 'check learning' || lowerInput === 'learning review') {
    const suggestions = generateSuggestions(project.id);
    ws.send(JSON.stringify({
      type: 'learning_suggestion',
      data: { projectId: project.id, suggestions }
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput.startsWith('approve suggestions')) {
    const parts = lowerInput.split(/\s+/).slice(2);
    let suggestionIds;
    if (parts.length === 0) {
      // Approve all — regenerate suggestions and approve all IDs
      const suggestions = generateSuggestions(project.id);
      suggestionIds = suggestions.map(s => s.id);
    } else {
      // Approve specific ones by index
      const suggestions = generateSuggestions(project.id);
      suggestionIds = parts.map(p => {
        const idx = parseInt(p, 10) - 1;
        return suggestions[idx]?.id;
      }).filter(Boolean);
    }
    if (!suggestionIds.length) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No suggestions to approve.' }));
      ws.send(JSON.stringify({ type: 'end' }));
      return true;
    }
    const added = applySuggestions(suggestionIds, project.id);
    if (added.length > 0) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `✅ Added ${added.length} new phrase(s) to ${[...new Set(added.map(a => a.intent))].join(', ')} intents. They're active now.`
      }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: 'No new phrases to add (all were already known).' }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  return false;
}
