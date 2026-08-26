// Lets a hand-authored console.config.json "command" entry declare {placeholders} that get
// filled in WITHOUT any AI/LLM involvement — either straight out of the user's own phrasing
// (e.g. "watch every 15 minutes" already contains the interval) or, if it's missing, by asking
// one plain follow-up question at a time and waiting for the next chat message as the answer.
// This is what lets trigger mode (AI off) handle project commands that take a parameter — like
// NetPulse's `python main.py watch --interval N` — the same way a person would type it, instead
// of requiring AI mode just to ask "what interval?".
//
// Security note: a value substituted into an otherwise-trusted, hand-authored command template
// is still user-controlled text. isSafeParamValue() rejects shell metacharacters regardless of
// how loose the entry author's own `pattern` is — defense in depth against command injection via
// a parameter answer, on top of the existing isCommandBlocked() dangerous-pattern check that
// still runs on the fully-substituted command before it's executed.

// 2026-08-24: also reject `"` and `'` — a quoted value could break out of a template's quoted
// argument and smuggle shell syntax past the blocklist. Backslash stays allowed (Windows paths).
const UNSAFE_VALUE_RE = /[;&|`$<>\r\n"']/;
const MAX_VALUE_LENGTH = 300;

/**
 * Tries to pull a parameter value out of free text using the entry author's regex.
 * - anchored: false (default) — used against the ORIGINAL trigger phrase, where the value (if
 *   present at all) is just one part of a longer sentence, e.g. "watch every 15 minutes".
 * - anchored: true — used against a direct follow-up ANSWER to a specific question, where the
 *   whole reply should start with the value (allowing for incidental whitespace/units). The
 *   pattern is wrapped in a capture group so the returned value is just the pattern match, not
 *   the entire reply: "15" and "15 minutes" against `\d+` both return "15", never "15 minutes"
 *   (returning the whole reply would substitute "15 minutes" into `--interval 15 minutes`).
 */
export function extractParamValue(text: unknown, pattern: string | null | undefined, { anchored = false }: { anchored?: boolean } = {}): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (!pattern) return anchored ? text.trim() : null;
  try {
    const re = new RegExp(anchored ? `^\\s*(${pattern})\\s*.*$` : pattern, 'i');
    const m = re.exec(text);
    if (!m) return null;
    return (m[1] !== undefined ? m[1] : m[0]).trim();
  } catch {
    return null;
  }
}

export function isSafeParamValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH && !UNSAFE_VALUE_RE.test(value);
}

export function substituteParams(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (full, name: string) => (values[name] !== undefined ? values[name]! : full));
}

/**
 * True if `command` is already covered by an existing console.config.json entry's action —
 * either an exact match, or (for a templated entry like "python main.py watch --interval {n}")
 * a shape match where any {placeholder} could have produced the actual substituted value. Used
 * to nudge AI mode into offering to save a NEW command it just ran successfully, without
 * repeatedly suggesting one that's already there.
 */
export function commandMatchesTemplate(command: unknown, template: unknown): boolean {
  if (typeof command !== 'string' || typeof template !== 'string') return false;
  const a = command.trim();
  const b = template.trim();
  if (a === b) return true;
  if (!b.includes('{')) return false;
  try {
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\w+)\\\}/g, '.+');
    return new RegExp(`^${escaped}$`).test(a);
  } catch {
    return false;
  }
}