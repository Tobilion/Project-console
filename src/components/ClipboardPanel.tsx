import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCopy, RefreshCw, Copy, Trash2, Pin, CheckCircle2 } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';

// Phase 8 (UPGRADE-ROADMAP.md, 2026-08-12): the Clipboard panel — Windows Clipboard History
// reference (vertical stack of recent-copy cards, saved snippets pinned above the history,
// hover-reveal actions). When the opt-in clipboardHistory setting is OFF the panel still shows
// and explains how to enable it — never silently disappears. All copy/save actions go through
// the server-side OS clipboard write (clipboardHistory.copyToOsClipboard) via the same WS
// trigger commands chat uses, so CLI and web behave identically.

interface SnippetInfo {
  name: string;
  text: string;
  createdAt: number;
}

interface ClipboardPanelProps {
  onSendMessage: (text: string) => void;
}

const POLL_MS = 4000;
const MAX_PREVIEW = 180;

export function ClipboardPanel({ onSendMessage }: ClipboardPanelProps) {
  const [history, setHistory] = useState<string[]>([]);
  const [snippets, setSnippets] = useState<SnippetInfo[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [persist, setPersist] = useState(false);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchState = useCallback(async () => {
    const [prof, hist, snips] = await Promise.all([
      apiFetchJson<{ userProfile?: { clipboardHistory?: boolean; clipboardPersist?: boolean } }>('/api/profile'),
      apiFetchJson<{ history?: string[] }>('/api/clipboard-history'),
      apiFetchJson<{ snippets?: SnippetInfo[] }>('/api/snippets'),
    ]);
    setEnabled(prof?.userProfile?.clipboardHistory ?? false);
    setPersist(prof?.userProfile?.clipboardPersist ?? false);
    setHistory(hist?.history || []);
    setSnippets(snips?.snippets || []);
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
    setTimeout(fetchState, 1000);
  };

  const copyItem = (i: number) => send(`copy clipboard item ${i + 1}`);
  const copySnippet = (name: string) => send(`copy snippet ${name}`);
  const deleteSnippet = (name: string) => send(`delete snippet ${name}`);
  const saveFromClipboard = () => {
    if (!saveName.trim() || history.length === 0) return;
    send(`save this as a snippet: ${saveName.trim()} : ${history[0]}`);
    setSaveName('');
  };

  const cardCls = 'rounded-md border border-border-faint bg-panel hover:border-accent/30 transition-colors';
  const actionBtn = 'p-1.5 text-fg-dim hover:text-fg-strong rounded transition-colors opacity-0 group-hover:opacity-100';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <ClipboardCopy size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Clipboard</h2>
          </div>
          <button onClick={fetchState} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-md transition-colors" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>

        {/* Feature-off explanation — the panel never silently disappears */}
        {enabled === false && (
          <div className="mb-4 text-xs text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-3">
            <p className="font-semibold text-fg-strong mb-1">Clipboard history is off.</p>
            <p>
              It's opt-in by design — the clipboard can hold passwords and tokens, so nothing
              polls it without your say-so. Enable it in the profile modal (gear →{' '}
              <code className="font-mono text-accent">Track clipboard history</code>), or from
              chat: <code className="font-mono text-accent">open clipboard</code> still works for
              snippets. {persist && 'Persistence is also on — history survives restarts on disk.'}
            </p>
          </div>
        )}

        {lastSent && (
          <div className="mb-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
            <CheckCircle2 size={13} className="text-accent mt-0.5 shrink-0" />
            <span>Sent <code className="font-mono text-accent">{lastSent}</code> — confirm or follow the result in the chat below.</span>
          </div>
        )}

        {/* Save current clipboard as a snippet */}
        {enabled && (
          <div className="flex gap-2 mb-4">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value.replace(/[^\w-]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') saveFromClipboard(); }}
              placeholder="save current clipboard as snippet…"
              className="flex-1 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent/50"
            />
            <button onClick={saveFromClipboard} disabled={!saveName.trim() || history.length === 0} className="text-xs font-medium rounded-lg px-3 py-2 bg-accent/90 text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              Save
            </button>
          </div>
        )}

        {/* Saved snippets — pinned section above history */}
        {snippets.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-fg-dim mb-2">
              <Pin size={11} /> Saved snippets ({snippets.length})
            </div>
            <div className="space-y-1.5">
              {snippets.map((s) => (
                <div key={s.name} className={cn(cardCls, 'group flex items-center gap-2 px-3 py-2')}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-fg-strong">{s.name}</div>
                    <div className="text-[11px] text-fg-dim truncate" title={s.text}>
                      {s.text.length > MAX_PREVIEW ? s.text.slice(0, MAX_PREVIEW) + '…' : s.text}
                    </div>
                  </div>
                  <button onClick={() => copySnippet(s.name)} className={actionBtn} title="Copy snippet">
                    <Copy size={13} />
                  </button>
                  <button onClick={() => deleteSnippet(s.name)} className={cn(actionBtn, 'hover:text-red-400')} title="Delete snippet">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Clipboard history — most recent at top */}
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-fg-dim mb-2">
          <ClipboardCopy size={11} /> History ({history.length})
        </div>
        {enabled && history.length === 0 && (
          <div className="text-xs text-fg-dim italic bg-panel border border-border-soft rounded-lg p-4 text-center">
            Copy something on this machine and it shows up here (most recent first, deduped).
          </div>
        )}
        <div className="space-y-1.5">
          {history.map((h, i) => (
            <div key={`${i}-${h.slice(0, 24)}`} className={cn(cardCls, 'group flex items-center gap-2 px-3 py-2')}>
              <span className="text-[11px] text-fg-faint w-5 shrink-0 text-right">{i + 1}</span>
              <span className="flex-1 min-w-0 text-xs text-fg-muted truncate" title={h}>
                {h.length > MAX_PREVIEW ? h.slice(0, MAX_PREVIEW) + '…' : h}
              </span>
              <button onClick={() => copyItem(i)} className={actionBtn} title={`Copy item ${i + 1}`}>
                <Copy size={13} />
              </button>
            </div>
          ))}
        </div>

        {enabled && history.length > 0 && (
          <button onClick={() => send('clear clipboard history')} className="mt-3 text-[11px] text-fg-dim hover:text-red-400 transition-colors">
            Clear clipboard history
          </button>
        )}
      </div>
    </div>
  );
}
