import React, { useState, useEffect } from 'react';
import { UserProfile } from '../hooks/useUserProfile';
import { Settings, X, LayoutGrid, List, Compass } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { EditorsSection } from './profile/EditorsSection';
import { TuningSection } from './profile/TuningSection';

interface UserProfileModalProps {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSave: (updates: Partial<UserProfile>) => void;
}

/** Gear-triggered profile editor: name / title / custom role + tuning knobs, persisted via
 *  POST /api/profile and /api/tuning. Same overlay pattern as the welcome tour (fixed backdrop
 *  + centered panel); Esc and backdrop-click close without saving.
 *
 *  2026-08-24 split: the Editors & IDEs registry and the runtime tuning editor are
 *  self-contained sections (profile/EditorsSection.tsx + profile/TuningSection.tsx) that
 *  fetch their own state on mount — keyed remounts re-fetch, same as the old open-effect. */
export function UserProfileModal({ open, profile, onClose, onSave }: UserProfileModalProps) {
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title);
  const [customRole, setCustomRole] = useState(profile.customRole);
  const [sandboxRiskyCommands, setSandboxRiskyCommands] = useState(profile.sandboxRiskyCommands);
  const [clipboardHistory, setClipboardHistory] = useState(profile.clipboardHistory);
  const [clipboardPersist, setClipboardPersist] = useState(profile.clipboardPersist);
  const [scanAllFolders, setScanAllFolders] = useState(profile.scanAllFolders);
  const [explorerViewMode, setExplorerViewMode] = useState<'list' | 'grid'>(profile.explorerViewMode);
  const [permissionMode, setPermissionMode] = useState<'default' | 'ask'>(profile.permissionMode === 'ask' ? 'ask' : 'default');
  // Phase T2: tours are defined in src/tours.ts; this section just records completion
  // badges (localStorage, same inline style as pinned projects) and launches a tour via a
  // custom event the App listens for.
  const [tourSection, setTourSection] = useState<string | null>(null);

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
      setPermissionMode(profile.permissionMode === 'ask' ? 'ask' : 'default');
    }
  }, [open, profile]);

  const canSave = name.trim() && title.trim() && customRole.trim();
  // Audit 2026-08-17: the old disabled-Save gate gave zero feedback — a user with an empty
  // field got a button that did nothing. Save is always clickable now; on click the modal
  // shows inline per-field errors and stays open until all three are valid (still
  // all-or-nothing: nothing persists unless every field passes).
  const [showErrors, setShowErrors] = useState(false);

  const handleSave = () => {
    if (!canSave) {
      setShowErrors(true);
      return;
    }
    onSave({ name: name.trim(), title: title.trim(), customRole: customRole.trim(), sandboxRiskyCommands, clipboardHistory, clipboardPersist, scanAllFolders, explorerViewMode, permissionMode });
    onClose();
  };

  const fieldError = (value: string) => showErrors && !value.trim();

  const launchTour = (id: string) => {
    // The App listens for this and opens TourOverlay for the section (see App.tsx).
    window.dispatchEvent(new CustomEvent('lpc:launch-tour', { detail: { section: id } }));
    setTourSection(id);
  };

  // Tour completion badges — shared localStorage key with TourOverlay.
  const toursTaken = (() => {
    try { return JSON.parse(localStorage.getItem('console.toursTaken') || '{}'); } catch { return {}; }
  })();

  return (
    <ModalShell open={open} onClose={onClose} maxWidth="max-w-md">
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent-blue/10 rounded-lg text-accent-blue">
            <Settings size={18} />
          </div>
          <h2 className="text-xl font-bold text-fg-strong">User Profile</h2>
        </div>
        <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors" aria-label="Close user profile">
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

        {/* Round-6 audit (2026-08-24): permission mode — 'ask' makes the AI/direct tool paths
            strictly read-only. Only ever strengthens; the confirm gate itself is untouched. */}
        <div className="pt-1">
          <label className="block text-xs text-fg-dim mb-1.5">Permission mode</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPermissionMode('default')}
              className={`flex-1 px-3 py-2 rounded-lg border text-left transition-colors ${permissionMode === 'default' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}
            >
              <span className="block text-sm text-fg">Default</span>
              <span className="block text-[10px] text-fg-dim mt-0.5">Normal approvals — session grants and per-project policies apply</span>
            </button>
            <button
              type="button"
              onClick={() => setPermissionMode('ask')}
              className={`flex-1 px-3 py-2 rounded-lg border text-left transition-colors ${permissionMode === 'ask' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}
            >
              <span className="block text-sm text-fg">Ask (read-only)</span>
              <span className="block text-[10px] text-fg-dim mt-0.5">AI can look, never touch — mutating tools answer "blocked" instead of prompting</span>
            </button>
          </div>
          <p className="text-[10px] text-fg-dim mt-1.5">
            In Ask mode, writeFile/editFile/executeCommand/runTests and every other mutating tool
            are declined with an explanation — no confirm prompts, no checkpoints, no auto-runs.
            Commands you type yourself still confirm as usual. Off by default.
          </p>
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

        {/* Phase T2: Editors & IDEs — registry + per-extension defaults (self-contained). */}
        <EditorsSection />

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

        {/* Phase 8: runtime tuning-constant editor (self-contained). */}
        <TuningSection />
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