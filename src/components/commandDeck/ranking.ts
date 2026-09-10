// Command Deck ranking (2026-09-10, split out of CommandDeck.tsx): recency/frequency
// usage tracking plus tokenized relevance scoring. Pure logic — no JSX, no React
// (the scorer only reads label/hint/keywords/group, so DeckItem stays in the root
// and satisfies the Scorable shape structurally).

export interface Scorable {
  label: string;
  hint?: string;
  keywords?: string[];
  group: string;
}

// Phase 11 (UPGRADE-ROADMAP.md, 2026-08-12): recency/frequency ranking for the palette —
// Raycast/Spotlight behavior (Recent / Frequent groups above the flat list). Usage is tracked
// in a minimal per-browser localStorage map (item key -> { lastUsedAt, count }), the same
// inline-localStorage style as pinned projects / workspace tabs — this is UI-level ranking
// data for a UI surface, deliberately NOT a second server telemetry store (the server's
// intentTelemetry stays the confidence-model's data source; see the roadmap's step 1-2 note).
export const DECK_USAGE_KEY = 'console.deckUsage';

export interface UsageEntry { lastUsedAt: number; count: number; }

export function readUsage(): Record<string, UsageEntry> {
  try {
    const raw = localStorage.getItem(DECK_USAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

export function writeUsage(usage: Record<string, UsageEntry>) {
  try {
    localStorage.setItem(DECK_USAGE_KEY, JSON.stringify(usage));
  } catch {}
}

// Classic Levenshtein for the palette's typo tolerance — small (labels are short) and only
// ever compared against whole words, so the O(n*m) cost is trivial at this scale.
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Tokenized relevance scoring (2026-08-13): every whitespace-separated query token must be
// found somewhere in the item (label/hint/keywords/group); the score rewards label hits over
// hint over keywords, so "git push" ranks the actual push commands above unrelated hits.
// 2026-08-24: typo tolerance — a token that matches NO field by substring still matches if it
// is within edit distance 1 (short tokens) / 2 (long tokens) of a field WORD, at a reduced
// score, so "explrer" finds "folder explorer" instead of returning zero results. Plus
// multi-word concatenation ("gitstatus" == "git status", Raycast-style) for tokens >= 6 chars.
export function matchScore(it: Scorable, q: string): number {
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const label = it.label.toLowerCase();
  const hint = (it.hint ?? '').toLowerCase();
  const keys = (it.keywords ?? []).join(' ').toLowerCase();
  const group = it.group.toLowerCase();
  const fuzzyFields: Array<[string, number]> = [
    [label, 6], [hint, 4], [keys, 3], [group, 2],
  ];
  // Space-stripped concatenations for the "gitstatus" -> "git status" class.
  const concatFields: Array<[string, number]> = [
    [label.replace(/\s+/g, ''), 7], [hint.replace(/\s+/g, ''), 4], [keys.replace(/\s+/g, ''), 3],
  ];
  let score = 0;
  for (const token of tokens) {
    let found = false;
    if (label.includes(token)) { score += 30; found = true; }
    if (hint.includes(token)) { score += 20; found = true; }
    if (keys.includes(token)) { score += 15; found = true; }
    if (group.includes(token)) { score += 10; found = true; }
    if (!found && token.length >= 3) {
      const maxDist = token.length >= 5 ? 2 : 1;
      for (const [field, fuzzyScore] of fuzzyFields) {
        if (field.split(/\s+/).some((word) => editDistance(word, token) <= maxDist)) {
          score += fuzzyScore;
          found = true;
          break;
        }
      }
    }
    if (!found && token.length >= 6) {
      for (const [field, concatScore] of concatFields) {
        if (field.includes(token) || editDistance(field, token) <= 1) {
          score += concatScore;
          found = true;
          break;
        }
      }
    }
    if (!found) return -1;
  }
  return score;
}

// Cap on the un-query "All" section — browsing 200+ items is noise; the footer says to type.
export const BROWSE_CAP = 80;
export const RESULT_CAP = 100;
