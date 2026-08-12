// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): free-form natural-language date parsing for
// personal reminders ("remind me tomorrow at 9am to X", "remind me in 3 days to Y",
// "remind me every friday at 5pm to Z"). chrono-node does the heavy lifting for one-shot
// dates/times (deliberately: a hand-rolled NL date parser at this scope is not worth
// maintaining, and chrono-node is small and well-scoped vs a scheduling framework); the
// recurrence keywords (weekday/daily/interval) are recognized here first because the
// scheduler's isDue() needs a concrete recurrence TYPE, not a resolved instant.
//
// Returns { ok: true, type, label, text, fireAt? | hour?/minute?/weekday? | everyMs?,
// firstFireAt? } or { ok: false, reason } — the same {ok} contract as
// scheduleParser.js's parseIntervalPhrase, so callers stay uniform.

import * as chrono from 'chrono-node';

const PREFIX_RE = /^(?:remind me to|remind me about|remind me|set a reminder to|set a reminder for|set a reminder)\b/i;

const WEEKDAY_IDS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// "at 5pm", "at 5:30 pm", "at 17:00" — 24h times require minutes, 12h times require am/pm
// so bare "at 9" is rejected instead of guessed.
const TIME_RE = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

function parseTime(when) {
  const m = when.match(TIME_RE);
  if (!m) return null;
  const hourStr = m[1];
  const minutes = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const meridian = (m[3] || '').toLowerCase();
  let hour = parseInt(hourStr, 10);
  if (meridian) {
    if (hour < 1 || hour > 12) return null;
    if (meridian === 'pm' && hour !== 12) hour += 12;
    if (meridian === 'am' && hour === 12) hour = 0;
  } else {
    if (hour > 23 || minutes > 59) return null;
  }
  if (minutes > 59) return null;
  return { hour, minute: minutes };
}

function formatTime(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Parse a full reminder input ("remind me ...") into a schedule spec + reminder text. */
export function parseReminderInput(input) {
  const trimmed = (input || '').trim();
  const body = trimmed.replace(PREFIX_RE, '').trim();
  if (!body) return { ok: false, reason: 'Try `remind me tomorrow at 9am to renew my license`.' };

  let when = null;
  let text = null;

  // when-before-text form: "tomorrow at 9am to renew my license". Split only when the
  // first part contains a parseable when; a text-first phrase like "water the plants
  // tomorrow at 9am" has no " to " and falls through to the chrono-span extraction.
  const toSplit = body.match(/^(.*?)\s+to\s+(.+)$/i);
  if (toSplit && toSplit[1] && toSplit[2] && looksLikeWhen(toSplit[1])) {
    when = toSplit[1];
    text = toSplit[2];
  }

  // text-first form: strip the first chrono-recognized span ("water the plants tomorrow
  // at 9am" -> when "tomorrow at 9am", text "water the plants").
  if (!when) {
    const results = chrono.parse(body, new Date(), { forwardDate: true });
    if (results.length > 0) {
      const span = results[0];
      when = span.text;
      const before = body.slice(0, span.index).trim();
      const after = body.slice(span.index + span.text.length).trim();
      // chrono's recurring parsers consume "every"/"each" without including them in the
      // span text, leaving a trailing "every" in the text ("water the plants every").
      text = [before, after].filter(Boolean).join(' ').replace(/^to\s+/i, '').replace(/\s+(?:every|each|daily)$/i, '').trim();
    } else if (toSplit && toSplit[1] && toSplit[2]) {
      // Unparseable when-before-text ("blahblah to do the thing") — keep the split so the
      // chrono pass below can give the "can't read <when>" error instead of a wrong one.
      when = toSplit[1];
      text = toSplit[2];
    } else {
      when = body;
      text = null;
    }
  }

  text = (text || '').trim();
  if (!text) return { ok: false, reason: 'What should I remind you about? Try `remind me tomorrow at 9am to renew my license`.' };
  if (!when) return { ok: false, reason: 'When should I remind you? Try `remind me tomorrow at 9am to renew my license`.' };

  const lowerWhen = when.toLowerCase();

  // Recurrence forms (checked before chrono so the scheduler gets a recurrence TYPE).
  const weekdayMatch = lowerWhen.match(/^(?:every\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const weekday = WEEKDAY_IDS[weekdayMatch[1]];
    const time = parseTime(lowerWhen) || { hour: 9, minute: 0 };
    return {
      ok: true,
      type: 'weekly',
      weekday,
      hour: time.hour,
      minute: time.minute,
      label: `every ${weekdayMatch[1]} at ${formatTime(time.hour, time.minute)}`,
      text,
    };
  }

  if (/^(?:daily|every\s+day|each\s+day)\b/.test(lowerWhen)) {
    const time = parseTime(lowerWhen) || { hour: 9, minute: 0 };
    return {
      ok: true,
      type: 'daily',
      hour: time.hour,
      minute: time.minute,
      label: `daily at ${formatTime(time.hour, time.minute)}`,
      text,
    };
  }

  const intervalMatch = lowerWhen.match(/^every\s+(\d+)\s+(day|days|week|weeks)\b/);
  if (intervalMatch) {
    const n = parseInt(intervalMatch[1], 10);
    const isWeeks = /^week/.test(intervalMatch[2]);
    const everyMs = n * (isWeeks ? 7 : 1) * 24 * 60 * 60 * 1000;
    const time = parseTime(lowerWhen);
    const base = {
      ok: true,
      type: 'interval',
      everyMs,
      label: time ? `every ${n} ${isWeeks ? 'week' : 'day'}${n > 1 ? 's' : ''} at ${formatTime(time.hour, time.minute)}` : `every ${n} ${isWeeks ? 'week' : 'day'}${n > 1 ? 's' : ''}`,
      text,
    };
    // With an explicit time, align the FIRST fire to that time (the scheduler's interval
    // branch counts everyMs from lastFiredAt, so firstFireAt - everyMs pins the first one
    // exactly; daily/weekly multiples keep later fires aligned). Roll a past "at 8am"
    // forward one day at a time — chrono's forwardDate does not roll bare times.
    if (time) {
      const first = chrono.parse('at ' + formatTime(time.hour, time.minute), new Date(), { forwardDate: true });
      if (first.length > 0) {
        let fireAt = first[0].start.date().getTime();
        while (fireAt <= Date.now()) fireAt += 24 * 60 * 60 * 1000;
        base.firstFireAt = fireAt;
      }
    }
    return base;
  }

  // One-shot: chrono with forwardDate so "at 7pm" resolves to the NEXT 7pm, never a past one.
  const parsed = chrono.parse(when, new Date(), { forwardDate: true });
  if (parsed.length === 0) {
    return { ok: false, reason: `I can't read "${when}" as a time. Try "tomorrow at 9am", "in 3 days", "every friday at 5pm", or "daily at 09:30".` };
  }
  let fireAt = parsed[0].start.date().getTime();
  if (fireAt <= Date.now()) {
    if (parsed[0].start.isCertain('day')) {
      return { ok: false, reason: `"${when}" is in the past — try a future time.` };
    }
    // Bare-time phrases ("at 8am") resolve to today even when already past — roll to the
    // next occurrence instead of rejecting.
    while (fireAt <= Date.now()) fireAt += 24 * 60 * 60 * 1000;
  }
  return {
    ok: true,
    type: 'oneshot',
    fireAt,
    label: parsed[0].start.date().toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    text,
  };
}

function looksLikeWhen(part) {
  if (/\b(?:every|daily|on|at|in|next|tomorrow|today)\b/i.test(part)) return true;
  return chrono.parse(part, new Date(), { forwardDate: true }).length > 0;
}
