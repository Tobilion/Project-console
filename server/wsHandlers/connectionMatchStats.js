import { aggregateMatchStats } from '../matchStats.js';

// `review match quality` (2026-08-26) — reads the rolling match-stats log (data/match-stats
// .jsonl, one line per trigger-mode message) and reports per-intent mean/min confidence,
// the drift between the recent window and the older window, and the stage distribution.
// Flags intents whose recent mean dropped > 0.1 vs the older window with >= 5 recent
// samples — that is the drift signature of a corpus growing over an intent's phrases.
// Pre-matcher admin tier (wired in connectionExecute.js): answer + trailing `end`, read-only.

function matchStatsPhrases(input) {
  const i = input.toLowerCase();
  return (
    i === 'review match quality' || i === 'match quality' || i === 'match stats' ||
    i === 'review matching quality' || i === 'show match quality' ||
    // 2026-08-26 live crosscheck: "review the match stats" fell through the admin tier and
    // the command guesser CONFIRMED `type "match stats"` (the Windows TYPE binary) — a
    // nonsense command for a stats-review request. The natural variants now reach the tier.
    i === 'review the match stats' || i === 'review match stats' ||
    i === 'check match quality' || i === 'check match stats' || i === 'check matching quality'
  );
}

export async function handleMatchStatsCommand(ws, lowerInput) {
  if (!matchStatsPhrases(lowerInput)) return false;

  const { records, intents, stages } = aggregateMatchStats();

  let reply = '**Match quality**\n\n';
  if (records === 0) {
    reply += 'No match records yet — the log fills as trigger-mode messages are matched (one line per message).';
  } else {
    reply += `Analyzed ${records} matched messages (recent window = last 100, drift vs the 100 before that).\n\n`;
    const stageSummary = Object.entries(stages)
      .sort((a, b) => b[1] - a[1])
      .map(([stage, count]) => `${stage} ${count}`)
      .join(', ');
    reply += `- Stage distribution: ${stageSummary}\n\n`;
    if (intents.length === 0) {
      reply += 'No intent-bearing matches in the window.';
    } else {
      reply += 'Per intent (recent mean / min / drift vs prior window):\n';
      for (const s of intents.slice(0, 12)) {
        const flag = s.flagged ? ' — **drift**' : '';
        reply += `- \`${s.intent}\`: mean ${s.mean ?? '—'}, min ${s.min ?? '—'}, drift ${s.drift ?? '—'} (n=${s.count})${flag}\n`;
      }
      if (intents.length > 12) reply += `- …and ${intents.length - 12} more intents\n`;
      const flagged = intents.filter((s) => s.flagged);
      if (flagged.length > 0) {
        reply += `\n**${flagged.length} intent(s) flagged**: mean confidence dropped >0.1 vs the prior window — check the phrase corpus (check-intents) before adding more examples to these.`;
      } else {
        reply += '\nNo drift flags — match quality is stable.';
      }
    }
  }

  ws.send(JSON.stringify({ type: 'answer', data: reply }));
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}