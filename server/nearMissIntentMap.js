import { GUESS_TO_INTENT } from './guessToIntent.js';

/**
 * Resolve a near-miss entry to an intent: first by matching its description against the
 * GUESS_TO_INTENT map, then by inspection of the resolved command string itself.
 * Split out of learningEngine.js (Phase 4 modularization) as pure data-mapping logic.
 */
export function mapNearMissToIntent(command, description) {
  // Determine which intent this maps to
  let intent = null;
  if (description) {
    for (const [pattern, intentName] of Object.entries(GUESS_TO_INTENT)) {
      if (new RegExp(pattern, 'i').test(description)) {
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

  return intent;
}