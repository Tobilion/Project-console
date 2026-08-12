// Phase 6 (UPGRADE-ROADMAP.md, 2026-08-12): lightweight calculation endpoint for the
// Calculator widget. "=" in the panel must show the result IN the panel (Phase 6 spec), so
// the widget evaluates through this endpoint — which imports and calls the SAME mathEval.js
// functions the chat command uses (evaluateArithmetic/convertUnits/percentageQuery), keeping
// a single audited evaluation path. No eval/Function, ever; same dispatch order as
// builtinChitChat's calculate handler.
import { evaluateArithmetic, formatValue, convertUnits, percentageQuery } from '../mathEval.js';

export function registerCalculateRoutes(app) {
  app.post('/api/calculate', (req, res) => {
    const input = String(req.body?.expression || '').trim();
    if (!input) return res.status(400).json({ error: 'Missing expression.' });

    // Same leading-phrase strip + dispatch order as the chat handler (builtinChitChat.js):
    // convert -> percent -> arithmetic.
    const stripped = input.replace(/^(?:what\s+is|whats|what's|calculate|compute|calc|work\s+out|solve|what\s+does)\b/i, '').trim();
    const converted = convertUnits(stripped);
    if (converted) {
      return converted.ok
        ? res.json({ ok: true, value: converted.value, formatted: formatValue(converted.value), label: converted.expression })
        : res.json({ ok: false, error: converted.reason });
    }
    const percent = percentageQuery(stripped);
    if (percent) {
      const suffix = percent.kind === 'tip' ? ' (tip)' : percent.kind === 'tax' ? ' (incl. tax)' : '';
      return res.json({ ok: true, value: percent.value, formatted: formatValue(percent.value) + suffix, label: percent.expression });
    }
    const result = evaluateArithmetic(input);
    if (result.ok) {
      return res.json({ ok: true, value: result.value, formatted: formatValue(result.value), label: result.expression });
    }
    const hint = result.reason === 'divide-by-zero' ? 'Cannot divide by zero' : 'Only + - * / ( ) and numbers are supported';
    return res.json({ ok: false, error: hint });
  });
}
