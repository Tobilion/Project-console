import React, { useState, useEffect } from 'react';
import { UserProfile } from '../hooks/useUserProfile';
import { Settings, X, ChevronDown, ChevronRight } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { apiFetchJson } from '../utils/apiFetch';

interface UserProfileModalProps {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSave: (updates: Partial<UserProfile>) => void;
}

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

/** Gear-triggered profile editor: name / title / custom role + tuning knobs, persisted via
 *  POST /api/profile and /api/tuning. Same overlay pattern as the welcome tour (fixed backdrop
 *  + centered panel); Esc and backdrop-click close without saving. */
export function UserProfileModal({ open, profile, onClose, onSave }: UserProfileModalProps) {
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title);
  const [customRole, setCustomRole] = useState(profile.customRole);
  const [sandboxRiskyCommands, setSandboxRiskyCommands] = useState(profile.sandboxRiskyCommands);
  const [clipboardHistory, setClipboardHistory] = useState(profile.clipboardHistory);
  const [clipboardPersist, setClipboardPersist] = useState(profile.clipboardPersist);

  // Phase 8 (2026-08-11): runtime tuning-constant editor (server-side shadowing via
  // data/tuning.json — see server/tuningStore.js). Loaded as overrides+defaults when the modal
  // opens; the draft starts at defaults merged over overrides so every knob is visible, and
  // Save posts only the values that differ from the factory default.
  const [tuning, setTuning] = useState<TuningState | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tuningSaved, setTuningSaved] = useState(false);

  // Re-sync the draft whenever the modal opens or the profile changes externally.
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setTitle(profile.title);
      setCustomRole(profile.customRole);
      setSandboxRiskyCommands(profile.sandboxRiskyCommands);
  setClipboardHistory(profile.clipboardHistory);
  setClipboardPersist(profile.clipboardPersist);
      setAdvancedOpen(false);
      setTuningSaved(false);
      apiFetchJson<TuningState>('/api/tuning').then((t) => {
        if (!t) return;
        setTuning(t);
        const merged: Record<string, string> = {};
        for (const [k, v] of Object.entries(t.defaults)) merged[k] = String(v);
        for (const [k, v] of Object.entries(t.overrides)) merged[k] = String(v);
        setDraft(merged);
      });
    }
  }, [open, profile]);

  const canSave = name.trim() && title.trim() && customRole.trim();

  const handleSave = () => {
    onSave({ name: name.trim(), title: title.trim(), customRole: customRole.trim(), sandboxRiskyCommands, clipboardHistory, clipboardPersist });
    onClose();
  };

  const handleSaveTuning = async () => {
    if (!tuning) return;
    const overrides: Record<string, number> = {};
    for (const [k, def] of Object.entries(tuning.defaults)) {
      const raw = (draft[k] ?? '').trim();
      if (raw === '' || raw === String(def)) continue; // untouched → default, send nothing
      const num = Number(raw);
      if (Number.isFinite(num)) overrides[k] = num; // server re-validates bounds anyway
    }
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
      setTimeout(() => setTuningSaved(false), 2000);
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
      setTimeout(() => setTuningSaved(false), 2000);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} maxWidth="max-w-md">
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#3d6bff]/10 rounded-lg text-[#3d6bff]">
            <Settings size={18} />
          </div>
          <h2 className="text-xl font-bold text-fg-strong">User Profile</h2>
        </div>
        <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors">
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-4 space-y-4">
        <div>
          <label className="block text-xs text-fg-dim mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="Your name"
            className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-[#3d6bff] transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-fg-dim mb-1.5">Title</label>
          <input
            type="text"
            list="lpc-titles"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Master (or 'none')"
            className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-[#3d6bff] transition-colors"
          />
          <datalist id="lpc-titles">
            <option value="Master" />
            <option value="Engineer" />
            <option value="Dev" />
            <option value="Dr." />
            <option value="None" />
          </datalist>
        </div>
        <div>
          <label className="block text-xs text-fg-dim mb-1.5">Custom Role</label>
          <input
            type="text"
            value={customRole}
            onChange={(e) => setCustomRole(e.target.value)}
            placeholder="e.g. Software Engineer"
            className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-[#3d6bff] transition-colors"
          />
        </div>
        <div className="flex items-start gap-3 pt-1">
          <button
            type="button"
            role="switch"
            aria-checked={sandboxRiskyCommands}
            onClick={() => setSandboxRiskyCommands(!sandboxRiskyCommands)}
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${sandboxRiskyCommands ? 'bg-[#3d6bff]' : 'bg-panel border border-border-soft'}`}
            title={sandboxRiskyCommands ? 'Sandboxed execution is on' : 'Sandboxed execution is off'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${sandboxRiskyCommands ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Sandbox risky commands</p>
            <p className="text-[11px] text-fg-faint mt-0.5">
              When on, confirmed risky commands run with an environment allowlist and a
              project-restricted cwd (not a container — see the docs for exact guarantees).
              Off by default.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 pt-1">
          <button
            type="button"
            role="switch"
            aria-checked={clipboardHistory}
            onClick={() => setClipboardHistory(!clipboardHistory)}
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${clipboardHistory ? 'bg-[#3d6bff]' : 'bg-panel border border-border-soft'}`}
            title={clipboardHistory ? 'Clipboard history is on' : 'Clipboard history is off'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${clipboardHistory ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Track clipboard history</p>
            <p className="text-[11px] text-fg-faint mt-0.5">
              When on, the console polls the OS clipboard in the background (in-memory, most
              recent 25 entries, deduped). Off by default — your clipboard can hold passwords
              and tokens, so nothing reads it without your say-so.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 pt-3">
          <button
            type="button"
            role="switch"
            aria-checked={clipboardPersist}
            onClick={() => setClipboardPersist(!clipboardPersist)}
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${clipboardPersist ? 'bg-[#3d6bff]' : 'bg-panel border border-border-soft'}`}
            title={clipboardPersist ? 'Clipboard history persistence is on' : 'Clipboard history persistence is off'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${clipboardPersist ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Persist clipboard history to disk</p>
            <p className="text-[11px] text-fg-faint mt-0.5">
              A separate opt-in on top of tracking: writes the in-memory history to a local
              plaintext file so it survives restarts. Persisting clipboard content is a bigger
              privacy commitment than an in-memory buffer — off by default.
            </p>
          </div>
        </div>

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
            <p className="text-[11px] text-fg-faint mt-1.5">
              Raw matcher/executor constants for power users — the defaults are tuned for most
              setups. Change these only if you know what they do.
            </p>
          )}
          {advancedOpen && tuning && (
            <div className="mt-2 space-y-3 max-h-64 overflow-y-auto pr-1">
              {TUNING_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="text-[10px] tracking-[0.15em] uppercase text-fg-faint font-bold mb-1">{group.label}</p>
                  <div className="space-y-2">
                    {group.keys.map(({ name, hint, describe }) => (
                      <div key={name} className="flex items-center justify-between gap-3">
                        <label className="text-[11px] text-fg-subtle flex-1 min-w-0" title={hint}>
                          <span className="font-mono">{name}</span>
                          <span className="block text-[10px] text-fg-faint">{hint}</span>
                          <span className="block text-[10px] text-fg-muted mt-0.5 leading-snug">{describe}</span>
                        </label>
                        <input
                          type="number"
                          value={draft[name] ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
                          className="w-24 bg-surface border border-border-soft rounded-md px-2 py-1 text-[11px] font-mono text-fg focus:outline-none focus:border-accent-blue transition-colors text-right"
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
                {tuningSaved && <span className="text-[10px] text-accent-green">Saved — affects the next match/run</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-2">
        <button
          type="button"
          onClick={() => onSave({ setupComplete: false })}
          className="mr-auto px-3 py-2 text-[10px] text-fg-dim hover:text-fg-strong transition-colors border border-border-faint rounded-lg"
          title="Resets setupComplete so the first-run wizard appears again on the next load"
        >
          Reset onboarding / retake tour
        </button>
        <button onClick={onClose} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-4 py-2 bg-gradient-to-r from-[#3d6bff] to-[#6366f1] text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}
