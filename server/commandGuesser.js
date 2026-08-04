/**
 * Best-guess shell command fallback - when no intent matches but the input looks like a
 * development task, infer the likely command and offer it with confirmation.
 *
 * Only fires after the full matching pipeline (embedding -> Fuse.js -> keyword -> NLP.js)
 * returned nothing. These are pure regex heuristics, not AI - precision over recall.
 *
 * The pattern/build table itself lives in guessData.js (Phase 2 split, pure data); this
 * module only owns the matching loop over it.
 */
import { GUESSES } from './guessData.js';

export function guessCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  for (const guess of GUESSES) {
    const match = trimmed.match(guess.pattern);
    if (match) {
      try {
        return guess.build(match);
      } catch {
        continue;
      }
    }
  }

  return null;
}
