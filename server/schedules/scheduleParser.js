// Interval-phrase parser for Phase 1 scheduled triggers. Turns human phrasing like
// "every 5 minutes", "daily at 09:30", "on file save", "on git commit" into a schedule
// spec. Deliberately small — the spec asks for a handful of interval shapes, not a full
// cron-expression grammar; anything unparseable is rejected with a human-readable reason
// so `schedule` can explain itself instead of failing silently.

export const MIN_EVERY_MS = 60 * 1000; // 1 minute — below this, fires would spam the chat

/**
 * Parse a schedule's interval phrase.
 * Returns { ok: true, type, everyMs? | hour?/minute? } or { ok: false, reason }.
 */
export function parseIntervalPhrase(text) {
  const trimmed = (text || '').trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: 'missing interval' };

  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)?$/);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2] || 'minutes';
    const isHours = /^hour/.test(unit) || unit === 'hr' || unit === 'hrs';
    const max = isHours ? 24 : 24 * 60;
    if (n < 1 || n > max) return { ok: false, reason: `"every ${n} ${unit}" is out of range — I accept 1-${max} ${isHours ? 'hours' : 'minutes'}.` };
    return { ok: true, type: 'interval', everyMs: n * (isHours ? 60 : 1) * 60 * 1000, label: `every ${n} ${unit}` };
  }

  const dailyMatch = trimmed.match(/^daily\s+at\s+(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const minute = parseInt(dailyMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return { ok: false, reason: `"${trimmed}" is not a valid 24-hour time — try "daily at 09:30".` };
    }
    return { ok: true, type: 'daily', hour, minute, label: `daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
  }

  if (trimmed === 'on file save') return { ok: true, type: 'file-save', label: 'on file save' };
  if (trimmed === 'on git commit') return { ok: true, type: 'git-commit', label: 'on git commit' };

  return { ok: false, reason: 'I don\'t understand that interval. Try "every 5 minutes", "every 2 hours", "daily at 09:30", "on file save", or "on git commit".' };
}