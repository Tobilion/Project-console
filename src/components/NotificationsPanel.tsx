import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, RefreshCw, Plus, Trash2, CheckCircle2, Globe, MonitorSmartphone, Zap, Pause, Play } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 15 (UPGRADE-ROADMAP.md, 2026-08-12): the Notifications panel — IFTTT/Zapier-style
// rule cards ("When <event> in <folder>, notify me"): colored icon circle per event type,
// plain-language sentence, remove action. Add-rule form: folder + type + days threshold.
// Every mutation sends the exact same admin trigger command over WS as typing it in chat.

interface WatchRule {
  id: string;
  folder: string;
  event: 'file-changed' | 'file-added' | 'folder-stale';
  days: number | null;
  projectName: string | null;
  createdAt: number;
  enabled: boolean;
  lastFiredAt?: number;
}

interface NotificationsPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

const POLL_MS = 10000;

const EVENT_COLORS: Record<string, string> = {
  'file-changed': 'var(--color-accent-blue)',
  'file-added': 'var(--color-accent-green)',
  'folder-stale': 'var(--color-accent-orange)',
};

const EVENT_LABEL: Record<string, string> = {
  'file-changed': 'file changes',
  'file-added': 'a new file appears',
  'folder-stale': 'no changes for N days',
};

function ruleSentence(r: WatchRule): string {
  if (r.event === 'folder-stale') {
    return `When ${r.folder} hasn't changed in ${r.days} days, notify me`;
  }
  return `When ${EVENT_LABEL[r.event]} in ${r.folder}, notify me`;
}

function lastFiredText(r: WatchRule): string {
  if (!r.lastFiredAt) return 'never fired';
  return `last fired ${new Date(r.lastFiredAt).toLocaleString()}`;
}

export function NotificationsPanel({ project, onSendMessage }: NotificationsPanelProps) {
  const [rules, setRules] = useState<WatchRule[]>([]);
  const [events, setEvents] = useState<Record<string, boolean>>({});
  const [desktop, setDesktop] = useState(false);
  const [webhooks, setWebhooks] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [ruleType, setRuleType] = useState<'file-changed' | 'file-added' | 'folder-stale'>('file-changed');
  const [days, setDays] = useState('7');
  const [lastSent, setLastSent] = useState<string | null>(null);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the pending "last sent" timer on unmount so its delayed setState can't fire on a
  // dead panel (and hold the panel's closure alive after it unmounted).
  useEffect(() => () => { if (lastSentTimer.current) clearTimeout(lastSentTimer.current); }, []);

  const fetchState = useCallback(async () => {
    const data = await apiFetchJson<{ rules: WatchRule[]; events: Record<string, boolean>; desktop: boolean; webhooks: string[] }>('/api/notifications');
    if (!data) return;
    setRules(data.rules || []);
    setEvents(data.events || {});
    setDesktop(data.desktop);
    setWebhooks(data.webhooks || []);
  }, []);

  useEffect(() => {
    fetchState();
    const t = setInterval(fetchState, POLL_MS);
    return () => clearInterval(t);
  }, [fetchState]);

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    lastSentTimer.current = setTimeout(() => setLastSent(null), 8000);
    setTimeout(fetchState, 1200);
  };

  const addRule = () => {
    if (!folder.trim()) return;
    if (ruleType === 'folder-stale') {
      send(`notify me if ${folder.trim()} hasn't changed in ${days.trim() || '7'} days`);
    } else {
      send(`notify me when ${ruleType === 'file-added' ? 'a new file appears' : 'files change'} in ${folder.trim()}`);
    }
    setFolder('');
  };

  const toggleEvent = (event: string, on: boolean) => {
    send(on ? `notify me when ${event}` : `stop notifying me about ${event}`);
  };

  const cardCls = 'bg-panel rounded-xl border border-border-faint p-4';
  const inputCls = 'text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent-blue/50';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-accent-orange/15 text-accent-orange">
              <Bell size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Notifications</h2>
          </div>
          <button onClick={fetchState} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>

        {lastSent && (
          <div className="mb-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
            <CheckCircle2 size={13} className="text-accent-teal mt-0.5 shrink-0" />
            <span>Sent <code className="font-mono text-accent-teal">{lastSent}</code> — follow the result in the chat below.</span>
          </div>
        )}

        {/* Add-rule form */}
        <div className={cn(cardCls, 'mb-4')}>
          <h3 className="text-xs font-semibold text-fg-strong mb-2">Add a watch rule</h3>
          <div className="flex flex-wrap gap-2">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Folder path (e.g. C:\Users\you\Downloads)"
              className={cn(inputCls, 'flex-1 min-w-[220px]')}
            />
            <select value={ruleType} onChange={(e) => setRuleType(e.target.value as typeof ruleType)} className={inputCls}>
              <option value="file-changed">File changes</option>
              <option value="file-added">New file appears</option>
              <option value="folder-stale">Goes stale</option>
            </select>
            {ruleType === 'folder-stale' && (
              <input
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))}
                className={cn(inputCls, 'w-16 text-center')}
                title="days without changes"
              />
            )}
            <button onClick={addRule} disabled={!folder.trim()} className="flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-2 bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
              <Plus size={12} /> Add rule
            </button>
          </div>
          <p className="text-[11px] text-fg-dim mt-2">
            Rules are notification-only — they never run commands. Each rule also needs its event
            enabled below to actually fire. Pause/resume toggles a single rule without removing it.
          </p>
        </div>

        {/* Event toggles */}
        <div className={cn(cardCls, 'mb-4')}>
          <h3 className="text-xs font-semibold text-fg-strong mb-2">Events & channels</h3>
          <div className="space-y-1.5">
            {Object.entries(events).map(([event, on]) => (
              <div key={event} className="flex items-center justify-between gap-2 py-1">
                <span className="text-xs text-fg-muted font-mono">{event}</span>
                <button
                  onClick={() => toggleEvent(event, !on)}
                  role="switch"
                  aria-checked={on}
                  className={`relative w-11 h-6 rounded-full transition-colors ${on ? 'bg-accent-green' : 'bg-panel-strong border border-border-strong'}`}
                  title={on ? `${event} on` : `${event} off`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-float transition-transform ${on ? 'translate-x-5' : ''}`} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 mt-3 pt-2 border-t border-border-faint text-[11px] text-fg-dim">
            <span className="flex items-center gap-1"><MonitorSmartphone size={12} /> Desktop: {desktop ? 'on' : 'off'}</span>
            <span className="flex items-center gap-1"><Globe size={12} /> Webhooks: {webhooks.length === 0 ? 'none' : webhooks.length}</span>
            <button onClick={() => send('test notification')} className="ml-auto flex items-center gap-1 text-accent-teal hover:text-fg-strong transition-colors" title="Send a test notification now">
              <Zap size={12} /> Test
            </button>
          </div>
        </div>

        {/* Watch-rule cards */}
        <div className={cn(cardCls, 'mb-3')}>
          <h3 className="text-xs font-semibold text-fg-strong mb-2">Watched folders ({rules.length})</h3>
          {rules.length === 0 ? (
            <p className="text-xs text-fg-dim italic">
              No rules yet — add one above, or type <code className="font-mono text-accent-teal">notify me when files change in C:\Users\you\Documents</code> in chat.
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map((r) => (
                <div key={r.id} className={cn('bg-panel rounded-xl border border-border-faint p-4 flex items-center gap-3', !r.enabled && 'opacity-60')}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: EVENT_COLORS[r.event] || 'var(--color-accent-blue)' }} />
                  <span className="flex-1 text-xs text-fg-subtle min-w-0">
                    <span className="block truncate" title={r.folder}>{ruleSentence(r)}</span>
                    <span className={cn('block text-[10px] mt-0.5', r.lastFiredAt ? 'text-fg-dim' : 'text-fg-faint')}>{lastFiredText(r)}</span>
                  </span>
                  <button
                    onClick={() => send(`${r.enabled ? 'disable' : 'enable'} watch rule ${r.id}`)}
                    className={cn('p-1.5 rounded-lg transition-colors flex items-center gap-1 text-[11px]', r.enabled ? 'text-fg-dim hover:text-accent-orange' : 'text-accent-green hover:text-fg-strong')}
                    title={r.enabled ? 'Disable this rule (stops firing, keeps it listed)' : 'Enable this rule'}
                  >
                    {r.enabled ? <Pause size={13} /> : <Play size={13} />}
                    {r.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button onClick={() => send(`stop watching ${r.folder}`)} className="p-1 text-fg-dim hover:text-accent-red rounded transition-colors" title="Remove rule">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
