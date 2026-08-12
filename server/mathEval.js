/**
 * Safe arithmetic for the system.chit_chat.calculate intent (Phase 0, 2026-08-10; Phase 6,
 * 2026-08-12 extends the grammar with unit conversion + percentage/tax/tip phrases).
 *
 * Deliberately NOT eval()/new Function(): the "expression" is user chat text, and a permissive
 * parser would turn chat traffic into an injection surface for no user value. This accepts only
 * decimal numbers and + - * / ( ) with a few word-operator synonyms ("times", "divided by",
 * "plus", "minus", "x"), and rejects anything else outright. Unit conversion and percentage
 * phrases are parsed by dedicated narrow regexes BEFORE the arithmetic pass, and their math
 * still goes through the same tokenize/evaluate path below.
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

// --- Phase 6: unit conversion + percentage/tax/tip (static tables, offline-first) ----------

// Static conversion tables (length/weight/volume/temperature) — deliberately no live API, this
// project is offline-first. Base units: meters, kilograms, liters, celsius. `aliases` folds
// plural/word forms ("miles", "feet", "liters", "kilograms") into the canonical symbol.
const UNITS = {
  length: {
    base: 'm',
    factors: { km: 1000, m: 1, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 },
    aliases: { kilometers: 'km', kilometer: 'km', metres: 'm', meter: 'm', meters: 'm', centimetres: 'cm', centimeter: 'cm', centimetre: 'cm', centimeters: 'cm', millimeters: 'mm', millimeter: 'mm', millimetres: 'mm', miles: 'mi', mile: 'mi', feet: 'ft', foot: 'ft', inches: 'in', inch: 'in', yards: 'yd', yard: 'yd' },
  },
  weight: {
    base: 'kg',
    factors: { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523125 },
    aliases: { kilograms: 'kg', kilogram: 'kg', kilo: 'kg', kilos: 'kg', gram: 'g', grams: 'g', grammes: 'g', milligrams: 'mg', milligram: 'mg', pounds: 'lb', pound: 'lb', lbs: 'lb', ounces: 'oz', ounce: 'oz' },
  },
  volume: {
    base: 'l',
    factors: { l: 1, ml: 0.001, cup: 0.2365882365, tbsp: 0.0147867648, tsp: 0.00492892159, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, floz: 0.0295735296 },
    aliases: { liters: 'l', liter: 'l', litres: 'l', litre: 'l', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', cups: 'cup', tablespoons: 'tbsp', tablespoon: 'tbsp', teaspoons: 'tsp', teaspoon: 'tsp', gallons: 'gal', gallon: 'gal', quarts: 'qt', quart: 'qt', pints: 'pt', pint: 'pt', 'fluid ounces': 'floz', 'fluid ounce': 'floz' },
  },
  temperature: { base: 'c', factors: { c: 1, f: 1, k: 1 }, aliases: { celsius: 'c', fahrenheit: 'f', kelvin: 'k' } },
};

function normalizeUnit(category, raw) {
  const unit = (raw || '').toLowerCase().trim();
  if (UNITS[category].factors[unit] !== undefined) return unit;
  return UNITS[category].aliases[unit] || null;
}

/** "convert 5 km to miles" / "how many cups in 2 liters" — returns the converted value. */
export function convertUnits(input) {
  const m = input.match(/^(?:convert\s+)?([\d.]+)\s+([a-z]+)\s+(?:to|in|into|in\s+terms\s+of)\s+([a-z]+)\s*$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const fromRaw = m[2], toRaw = m[3];
  for (const category of Object.keys(UNITS)) {
    const from = normalizeUnit(category, fromRaw);
    const to = normalizeUnit(category, toRaw);
    if (!from || !to) continue;
    if (category === 'temperature') {
      // Direct formula conversions, no linear factor possible.
      let celsius;
      if (from === 'c') celsius = value;
      else if (from === 'f') celsius = (value - 32) * 5 / 9;
      else celsius = value - 273.15;
      let out;
      if (to === 'c') out = celsius;
      else if (to === 'f') out = celsius * 9 / 5 + 32;
      else out = celsius + 273.15;
      return { ok: true, value: out, expression: `${value} ${fromRaw} → ${toRaw}`, category };
    }
    return { ok: true, value: (value * UNITS[category].factors[from]) / UNITS[category].factors[to], expression: `${value} ${fromRaw} → ${toRaw}`, category };
  }
  return { ok: false, reason: `I don't recognize those units (supported: length, weight, volume, temperature).` };
}

const PERCENT_OF_RE = /^([\d.]+)%\s+of\s+([\d.]+)$/i;
const TIP_RE = /^([\d.]+)%\s+(?:tip|gratuity)\s+(?:on|of)\s+([\d.]+)$/i;
const TAX_RE = /^(?:add\s+)?([\d.]+)%\s+(?:tax|vat)\s+(?:to|on|of)\s+([\d.]+)$/i;

/** "15% of 80", "18% tip on 64.50", "add 8.25% tax to 120" — all through the safe evaluator. */
export function percentageQuery(input) {
  let m = input.match(PERCENT_OF_RE);
  if (m) {
    const pct = parseFloat(m[1]), base = parseFloat(m[2]);
    return { ok: true, kind: 'percent-of', value: base * pct / 100, expression: `${pct}% of ${base}` };
  }
  m = input.match(TIP_RE);
  if (m) {
    const pct = parseFloat(m[1]), base = parseFloat(m[2]);
    return { ok: true, kind: 'tip', value: base * pct / 100, expression: `${pct}% tip on ${base}` };
  }
  m = input.match(TAX_RE);
  if (m) {
    const pct = parseFloat(m[1]), base = parseFloat(m[2]);
    return { ok: true, kind: 'tax', value: base * (1 + pct / 100), expression: `${base} + ${pct}% tax` };
  }
  return null;
}