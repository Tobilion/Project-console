import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, RefreshCw, Plus, Trash2, CheckCircle2, Globe, MonitorSmartphone, Zap, Pause, Play, Rows3, Settings2, Send, Clock, Ruler, XCircle, ChevronsLeft, ChevronsRight, ShieldAlert } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 15 (UPGRADE-ROADMAP.md, 2026-08-12): the Notifications panel — IFTTT/Zapier-style
// rule cards ("When <event> in <folder>, notify me"): colored icon circle per event type,
// plain-language sentence, remove action. Add-rule form: folder + type + days threshold.
// Every mutation sends the exact same admin trigger command over WS as typing it in chat.
//
// Round-6 audit (2026-08-24): Postman-style restructure — a collapsible sidebar (Rules /
// Channels / Webhooks) with the main area switching per section, and the Webhooks section
// carries a request builder: URL + Send -> a response panel showing status/time/size from
// POST /api/notifications/test-webhook (the same SSRF-guarded fetch a real send uses).

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

interface TestResult {
  ok: boolean;
  status: number | null;
  timeMs: number;
  sizeBytes: number;
  reason: string | null;
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

const cardCls = 'bg-panel rounded-xl border border-border-faint p-4';
const inputCls = 'text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent-blue/50';

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
  // Round-6: the Postman-style section state — sidebar selection + sidebar collapsed.
  const [section, setSection] = useState<'rules' | 'channels' | 'webhooks'>('rules');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Webhook tester state.
  const [testUrl, setTestUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
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

  const runWebhookTest = async () => {
    const url = testUrl.trim();
    if (!url) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetchJson<TestResult>('/api/notifications/test-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      setTestResult(res || { ok: false, status: null, timeMs: 0, sizeBytes: 0, reason: 'no response from server' });
    } catch {
      setTestResult({ ok: false, status: null, timeMs: 0, sizeBytes: 0, reason: 'request failed' });
    } finally {
      setTesting(false);
    }
  };

  const navItems: { key: typeof section; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'rules', label: 'Watch Rules', icon: <Rows3 size={14} />, badge: rules.length },
    { key: 'channels', label: 'Events & Channels', icon: <Settings2 size={14} />, badge: Object.values(events).filter(Boolean).length },
    { key: 'webhooks', label: 'Webhooks', icon: <Globe size={14} />, badge: webhooks.length },
  ];

  return (
    <div className="h-full flex gap-3 min-h-0">
      {/* Postman-style collapsible sidebar (2026-08-24) */}
      <div className={cn('shrink-0 border border-border-soft rounded-xl bg-panel flex flex-col transition-[width] duration-150', sidebarCollapsed ? 'w-10' : 'w-44')}>
        <div className="flex items-center justify-between px-2 py-2 border-b border-border-faint">
          {!sidebarCollapsed && <span className="text-[10px] uppercase tracking-wider text-fg-dim font-bold px-1">Sections</span>}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-1 text-fg-dim hover:text-fg-strong rounded transition-colors"
            title={sidebarCollapsed ? 'Expand sections' : 'Collapse sections'}
          >
            {sidebarCollapsed ? <ChevronsRight size={13} /> : <ChevronsLeft size={13} />}
          </button>
        </div>
        <nav className="flex flex-col gap-0.5 p-1.5">
          {navItems.map((n) => (
            <button
              key={n.key}
              onClick={() => setSection(n.key)}
              title={n.label}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] transition-colors',
                section === n.key ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-dim hover:text-fg-strong hover:bg-scrim-faint',
                sidebarCollapsed && 'justify-center px-1',
              )}
            >
              {n.icon}
              {!sidebarCollapsed && <span className="flex-1 text-left truncate">{n.label}</span>}
              {!sidebarCollapsed && typeof n.badge === 'number' && n.badge > 0 && (
                <span className="text-[9px] bg-panel-strong border border-border-soft rounded-full px-1.5 py-px">{n.badge}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl">
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

          {section === 'rules' && (
            <>
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
            </>
          )}

          {section === 'channels' && (
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
                <button onClick={() => send('test notification')} className="ml-auto flex items-center gap-1 text-accent-teal hover:text-fg-strong transition-colors" title="Send a test notification to every configured channel now">
                  <Zap size={12} /> Test
                </button>
              </div>
            </div>
          )}

          {section === 'webhooks' && (
            <>
              <div className={cn(cardCls, 'mb-3')}>
                <h3 className="text-xs font-semibold text-fg-strong mb-2">Configured webhooks ({webhooks.length})</h3>
                {webhooks.length === 0 ? (
                  <p className="text-xs text-fg-dim italic">
                    None yet — add one from chat: <code className="font-mono text-accent-teal">webhook add https://hooks.slack.com/...</code>
                  </p>
                ) : (
                  <div className="space-y-1">
                    {webhooks.map((w, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] font-mono text-fg-muted">
                        <Globe size={11} className="text-accent shrink-0" />
                        <span className="truncate">{w}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-fg-dim mt-2">Removal happens from chat (<code className="font-mono">webhook remove &lt;n&gt;</code>) — URLs stay masked here because they are bearer secrets.</p>
              </div>

              {/* Postman-style request builder (2026-08-24): URL + Send -> response panel */}
              <div className={cn(cardCls, 'mb-3')}>
                <h3 className="text-xs font-semibold text-fg-strong mb-2 flex items-center gap-1.5"><Send size={12} /> Test a webhook URL</h3>
                <div className="flex gap-2">
                  <input
                    value={testUrl}
                    onChange={(e) => setTestUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runWebhookTest(); }}
                    placeholder="https://hooks.example.com/..."
                    className={cn(inputCls, 'flex-1 min-w-0 font-mono')}
                  />
                  <button
                    onClick={runWebhookTest}
                    disabled={!testUrl.trim() || testing}
                    className="flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-2 bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Zap size={12} /> {testing ? 'Sending…' : 'Send'}
                  </button>
                </div>
                <p className="text-[10px] text-fg-dim mt-2 flex items-start gap-1">
                  <ShieldAlert size={11} className="mt-px shrink-0" />
                  Same guard as a real send: public HTTPS only — localhost/private addresses are refused, and a redirecting endpoint fails instead of being followed.
                </p>

                {testResult && (
                  <div className={cn('mt-3 rounded-lg border p-3', testResult.ok ? 'border-accent-green/30 bg-accent-green/5' : 'border-accent-red/30 bg-accent-red/5')}>
                    <div className="flex items-center gap-2 mb-2">
                      {testResult.ok ? <CheckCircle2 size={13} className="text-accent-green" /> : <XCircle size={13} className="text-accent-red" />}
                      <span className={cn('text-xs font-bold', testResult.ok ? 'text-accent-green' : 'text-accent-red')}>
                        {testResult.ok ? 'Delivered' : 'Failed'}
                      </span>
                      {testResult.status != null && (
                        <span className={cn('px-1.5 py-px rounded text-[10px] font-mono font-bold', testResult.ok ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red')}>
                          HTTP {testResult.status}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-muted">
                      <span className="flex items-center gap-1"><Clock size={11} /> {testResult.timeMs} ms</span>
                      <span className="flex items-center gap-1"><Ruler size={11} /> {testResult.sizeBytes} bytes body</span>
                      {testResult.reason && <span className="flex items-center gap-1 text-fg-dim"><XCircle size={11} /> {testResult.reason}</span>}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}