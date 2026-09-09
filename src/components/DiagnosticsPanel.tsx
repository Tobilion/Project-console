import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, Wrench, MessageSquare } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { useFlashMessage } from '../hooks/usePanelPolling';
import { cn } from '../lib/utils';
import { EmptyState } from './ui/EmptyState';

// K-10 (2026-09-09): Settings/UI surface for `console doctor` — the same checks and safe
// auto-fixes the CLI (`node bin/cli.js doctor [--fix]`, `console doctor` in chat) and the
// K-11 troubleshoot flow use, rendered as rows instead of terminal text. Machine-scoped, not
// project-scoped (ports/daemon/model/cache/Ollama are console-level), so unlike the sibling
// panels it takes no project/tab props — same shape as ClipboardPanel. Checks run on demand
// (mount + Refresh), never polled: several checks probe live ports/processes and a 15s poll
// would be pure waste for data that only changes when something breaks.

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

interface DiagnosticsPanelProps {
  onSendMessage: (text: string) => void;
}

const STATUS_STYLE: Record<DoctorCheck['status'], string> = {
  ok: 'bg-accent-green/15 text-accent-green',
  warn: 'bg-accent-orange/15 text-accent-orange',
  fail: 'bg-accent-red/15 text-accent-red',
};

const STATUS_DOT: Record<DoctorCheck['status'], string> = {
  ok: 'bg-accent-green',
  warn: 'bg-accent-orange',
  fail: 'bg-accent-red',
};

export function DiagnosticsPanel({ onSendMessage }: DiagnosticsPanelProps) {
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [exitCode, setExitCode] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFix, flashFix] = useFlashMessage();

  const fetchChecks = useCallback(async () => {
    setLoading(true);
    const data = await apiFetchJson<{ checks: DoctorCheck[]; exitCode: number }>('/api/doctor');
    setLoading(false);
    if (!data) { setError('Could not reach the server.'); return; }
    setError(null);
    setChecks(data.checks || []);
    setExitCode(data.exitCode ?? 0);
  }, []);

  useEffect(() => { void fetchChecks(); }, [fetchChecks]);

  const runFix = async () => {
    setFixing(true);
    const data = await apiFetchJson<{ fixes: string[] }>('/api/doctor/fix', { method: 'POST' });
    setFixing(false);
    if (!data) { setError('Could not reach the server.'); return; }
    setError(null);
    flashFix(data.fixes.length > 0 ? `Fixed: ${data.fixes.join('; ')}` : 'Nothing to fix — everything actionable is already clean.');
    await fetchChecks();
  };

  const issues = checks.filter((c) => c.status !== 'ok').length;
  const cardCls = 'bg-panel rounded-xl border border-border-soft p-4';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal">
              <Activity size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Diagnostics</h2>
            {checks.length > 0 && (
              <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold', STATUS_STYLE[exitCode === 0 ? 'ok' : exitCode === 1 ? 'warn' : 'fail'])}>
                {issues === 0 ? 'Healthy' : `${issues} issue${issues > 1 ? 's' : ''}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={runFix}
              disabled={fixing || loading}
              className="flex items-center gap-1.5 text-xs font-bold rounded-xl px-4 py-2 bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              title="Apply every safe auto-fix (stale daemon lock, orphaned temp files, cache re-verify)"
            >
              <Wrench size={12} /> {fixing ? 'Fixing…' : 'Auto-fix'}
            </button>
            <button onClick={fetchChecks} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors" title="Re-run checks">
              <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-accent-red mb-3">{error}</p>}

        {lastFix && (
          <div className="mb-3 flex items-start gap-2 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/20 rounded-lg p-2.5">
            <span>{lastFix}</span>
          </div>
        )}

        {checks.length === 0 && !error ? (
          <EmptyState icon={<Activity size={18} />} title={loading ? 'Running checks…' : 'No results yet'} hint="Hit refresh to run the machine checks." className="py-6" />
        ) : (
          <div className={cn(cardCls, 'p-2 space-y-1')}>
            {checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg">
                <span className={cn('mt-1 w-2 h-2 rounded-full shrink-0', STATUS_DOT[c.status])} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-fg-strong">{c.name}</span>
                    <span className={cn('px-1.5 py-px rounded-full text-[10px] font-bold uppercase', STATUS_STYLE[c.status])}>{c.status}</span>
                  </div>
                  <p className="text-[11px] text-fg-dim mt-0.5 leading-snug">{c.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 text-[11px] text-fg-dim px-1">
          <MessageSquare size={13} className="shrink-0" />
          <span>
            Same checks as <code className="font-mono">console doctor</code> in the terminal.
            Something broken in chat?{' '}
            <button onClick={() => onSendMessage('troubleshoot')} className="text-accent-blue hover:text-fg-strong transition-colors font-medium">
              Troubleshoot in chat
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
