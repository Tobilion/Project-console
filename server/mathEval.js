/**
 * Safe arithmetic for the system.chit_chat.calculate intent (Phase 0, 2026-08-10).
 *
 * Deliberately NOT eval()/new Function(): the "expression" is user chat text, and a permissive
 * parser would turn chat traffic into an injection surface for no user value. This accepts only
 * decimal numbers and + - * / ( ) with a few word-operator synonyms ("times", "divided by",
 * "plus", "minus", "x"), and rejects anything else outright.
 */

const LEADING_PHRASE_RE = /^(?:what\s+is|whats|what's|calculate|compute|calc|work\s+out|solve|what\s+does)\b/i;

// Applied to the whole stripped string to fold word operators into symbols; a leftover English
// word then fails tokenization and the input is rejected rather than guessed at.
const WORD_OPS = [
  [/multiplied by|multiplied|multiply|times|\bx\b/gi, '*'],
  [/divided by|divided|\bover\b/gi, '/'],
  [/\bplus\b|\badd\b|\band\b|\bwith\b/gi, '+'],
  [/\bminus\b|subtract|take away/gi, '-'],
];

// Sticky: exec() anchors at lastIndex, without it a non-global regex always returns the first
// match in the string and every number after the first one gets rejected as unsupported.
const NUMBER_RE = /\d+(?:\.\d+)?/y;
const OP_CHARS = new Set(['+', '-', '*', '/', '(', ')']);

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 };

function tokenize(stripped) {
  const tokens = [];
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (OP_CHARS.has(ch)) { tokens.push(ch); i++; continue; }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(stripped);
    if (m) {
      tokens.push(parseFloat(m[0]));
      i += m[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

/** Shunting-yard evaluation restricted to the token set above; null on any syntax error, 'zero'
 *  returned as a distinct marker for an attempted divide-by-zero (surfaced to the user as its
 *  own reason, not folded into the generic syntax rejection). */
function evaluate(tokens) {
  const values = [];
  const ops = [];
  let expectOperand = true;
  for (const tok of tokens) {
    if (typeof tok === 'number') {
      if (!expectOperand) return null;
      values.push(tok);
      expectOperand = false;
    } else if (tok === '(') {
      ops.push(tok);
    } else if (tok === ')') {
      let closed = false;
      while (ops.length) {
        const op = ops.pop();
        if (op === '(') { closed = true; break; }
        const applied = applyOp(values, op);
        if (applied === 'zero') return 'zero';
        if (!applied) return null;
      }
      if (!closed || expectOperand) return null;
      expectOperand = false;
    } else {
      if (expectOperand) return null;
      while (ops.length && ops[ops.length - 1] !== '(' && PRECEDENCE[ops[ops.length - 1]] >= PRECEDENCE[tok]) {
        const applied = applyOp(values, ops.pop());
        if (applied === 'zero') return 'zero';
        if (!applied) return null;
      }
      ops.push(tok);
      expectOperand = true;
    }
  }
  while (ops.length) {
    if (ops[ops.length - 1] === '(') return null;
    const applied = applyOp(values, ops.pop());
    if (applied === 'zero') return 'zero';
    if (!applied) return null;
  }
  if (values.length !== 1) return null;
  return values[0];
}

/** Returns true when an operator was applied, false on a stack-underflow (syntax error), and
 *  the string 'zero' for a divide-by-zero so the caller can distinguish the two. */
function applyOp(values, op) {
  if (values.length < 2) return false;
  const b = values.pop();
  const a = values.pop();
  switch (op) {
    case '+': values.push(a + b); break;
    case '-': values.push(a - b); break;
    case '*': values.push(a * b); break;
    case '/': {
      if (b === 0) return 'zero';
      values.push(a / b);
      break;
    }
  }
  return true;
}

/** Express a numeric result without float noise ("84.0000000001" never reaches the user). */
export function formatValue(value) {
  const rounded = Math.round(value * 1e10) / 1e10;
  return String(Number.isInteger(rounded) ? rounded : rounded.toPrecision(12).replace(/\.?0+$/, ''));
}

/**
 * Evaluate a natural-language arithmetic request.
 * @returns {{ ok: true, value: number, expression: string } | { ok: false, reason: string }}
 */
export function evaluateArithmetic(input) {
  let s = input.trim().replace(LEADING_PHRASE_RE, '').replace(/^the\s+/i, '').replace(/[?!.\s]+$/, '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  for (const [re, replacement] of WORD_OPS) {
    s = s.replace(re, replacement);
  }
  const tokens = tokenize(s);
  if (!tokens || tokens.length === 0) return { ok: false, reason: 'unsupported' };
  const result = evaluate(tokens);
  if (result === 'zero') return { ok: false, reason: 'divide-by-zero' };
  if (result === null) return { ok: false, reason: 'syntax' };
  return { ok: true, value: result, expression: tokens.map(String).join(' ') };
}