import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Send, XCircle } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import './CalculatorPanel.css';

// Phase 6 (UPGRADE-ROADMAP.md, 2026-08-12): the live Calculator widget — iOS calculator
// layout (large result display, 4-column grid, systemOrange operator column). Button presses
// update local React state instantly; "=" (button or Enter) evaluates through the SAME
// server-side mathEval.js the chat command uses, via the dedicated POST /api/calculate
// endpoint, and the RESULT DISPLAYS IN THE PANEL — the user never has to leave the widget to
// read chat. Keyboard input is wired (digits, + - * / ., Enter =, Backspace, Escape).
// History is in-memory per session with real results.

interface CalculatorPanelProps {
  onSendMessage: (text: string) => void;
}

type Mode = 'basic' | 'convert' | 'tip';

interface HistoryEntry {
  expr: string;
  result: string;
}

const DISPLAY_MAX = 14;

export function CalculatorPanel({ onSendMessage }: CalculatorPanelProps) {
  const [expr, setExpr] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('basic');
  const [convertInput, setConvertInput] = useState('');
  const [convertUnit, setConvertUnit] = useState('5 km to miles');
  const [tipInput, setTipInput] = useState('');
  const [tipPct, setTipPct] = useState('18');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [evaluating, setEvaluating] = useState(false);

  const press = (token: string) => {
    setExpr((prev) => {
      const next = prev === '0' && /^\d$/.test(token) ? token : prev + token;
      return next.slice(-40);
    });
    setLastResult(null);
    setLastError(null);
  };

  const clear = () => { setExpr(''); setLastResult(null); setLastError(null); };

  const backspace = () => {
    setExpr((prev) => prev.slice(0, -1));
    setLastResult(null);
    setLastError(null);
  };

  const evaluate = async (raw: string) => {
    if (!raw.trim()) return;
    setEvaluating(true);
    setLastError(null);
    const data = await apiFetchJson<{ ok: boolean; value?: number; formatted?: string; label?: string; error?: string }>(
      '/api/calculate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expression: raw }) }
    );
    setEvaluating(false);
    if (!data) {
      setLastError('Could not reach the server.');
      return;
    }
    if (data.ok && data.formatted !== undefined) {
      setLastResult(data.formatted);
      setHistory((prev) => [{ expr: data.label || raw, result: data.formatted }, ...prev].slice(0, 8));
    } else {
      setLastError(data.error || 'Cannot evaluate that.');
    }
  };

  const equals = () => {
    if (!expr.trim()) return;
    evaluate(`calculate ${expr}`);
  };

  // Keyboard input: digits, operators, Enter (=), Backspace, Escape. Ignored while the user
  // is typing in the convert/tip text fields (target is an INPUT).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (/^[0-9.]$/.test(k)) { e.preventDefault(); press(k); }
      else if (k === '+') { e.preventDefault(); press('+'); }
      else if (k === '-') { e.preventDefault(); press('-'); }
      else if (k === '*') { e.preventDefault(); press('*'); }
      else if (k === '/') { e.preventDefault(); press('/'); }
      else if (k === 'Enter' || k === '=') { e.preventDefault(); equals(); }
      else if (k === 'Backspace') { e.preventDefault(); backspace(); }
      else if (k === 'Escape') { e.preventDefault(); clear(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const display = lastResult ?? (expr || '0');

  const keyBtn = (label: string, onClick: () => void, kind: 'num' | 'func' | 'op' | 'zero', wide = false) => (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center justify-center rounded-full transition-transform active:scale-95 select-none',
        kind === 'num' && 'text-[24px]',
        kind === 'func' && 'text-[20px]',
        kind === 'op' && 'text-[26px]',
        wide && 'col-span-2 text-left pl-6',
      )}
      style={{
        height: 60,
        backgroundColor: kind === 'op' ? 'var(--calc-orange)' : kind === 'func' ? 'var(--calc-func)' : 'var(--calc-key)',
        color: kind === 'op' ? '#FFFFFF' : 'var(--calc-label)',
        fontSize: kind === 'num' ? 24 : kind === 'op' ? 26 : 20,
      }}
    >
      {label}
    </button>
  );

  const basicGrid = (
    <div className="grid grid-cols-4 gap-2">
      {keyBtn('C', clear, 'func')}
      {keyBtn('+/-', () => setExpr((p) => (p.startsWith('-') ? p.slice(1) : `-${p}`)), 'func')}
      {keyBtn('%', () => setExpr((p) => (p ? `(${p})/100` : p)), 'func')}
      {keyBtn('÷', () => press('/'), 'op')}
      {keyBtn('7', () => press('7'), 'num')}
      {keyBtn('8', () => press('8'), 'num')}
      {keyBtn('9', () => press('9'), 'num')}
      {keyBtn('×', () => press('*'), 'op')}
      {keyBtn('4', () => press('4'), 'num')}
      {keyBtn('5', () => press('5'), 'num')}
      {keyBtn('6', () => press('6'), 'num')}
      {keyBtn('−', () => press('-'), 'op')}
      {keyBtn('1', () => press('1'), 'num')}
      {keyBtn('2', () => press('2'), 'num')}
      {keyBtn('3', () => press('3'), 'num')}
      {keyBtn('+', () => press('+'), 'op')}
      {keyBtn('0', () => press('0'), 'num', true)}
      {keyBtn('.', () => press('.'), 'num')}
      {keyBtn('=', equals, 'op')}
    </div>
  );

  const convertView = (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={convertUnit}
          onChange={(e) => setConvertUnit(e.target.value)}
          placeholder="5 km to miles"
          className="flex-1 text-sm rounded-lg px-3 py-2 focus:outline-none"
          style={{ backgroundColor: 'var(--calc-key)', color: 'var(--calc-label)' }}
        />
        <button
          onClick={() => { if (convertUnit.trim()) evaluate(`convert ${convertUnit.trim()}`); }}
          className="px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-85"
          style={{ backgroundColor: 'var(--calc-orange)' }}
        >
          Convert
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--calc-dim)' }}>
        Examples: 5 km to miles · 2 liters to cups · 100 fahrenheit to celsius · 3 lb to kg
      </p>
    </div>
  );

  const tipView = (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={tipInput}
          onChange={(e) => setTipInput(e.target.value)}
          placeholder="64.50"
          className="flex-1 text-sm rounded-lg px-3 py-2 focus:outline-none"
          style={{ backgroundColor: 'var(--calc-key)', color: 'var(--calc-label)' }}
        />
        <input
          value={tipPct}
          onChange={(e) => setTipPct(e.target.value.replace(/[^\d.]/g, ''))}
          className="w-20 text-sm rounded-lg px-3 py-2 text-center focus:outline-none"
          style={{ backgroundColor: 'var(--calc-key)', color: 'var(--calc-label)' }}
          title="tip percentage"
        />
        <button
          onClick={() => { if (tipInput.trim()) evaluate(`${tipPct || '15'}% tip on ${tipInput.trim()}`); }}
          className="px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-85"
          style={{ backgroundColor: 'var(--calc-orange)' }}
        >
          Tip
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--calc-dim)' }}>
        Tip % on the amount — e.g. 18% tip on 64.50. Tax works too: <code>add 8.25% tax to 120</code>.
      </p>
    </div>
  );

  return (
    <div className="calc-panel h-full overflow-y-auto p-4">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg text-white" style={{ backgroundColor: 'var(--calc-orange)' }}>
              <Send size={16} />
            </div>
            <h2 className="text-sm font-semibold tracking-wide uppercase" style={{ color: 'var(--calc-label)' }}>
              Calculator
            </h2>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 mb-3 rounded-lg p-1" style={{ backgroundColor: 'var(--calc-key)' }}>
          {(['basic', 'convert', 'tip'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn('flex-1 py-1.5 rounded-md text-xs font-semibold capitalize transition-colors', mode === m ? 'text-white' : 'opacity-60')}
              style={{ backgroundColor: mode === m ? 'var(--calc-orange)' : 'transparent' }}
            >
              {m === 'basic' ? 'Calculator' : m === 'convert' ? 'Convert' : 'Tip'}
            </button>
          ))}
        </div>

        {mode === 'basic' ? (
          <>
            {/* Result display — shows the evaluated result right here */}
            <div className="text-right mb-3 px-2 overflow-x-auto whitespace-nowrap"
              style={{ color: 'var(--calc-label)' }}>
              <div className="text-4xl font-light tracking-tight">{display.slice(-DISPLAY_MAX)}</div>
              <div className="text-sm mt-1 min-h-[20px]" style={{ color: lastError ? '#FF453A' : 'var(--calc-dim)' }}>
                {evaluating ? '…' : lastError ?? (lastResult ? expr : 'press = to evaluate')}
              </div>
            </div>
            {basicGrid}
          </>
        ) : mode === 'convert' ? convertView : tipView}

        {lastError && (
          <div className="mt-3 flex items-start gap-2 text-[11px] rounded-lg p-2.5"
            style={{ color: '#FF453A', backgroundColor: 'var(--calc-key)' }}>
            <XCircle size={13} className="mt-0.5 shrink-0" />
            <span>{lastError}</span>
          </div>
        )}

        {/* In-memory history with real results */}
        {history.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--calc-dim)' }}>
              Recent
            </div>
            <div className="rounded-lg overflow-hidden" style={{ backgroundColor: 'var(--calc-key)' }}>
              {history.map((h, i) => (
                <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  style={{ color: 'var(--calc-label)' }}>
                  <span className="font-mono truncate">{h.expr}</span>
                  <span style={{ color: 'var(--calc-dim)' }}>{h.result}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
