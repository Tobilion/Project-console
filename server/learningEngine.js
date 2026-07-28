import { readNearMisses, clearNearMisses, listNearMissProjectIds } from './nearMissLogger.js';
import { semanticMatcher } from './semanticMatcher.js';
import { INTENTS } from './intentsData.js';
import { persistLearnedPhrases } from './learnedIntents.js';

// Minimum occurrences before a pattern is suggested for promotion to an intent
const MIN_OCCURRENCES = 3;

// Maps guessCommand pattern descriptions to intent names
const GUESS_TO_INTENT = {
  'Remove .* from git tracking': 'git_rm_cached',
  'Add .* to .gitignore': 'git_ignore_add',
  'Create file': 'file_create',
  'Delete file': 'file_delete',
  'Install npm package': 'npm_install',
  'Uninstall npm package': 'npm_install',
  'Run npm script': 'npm_run',
  'Start the project': 'npm_run',
  'Stage .* for commit': 'git_add',
};

/**
 * Reviews near-miss log entries for a project and generates suggestions for
 * promoting frequently-seen patterns into intent examples.
 *
 * Returns an array of suggestion objects:
 *   { id, intent, phrases: [], count, confidence }
 */
export function generateSuggestions(projectId) {
  const entries = readNearMisses(projectId);
  if (entries.length === 0) return [];

  // Group by the resolved command (which reflects the guessCommand pattern that fired)
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.resolvedCommand) continue;
    const key = entry.resolvedCommand;
    if (!groups.has(key)) {
      groups.set(key, {
        command: entry.resolvedCommand,
        description: entry.description,
        inputs: [],
        accepted: 0,
        rejected: 0,
      });
    }
    const group = groups.get(key);
    group.inputs.push(entry.input);
    if (entry.accepted === true) group.accepted++;
    if (entry.accepted === false) group.rejected++;
  }

  const suggestions = [];
  for (const [command, group] of groups) {
    if (group.inputs.length < MIN_OCCURRENCES) continue;

    // Determine which intent this maps to
    let intent = null;
    if (group.description) {
      for (const [pattern, intentName] of Object.entries(GUESS_TO_INTENT)) {
        if (new RegExp(pattern, 'i').test(group.description)) {
          intent = intentName;
          break;
        }
      }
    }

    // If no mapping, try to infer from the command itself
    if (!intent) {
      if (command.startsWith('git rm --cached')) intent = 'git_rm_cached';
      else if (command.includes('>> .gitignore') || command.includes('echo')) intent = 'git_ignore_add';
      else if (command.startsWith('npm install')) intent = 'npm_install';
      else if (command.startsWith('npm uninstall')) intent = 'npm_install';
      else if (command.startsWith('npm run')) intent = 'npm_run';
      else if (command.startsWith('git add')) intent = 'git_add';
      else if (command.includes('del /f') || command.includes('rm ')) intent = 'file_delete';
      else if (command.includes('>') && !command.includes('git')) intent = 'file_create';
    }

    if (!intent) continue;

    // Deduplicate input phrases
    const phrases = [...new Set(group.inputs)];

    // Confidence based on acceptance rate and frequency
    const acceptanceRate = group.accepted / (group.accepted + group.rejected || 1);
    let confidence = 'low';
    if (group.inputs.length >= 5 && acceptanceRate >= 0.8) confidence = 'high';
    else if (group.inputs.length >= 3 && acceptanceRate >= 0.6) confidence = 'medium';

    suggestions.push({
      id: crypto.randomUUID(),
      intent,
      phrases,
      count: group.inputs.length,
      accepted: group.accepted,
      rejected: group.rejected,
      confidence,
    });
  }

  // Sort by count descending
  suggestions.sort((a, b) => b.count - a.count);
  return suggestions;
}

/**
 * Apply approved suggestions — inject phrases into the in-memory INTENTS object
 * and rebuild the Fuse.js index so fuzzy matching picks them up immediately.
 *
 * Returns the list of phrases actually added.
 */
export function applySuggestions(suggestionIds, projectId) {
  const entries = readNearMisses(projectId);
  const allSuggestions = generateSuggestions(projectId);
  const approved = allSuggestions.filter(s => suggestionIds.includes(s.id));

  const added = [];
  for (const suggestion of approved) {
    const intent = INTENTS[suggestion.intent];
    if (!intent) continue;

    const existing = new Set(intent.examples);
    for (const phrase of suggestion.phrases) {
      if (!existing.has(phrase)) {
        intent.examples.push(phrase);
        existing.add(phrase);
        added.push({ intent: suggestion.intent, phrase });
      }
    }
  }

  // Rebuild the Fuse.js index so new phrases are immediately matchable
  if (added.length > 0) {
    semanticMatcher._rebuildFuseIndex();
    // Persist to disk so this survives a server restart (INTENTS is shared across every
    // project in memory, but was never written back — this is what makes learning "stick").
    persistLearnedPhrases(added);
  }

  // Clear the near-miss log for this project since we've acted on it
  if (added.length > 0) {
    clearNearMisses(projectId);
  }

  return added;
}

/**
 * Auto-apply only the near-miss suggestions the engine is already highly confident about
 * (5+ occurrences, ≥80% acceptance rate — see the `confidence` calc in generateSuggestions)
 * without waiting for the user to run `review learning` + `approve suggestions` by hand.
 * Mirrors intentTelemetry.js's autoApplyThresholds, which already runs unattended on startup.
 */
export function autoApplySuggestions(projectId) {
  const suggestions = generateSuggestions(projectId);
  const highConfidence = suggestions.filter(s => s.confidence === 'high');
  if (highConfidence.length === 0) return { applied: 0, total: suggestions.length };
  const added = applySuggestions(highConfidence.map(s => s.id), projectId);
  return { applied: added.length, total: suggestions.length };
}

/** Sweep every project with a near-miss log and auto-apply high-confidence suggestions. */
export function autoApplySuggestionsForAll() {
  const results = [];
  for (const projectId of listNearMissProjectIds()) {
    const result = autoApplySuggestions(projectId);
    if (result.applied > 0) {
      results.push({ projectId, ...result });
    }
  }
  return results;
}
