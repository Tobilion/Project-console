// Runtime tuning-constant editor (2026-08-24, split out of UserProfileModal.tsx).
// Self-contained: fetches GET /api/tuning on mount, POSTs only the values that differ from
// the factory default, DELETE resets. Server re-validates bounds (server/tuningStore.js).

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetchJson } from '../../utils/apiFetch';

interface TuningState {
  defaults: Record<string, number>;
  overrides: Record<string, number>;
}

// Plain-language descriptions for the tuning knobs — one line each, drawn from the source
// comments (tuningStore.js defaults + executor/verifyHarness constants) so the meaning is
// clear without reading code.
const TUNING_GROUPS: { label: string; keys: { name: string; hint: string; describe: string }[] }[] = [
  {
    label: 'Matching',
    keys: [
      { name: 'FUSE_THRESHOLD', hint: 'fuzzy match floor (0–1)', describe: 'How close a fuzzy text match must be before the console trusts it as a command.' },
      { name: 'FUSE_MIN_MATCH_CHAR_LENGTH', hint: 'min characters for a fuzzy hit', describe: 'The shortest input that fuzzy matching will even consider — shorter text is never matched.' },
      { name: 'INIT_WAIT_POLL_MS', hint: 'matcher startup poll interval, ms', describe: 'How often the matcher checks whether the embedding model finished loading at startup.' },
      { name: 'SUGGESTION_DEFAULT_LIMIT', hint: 'max "did you mean" suggestions', describe: 'How many fallback command suggestions are shown when nothing matches confidently.' },
      { name: 'COLLISION_DEFAULT_THRESHOLD', hint: 'intent-collision cosine floor (0–1)', describe: 'How similar two intents must be in embedding space before the collision monitor flags them.' },
    ],
  },
  {
    label: 'Executor',
    keys: [
      { name: 'DEV_URL_DETACH_GRACE_MS', hint: 'grace after a detected URL, ms', describe: 'How long after a dev server prints its URL before the console stops tracking it as a child process.' },
      { name: 'DEV_SERVER_FORCE_DETACH_MS', hint: 'detach recognized dev servers after, ms', describe: 'How long a recognized dev-server command runs before the console detaches and lets it live on its own.' },
      { name: 'LONG_RUNNING_FORCE_DETACH_MS', hint: 'detach other long commands after, ms', describe: 'Same detach rule for long-running commands that are not recognized dev servers.' },
      { name: 'STDOUT_SUMMARY_CAP', hint: 'stdout tail shown in results, chars', describe: 'How much standard output is kept in the result summary for long-running commands.' },
      { name: 'STDERR_SUMMARY_CAP', hint: 'stderr tail shown in results, chars', describe: 'How much error output is kept in the result summary for long-running commands.' },
    ],
  },
  {
    label: 'Type check',
    keys: [{ name: 'DEBOUNCE_MS', hint: 'verification debounce after file edits, ms', describe: 'How long the console waits after a file edit before running a background type check.' }],
  },
];

export function TuningSection() {
  const [tuning, setTuning] = useState<TuningState | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tuningSaved, setTuningSaved] = useState(false);
  const [invalidTuningKeys, setInvalidTuningKeys] = useState<string[]>([]);
  const tuningSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the "tuning saved" timer on unmount so its delayed setState can't fire on a dead
  // modal (and hold its closure alive after it unmounted).
  useEffect(() => () => { if (tuningSavedTimer.current) clearTimeout(tuningSavedTimer.current); }, []);

  // Phase 8 (2026-08-11): runtime tuning-constant editor (server-side shadowing via
  // data/tuning.json — see server/tuningStore.js). Loaded as overrides+defaults when the
  // section mounts; the draft starts at defaults merged over overrides so every knob is
  // visible, and Save posts only the values that differ from the factory default.
  useEffect(() => {
    apiFetchJson<TuningState>('/api/tuning').then((t) => {
      if (!t) return;
      setTuning(t);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(t.defaults)) merged[k] = String(v);
      for (const [k, v] of Object.entries(t.overrides)) merged[k] = String(v);
      setDraft(merged);
    });
  }, []);

  const handleSaveTuning = async () => {
    if (!tuning) return;
    const overrides: Record<string, number> = {};
    const bad: string[] = [];
    for (const [k, def] of Object.entries(tuning.defaults)) {
      const raw = (draft[k] ?? '').trim();
      if (raw === '' || raw === String(def)) continue; // untouched → default, send nothing
      const num = Number(raw);
      if (Number.isFinite(num)) overrides[k] = num; // server re-validates bounds anyway
      else bad.push(k); // audit 2026-08-17: non-numeric drafts were silently dropped — flag them
    }
    setInvalidTuningKeys(bad);
    if (bad.length > 0) return;
    const res = await apiFetchJson<{ applied: Record<string, number>; defaults: Record<string, number>; overrides: Record<string, number> }>(
      '/api/tuning',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides }) },
    );
    if (res) {
      setTuning({ defaults: res.defaults, overrides: res.overrides });
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.defaults)) merged[k] = String(v);
      for (const [k, v] of Object.entries(res.overrides)) merged[k] = String(v);
      setDraft(merged);
      setTuningSaved(true);
      if (tuningSavedTimer.current) clearTimeout(tuningSavedTimer.current);
      tuningSavedTimer.current = setTimeout(() => setTuningSaved(false), 2000);
    }
  };

  const handleResetTuning = async () => {
    const res = await apiFetchJson<{ defaults: Record<string, number>; overrides: Record<string, number> }>(
      '/api/tuning',
      { method: 'DELETE' },
    );
    if (res) {
      setTuning({ defaults: res.defaults, overrides: res.overrides });
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.defaults)) merged[k] = String(v);
      setDraft(merged);
      setTuningSaved(true);
      if (tuningSavedTimer.current) clearTimeout(tuningSavedTimer.current);
      tuningSavedTimer.current = setTimeout(() => setTuningSaved(false), 2000);
    }
  };

  return (
    <div className="pt-1 border-t border-border-faint">
      <button
        type="button"
        onClick={() => setAdvancedOpen(!advancedOpen)}
        className="flex items-center gap-1.5 text-xs text-fg-dim hover:text-fg-strong transition-colors"
      >
        {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Developer / Advanced — you probably don't need this
        {tuning && Object.keys(tuning.overrides).length > 0 && (
          <span className="text-[10px] text-accent">({Object.keys(tuning.overrides).length} overridden)</span>
        )}
      </button>
      {advancedOpen && (
        <p className="text-[11px] text-fg-dim mt-1.5">
          Raw matcher/executor constants for power users — the defaults are tuned for most
          setups. Change these only if you know what they do.
        </p>
      )}
      {advancedOpen && tuning && (
        <div className="mt-2 space-y-3 max-h-64 overflow-y-auto pr-1">
          {TUNING_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] tracking-[0.15em] uppercase text-fg-dim font-bold mb-1">{group.label}</p>
              <div className="space-y-2">
                {group.keys.map(({ name, hint, describe }) => (
                  <div key={name} className="flex items-center justify-between gap-3">
                    <label className="text-[11px] text-fg-subtle flex-1 min-w-0" title={hint}>
                      <span className="font-mono">{name}</span>
                      <span className="block text-[10px] text-fg-dim">{hint}</span>
                      <span className="block text-[10px] text-fg-muted mt-0.5 leading-snug">{describe}</span>
                    </label>
                    <input
                      type="number"
                      value={draft[name] ?? ''}
                      onChange={(e) => { setDraft((d) => ({ ...d, [name]: e.target.value })); setInvalidTuningKeys((ks) => ks.filter((k) => k !== name)); }}
                      className={`w-24 bg-surface border border-border-soft rounded-lg px-2 py-1 text-[11px] font-mono text-fg focus:outline-none focus:border-accent-blue transition-colors text-right ${invalidTuningKeys.includes(name) ? 'border-accent-red' : ''}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSaveTuning}
              className="px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors"
            >
              Apply tuning
            </button>
            <button
              type="button"
              onClick={handleResetTuning}
              className="px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg bg-scrim-faint text-fg-dim hover:text-fg-strong border border-border-soft transition-colors"
            >
              Reset all
            </button>
            {invalidTuningKeys.length > 0 && (
              <span className="text-[10px] text-accent-red">
                Not numbers: {invalidTuningKeys.join(', ')} — fix or clear them, then Apply again.
              </span>
            )}
            {tuningSaved && <span className="text-[10px] text-accent-green">Saved — affects the next match/run</span>}
          </div>
        </div>
      )}
    </div>
  );
}