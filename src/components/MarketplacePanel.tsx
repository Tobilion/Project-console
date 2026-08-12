import { useCallback, useEffect, useState } from 'react';
import { Store, RefreshCw, Download, CheckCircle2, Globe } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 17 (UPGRADE-ROADMAP.md, 2026-08-12): the Pack Marketplace panel — App Store browsing
// grid reference (responsive card grid, the larger 18-20px card radius that's the App Store's
// visual signature, icon + name + one-line description + author/version, Install as the
// primary action). The panel is a browsing/preview convenience: Install sends the exact same
// "install pack <name> from registry" trigger command over WS — never a separate install path.
// The registry URL is empty by default (no silent network calls); setting it requires the
// admin command `set pack registry <url>` (or the field below, which sends that same command).

interface RegistryPack {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  manifestUrl: string;
  checksum?: string;
}

interface MarketplacePanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

export function MarketplacePanel({ project, onSendMessage }: MarketplacePanelProps) {
  const [packs, setPacks] = useState<RegistryPack[]>([]);
  const [registryUrl, setRegistryUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const cfg = await apiFetchJson<{ url: string | null }>('/api/registry/config');
    setRegistryUrl(cfg?.url || '');
    setUrlInput(cfg?.url || '');
    if (!cfg?.url) { setStatus('idle'); setPacks([]); return; }
    setStatus('loading');
    const data = await apiFetchJson<{ packs: RegistryPack[] }>('/api/registry/packs');
    if (!data) { setStatus('error'); setError('Could not reach the registry.'); return; }
    setStatus('ready');
    setPacks(data.packs || []);
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    setTimeout(() => setLastSent(null), 8000);
    setTimeout(fetchState, 1500);
  };

  const saveUrl = () => {
    const u = urlInput.trim();
    if (!u) return;
    if (!/^https:\/\//.test(u)) { setError('The registry URL must be HTTPS.'); return; }
    setError(null);
    send(`set pack registry ${u}`);
  };

  const install = (name: string) => send(`install pack ${name} from registry`);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal">
              <Store size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Pack Marketplace</h2>
          </div>
          <button onClick={fetchState} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-md transition-colors" title="Refresh">
            <RefreshCw size={15} className={cn(status === 'loading' && 'animate-spin')} />
          </button>
        </div>

        {lastSent && (
          <div className="mb-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
            <CheckCircle2 size={13} className="text-accent-teal mt-0.5 shrink-0" />
            <span>Sent <code className="font-mono text-accent-teal">{lastSent}</code> — the preview and confirm appear in the chat below.</span>
          </div>
        )}

        {/* Registry URL field */}
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Globe size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/pack-registry.json (no registry configured by default)"
              className="w-full pl-8 pr-3 py-2 text-xs bg-panel-strong border border-border-soft rounded-lg text-fg-strong font-mono focus:outline-none focus:border-accent-blue/50"
            />
          </div>
          <button onClick={saveUrl} disabled={!urlInput.trim()} className="text-xs font-bold rounded-lg px-4 py-2 bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
            Set registry
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        {status === 'idle' && (
          <div className="text-xs text-fg-dim italic bg-panel rounded-2xl border border-border-soft p-6 text-center">
            No registry configured. Point one up above — it must be a public HTTPS URL to a JSON
            index. This console does not host or vet any registry; whatever you point it at is at
            your own risk (same trust model as a custom npm registry). Installing still goes
            through the normal preview-then-confirm flow with checksum verification.
          </div>
        )}
        {status === 'error' && (
          <div className="text-xs text-red-400 bg-panel rounded-2xl border border-border-soft p-6 text-center">{error}</div>
        )}
        {status === 'ready' && packs.length === 0 && (
          <div className="text-xs text-fg-dim italic bg-panel rounded-2xl border border-border-soft p-6 text-center">
            The registry is configured but lists no packs yet.
          </div>
        )}

        {/* App Store-style card grid */}
        {status === 'ready' && packs.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((p) => (
              <div key={p.name} className="bg-panel rounded-2xl border border-border-faint p-4 flex flex-col">
                <div className="flex items-start gap-3 mb-2">
                  <div className="w-12 h-12 rounded-[10px] bg-panel-strong text-accent-blue flex items-center justify-center text-lg font-bold shrink-0">
                    {(p.name || '?')[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg-strong truncate">{p.name}</div>
                    <div className="text-[10px] text-fg-dim">{p.author || 'unknown author'} · v{p.version || '?'}</div>
                  </div>
                </div>
                <p className="text-[11px] text-fg-muted leading-relaxed mb-3 line-clamp-2 flex-1">{p.description || 'No description.'}</p>
                <button
                  onClick={() => install(p.name)}
                  className="flex items-center justify-center gap-1.5 text-xs font-bold rounded-full px-3 py-1.5 bg-accent-blue text-white hover:opacity-90 transition-opacity"
                >
                  <Download size={12} /> Install
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
