import React, { useState, useEffect, useRef } from 'react';
import { UserProfile } from '../hooks/useUserProfile';
import { Settings, X, ChevronDown, ChevronRight, Plus, Trash2, Save, Code, LayoutGrid, List, Compass } from 'lucide-react';
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

// Phase T2 (2026-08-14): the editor/IDE registry shape from GET /api/editors.
interface EditorsState {
  editors: { id: string; name: string; command: string }[];
  defaults: Record<string, string>;
}

const EXT_DEFAULT_HINTS: [string, string][] = [
  ['.py', 'Python'], ['.java', 'Java'], ['.js', 'JavaScript'], ['.ts', 'TypeScript'],
  ['.c', 'C'], ['.cpp', 'C++'], ['.cs', 'C#'], ['.kt', 'Kotlin'], ['.html', 'HTML'],
  ['.md', 'Markdown'], ['.json', 'JSON'], ['.css', 'CSS'],
];

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
  const [scanAllFolders, setScanAllFolders] = useState(profile.scanAllFolders);
  const [explorerViewMode, setExplorerViewMode] = useState<'list' | 'grid'>(profile.explorerViewMode);
  const [editors, setEditors] = useState<EditorsState | null>(null);
  const [editorsDirty, setEditorsDirty] = useState(false);
  const [editorsSaved, setEditorsSaved] = useState(false);
  const editorsSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase T2: tours are defined in src/tours.ts; this section just records completion
  // badges (localStorage, same inline style as pinned projects) and launches a tour via a
  // custom event the App listens for.
  const [tourSection, setTourSection] = useState<string | null>(null);
  const tuningSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the "tuning saved" timer on unmount so its delayed setState can't fire on a dead
  // modal (and hold its closure alive after it unmounted).
  useEffect(() => () => { if (tuningSavedTimer.current) clearTimeout(tuningSavedTimer.current); }, []);

  // Stage H: accent-color presets + custom-hex draft. The chosen value persists through the
  // existing profile-write path (onSave) and App.tsx applies it as an inline
  // --color-accent-blue override — semantic accents (teal/orange/green/red) are untouched.
  const ACCENT_PRESETS: { label: string; value: string }[] = [
    { label: 'Blue', value: '#0A84FF' },
    { label: 'Purple', value: '#BF5AF2' },
    { label: 'Pink', value: '#FF375F' },
    { label: 'Red', value: '#FF453A' },
    { label: 'Orange', value: '#FF9F0A' },
    { label: 'Yellow', value: '#FFD60A' },
    { label: 'Green', value: '#30D158' },
    { label: 'Graphite', value: '#8E8E93' },
  ];
  const [hexDraft, setHexDraft] = useState('');
  const hexValid = /^[0-9a-fA-F]{6}$/.test(hexDraft);
  const applyAccent = (value: string) => onSave({ accentColor: value });

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
      setScanAllFolders(profile.scanAllFolders);
      setExplorerViewMode(profile.explorerViewMode === 'grid' ? 'grid' : 'list');
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
      apiFetchJson<EditorsState>('/api/editors').then((e) => {
        if (e) setEditors(e);
      });
      setEditorsDirty(false);
      setEditorsSaved(false);
    }
  }, [open, profile]);

  const canSave = name.trim() && title.trim() && customRole.trim();
  // Audit 2026-08-17: the old disabled-Save gate gave zero feedback — a user with an empty
  // field got a button that did nothing. Save is always clickable now; on click the modal
  // shows inline per-field errors and stays open until all three are valid (still
  // all-or-nothing: nothing persists unless every field passes).
  const [showErrors, setShowErrors] = useState(false);
  const [invalidTuningKeys, setInvalidTuningKeys] = useState<string[]>([]);

  const handleSave = () => {
    if (!canSave) {
      setShowErrors(true);
      return;
    }
    onSave({ name: name.trim(), title: title.trim(), customRole: customRole.trim(), sandboxRiskyCommands, clipboardHistory, clipboardPersist, scanAllFolders, explorerViewMode });
    onClose();
  };

  const fieldError = (value: string) => showErrors && !value.trim();

  const handleSaveEditors = async () => {
    if (!editors) return;
    const res = await apiFetchJson<EditorsState>('/api/editors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editors: editors.editors, defaults: editors.defaults }),
    });
    if (res) {
      setEditors(res);
      setEditorsDirty(false);
      setEditorsSaved(true);
      if (editorsSavedTimer.current) clearTimeout(editorsSavedTimer.current);
      editorsSavedTimer.current = setTimeout(() => setEditorsSaved(false), 2000);
    }
  };

  const mutateEditors = (fn: (e: EditorsState) => EditorsState) => {
    if (!editors) return;
    setEditors(fn(editors));
    setEditorsDirty(true);
  };

  const launchTour = (id: string) => {
    // The App listens for this and opens TourOverlay for the section (see App.tsx).
    window.dispatchEvent(new CustomEvent('lpc:launch-tour', { detail: { section: id } }));
    setTourSection(id);
  };

  // Tour completion badges — shared localStorage key with TourOverlay.
  const toursTaken = (() => {
    try { return JSON.parse(localStorage.getItem('console.toursTaken') || '{}'); } catch { return {}; }
  })();

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
    <ModalShell open={open} onClose={onClose} maxWidth="max-w-md">
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent-blue/10 rounded-lg text-accent-blue">
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
            className={`w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors ${fieldError(name) ? 'border-accent-red' : ''}`}
          />
          {fieldError(name) && <p className="text-[10px] text-accent-red mt-1">Name is required — the profile can't save without it.</p>}
        </div>
        <div>
          <label className="block text-xs text-fg-dim mb-1.5">Title</label>
          <input
            type="text"
            list="lpc-titles"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Master (or 'none')"
            className={`w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors ${fieldError(title) ? 'border-accent-red' : ''}`}
          />
          {fieldError(title) && <p className="text-[10px] text-accent-red mt-1">Title is required — type "none" if you don't use one.</p>}
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
            className={`w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors ${fieldError(customRole) ? 'border-accent-red' : ''}`}
          />
          {fieldError(customRole) && <p className="text-[10px] text-accent-red mt-1">Custom role is required — type a role or "none".</p>}
        </div>

        {/* Stage H: accent-color picker — macOS-style, affects only accent-blue */}
        <div>
          <label className="block text-xs text-fg-dim mb-1.5">Accent Color</label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applyAccent('auto')}
              title="Auto — follows the theme (dark / light blue)"
              className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${profile.accentColor === 'auto' ? 'border-fg-strong' : 'border-border-soft'}`}
              style={{ background: 'linear-gradient(135deg, #0D0D0E 50%, #F2F2F7 50%)' }}
            >
              <span className="block w-2.5 h-2.5 mx-auto rounded-full" style={{ background: 'var(--color-accent-blue)' }} />
            </button>
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => applyAccent(p.value)}
                title={p.label}
                className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${profile.accentColor === p.value ? 'border-fg-strong' : 'border-border-soft'}`}
                style={{ backgroundColor: p.value }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input
              type="text"
              value={hexDraft ? `#${hexDraft}` : ''}
              onChange={(e) => setHexDraft(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter' && hexValid) applyAccent(`#${hexDraft}`); }}
              placeholder="#RRGGBB — custom color"
              className="w-40 bg-surface border border-border-soft rounded-lg px-3 py-1.5 text-xs font-mono text-fg focus:outline-none focus:border-accent-blue transition-colors"
            />
            <button
              type="button"
              onClick={() => applyAccent(`#${hexDraft}`)}
              disabled={!hexValid}
              className="px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply
            </button>
            <span className="text-[10px] text-fg-dim">6 hex digits</span>
          </div>
          <p className="text-[10px] text-fg-dim mt-1.5">
            Applies everywhere accent-blue is used (active tab, buttons, selection). Semantic
            colors — teal/orange/green/red — are not affected, like macOS.
          </p>
        </div>
        <div className="flex items-start gap-3 pt-1">
          <button
            type="button"
            role="switch"
            aria-checked={sandboxRiskyCommands}
            onClick={() => setSandboxRiskyCommands(!sandboxRiskyCommands)}
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${sandboxRiskyCommands ? 'bg-accent-blue' : 'bg-panel border border-border-soft'}`}
            title={sandboxRiskyCommands ? 'Sandboxed execution is on' : 'Sandboxed execution is off'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${sandboxRiskyCommands ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Sandbox risky commands</p>
            <p className="text-[11px] text-fg-dim mt-0.5">
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
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${clipboardHistory ? 'bg-accent-blue' : 'bg-panel border border-border-soft'}`}
            title={clipboardHistory ? 'Clipboard history is on' : 'Clipboard history is off'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${clipboardHistory ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Track clipboard history</p>
            <p className="text-[11px] text-fg-dim mt-0.5">
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
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${clipboardPersist ? 'bg-accent-blue' : 'bg-panel border border-border-soft'}`}
            title={clipboardPersist ? 'Clipboard history persistence is on' : 'Clipboard history persistence is off'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${clipboardPersist ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Persist clipboard history to disk</p>
            <p className="text-[11px] text-fg-dim mt-0.5">
              A separate opt-in on top of tracking: writes the in-memory history to a local
              plaintext file so it survives restarts. Persisting clipboard content is a bigger
              privacy commitment than an in-memory buffer — off by default.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 pt-3">
          <button
            type="button"
            role="switch"
            aria-checked={scanAllFolders}
            onClick={() => setScanAllFolders(!scanAllFolders)}
            className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${scanAllFolders ? 'bg-accent-blue' : 'bg-panel border border-border-soft'}`}
            title={scanAllFolders ? 'Every folder is included as a project' : 'Only recognized projects are shown'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${scanAllFolders ? 'translate-x-4' : ''}`}
            />
          </button>
          <div>
            <p className="text-sm text-fg">Include every folder as a project</p>
            <p className="text-[11px] text-fg-dim mt-0.5">
              When on, every immediate subfolder of the scan root appears in the project list,
              even folders with no code, git, or config (they classify as General). Off by
              default — junk folders stay hidden until you opt in. Rescan to apply.
            </p>
          </div>
        </div>

        {/* Phase T2: Explorer — default view mode for the Folder Explorer panel */}
        <div className="pt-1">
          <label className="block text-xs text-fg-dim mb-1.5">Folder Explorer default view</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setExplorerViewMode('list')}
              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${explorerViewMode === 'list' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}
            >
              <List size={14} className="text-accent-blue" />
              <span className="text-sm text-fg">Lines</span>
              <span className="block text-[10px] text-fg-dim ml-auto">list rows</span>
            </button>
            <button
              type="button"
              onClick={() => setExplorerViewMode('grid')}
              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${explorerViewMode === 'grid' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}
            >
              <LayoutGrid size={14} className="text-accent-blue" />
              <span className="text-sm text-fg">Objects</span>
              <span className="block text-[10px] text-fg-dim ml-auto">icon tiles</span>
            </button>
          </div>
          <p className="text-[11px] text-fg-dim mt-1">The in-panel toggle overrides this for the current session.</p>
        </div>

        {/* Phase T2: Editors & IDEs — registry + per-extension defaults */}
        <div className="pt-2 border-t border-border-faint">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Code size={13} className="text-accent-blue" />
            <p className="text-sm text-fg">Editors &amp; IDEs</p>
          </div>
          <p className="text-[11px] text-fg-dim mb-2">
            Which editors open your files — "open main.py with PyCharm" in chat, or "open X in
            the editor" uses the per-extension default below. The command is launched with the
            file path as its argument.
          </p>
          {editors ? (
            <>
              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                {editors.editors.map((ed) => (
                  <div key={ed.id} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-[11px] text-fg-strong truncate" title={ed.name}>{ed.name}</span>
                    <input
                      type="text"
                      value={ed.command}
                      onChange={(e) => mutateEditors((s) => ({
                        ...s,
                        editors: s.editors.map((x) => x.id === ed.id ? { ...x, command: e.target.value } : x),
                      }))}
                      className="flex-1 min-w-0 bg-surface border border-border-soft rounded-lg px-2 py-1 text-[11px] font-mono text-fg focus:outline-none focus:border-accent-blue transition-colors"
                      placeholder="launch command (e.g. code)"
                    />
                    <button
                      type="button"
                      onClick={() => mutateEditors((s) => ({
                        ...s,
                        editors: s.editors.filter((x) => x.id !== ed.id),
                        defaults: Object.fromEntries(Object.entries(s.defaults).filter(([, v]) => v !== ed.id)),
                      }))}
                      className="p-1 text-fg-dim hover:text-accent-red transition-colors"
                      title={`Remove ${ed.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => mutateEditors((s) => ({
                  ...s,
                  editors: [...s.editors, { id: `custom-${Date.now().toString(36)}`, name: 'New editor', command: '' }],
                }))}
                className="mt-1.5 flex items-center gap-1 px-2 py-1 text-[11px] text-accent-blue hover:bg-accent-blue/10 rounded-lg transition-colors"
              >
                <Plus size={12} /> Add editor
              </button>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                {EXT_DEFAULT_HINTS.map(([ext, label]) => (
                  <div key={ext} className="flex items-center gap-1.5">
                    <span className="w-12 shrink-0 text-[10px] text-fg-dim font-mono">{ext}</span>
                    <select
                      value={editors.defaults[ext] || 'vscode'}
                      onChange={(e) => mutateEditors((s) => ({
                        ...s,
                        defaults: { ...s.defaults, [ext]: e.target.value },
                      }))}
                      className="flex-1 min-w-0 bg-surface border border-border-soft rounded-lg px-1.5 py-0.5 text-[11px] text-fg-muted focus:outline-none focus:border-accent-blue transition-colors"
                    >
                      {editors.editors.map((ed) => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
                      <option value="browser">Browser</option>
                    </select>
                    <span className="text-[9px] text-fg-faint">{label}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={handleSaveEditors}
                  disabled={!editorsDirty}
                  className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors disabled:opacity-40"
                >
                  <Save size={11} /> Save editors
                </button>
                {editorsSaved && <span className="text-[10px] text-accent-green">Saved — affects the next "open with"</span>}
              </div>
            </>
          ) : (
            <p className="text-[11px] text-fg-dim italic">Loading editors…</p>
          )}
        </div>

        {/* Phase T2: Tours — replay any section */}
        <div className="pt-2 border-t border-border-faint">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Compass size={13} className="text-accent-teal" />
            <p className="text-sm text-fg">Tours</p>
          </div>
          <p className="text-[11px] text-fg-dim mb-2">Replay any guided walkthrough, any time.</p>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              ['welcome', 'Welcome'],
              ['general', 'General mode'],
              ['tools', 'Tools panels'],
              ['developer', 'Developer mode'],
              ['chat-ai', 'Chat & AI'],
              ['tabs', 'Tabs & Folders'],
              ['settings', 'Settings'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => launchTour(id)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-soft text-[11px] text-fg-subtle hover:border-accent-teal/50 hover:text-fg-strong transition-colors"
              >
                <Compass size={11} className="text-accent-teal" />
                {label}
                {toursTaken[id] && <span className="ml-auto text-[9px] text-accent-green">done</span>}
              </button>
            ))}
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
          className="px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}
