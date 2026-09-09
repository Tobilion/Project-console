import { evaluateArithmetic, formatValue, convertUnits, percentageQuery } from '../../mathEval.js';

/**
 * system.chit_chat.calculate handler (extracted verbatim from builtinChitChat.js) — safe
 * mathEval.js arithmetic/conversion/percentage answers, never eval()/new Function().
 */
export const mathHandlers = {
  'system.chit_chat.calculate': async (ws, action, input, project, sessionContext) => {
    // Safe shunting-yard parser in mathEval.js — never eval()/new Function() on chat text, and
    // unsupported input gets an honest "can't do that" instead of a best-guess. Phase 6:
    // unit conversion + percentage/tax/tip phrases are tried before plain arithmetic. The
    // leading "what is/whats/calculate" phrase is stripped first so the dedicated parsers
    // see the bare shape ("whats 18% tip on 64.50" -> "18% tip on 64.50").
    const stripped = input.replace(/^(?:what\s+is|whats|what's|calculate|compute|calc|work\s+out|solve|what\s+does)\b/i, '').trim();
    const converted = convertUnits(stripped);
    if (converted) {
      ws.send(JSON.stringify({ type: 'answer', data: converted.ok
        ? `**${converted.expression}** = **${formatValue(converted.value)}**${converted.category ? ` (${converted.category})` : ''}`
        : converted.reason }));
      return;
    }
    const percent = percentageQuery(stripped);
    if (percent) {
      const suffix = percent.kind === 'tip' ? ' (tip)' : percent.kind === 'tax' ? ' (incl. tax)' : '';
      ws.send(JSON.stringify({ type: 'answer', data: `**${percent.expression}** = **${formatValue(percent.value)}**${suffix}` }));
      return;
    }
    const result = evaluateArithmetic(input);
    if (result.ok) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `**${result.expression}** = **${formatValue(result.value)}**`,
      }));
    } else {
      const hint = result.reason === 'divide-by-zero'
        ? 'Can\'t divide by zero.'
        : 'I can only handle basic arithmetic — numbers with + - * / and parentheses, like "what is 12 times 7", or conversions like "convert 5 km to miles" and percentages like "15% of 80".';
      ws.send(JSON.stringify({ type: 'answer', data: hint }));
    }
  },
};