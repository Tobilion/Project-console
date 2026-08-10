import React, { useState, useEffect } from 'react';
import { UserProfile } from '../hooks/useUserProfile';
import { Settings, X } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';

interface UserProfileModalProps {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSave: (updates: Partial<UserProfile>) => void;
}

/** Gear-triggered profile editor: name / title / custom role, persisted via POST
 *  /api/profile. Same overlay pattern as the welcome tour (fixed backdrop + centered
 *  panel); Esc and backdrop-click close without saving. */
export function UserProfileModal({ open, profile, onClose, onSave }: UserProfileModalProps) {
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title);
  const [customRole, setCustomRole] = useState(profile.customRole);
  const [sandboxRiskyCommands, setSandboxRiskyCommands] = useState(profile.sandboxRiskyCommands);

  // Re-sync the draft whenever the modal opens or the profile changes externally.
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setTitle(profile.title);
      setCustomRole(profile.customRole);
      setSandboxRiskyCommands(profile.sandboxRiskyCommands);
    }
  }, [open, profile]);

  // Esc-to-close now lives in ModalShell.

  const canSave = name.trim() && title.trim() && customRole.trim();

  const handleSave = () => {
    onSave({ name: name.trim(), title: title.trim(), customRole: customRole.trim(), sandboxRiskyCommands });
    onClose();
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
      </div>

      <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-2">
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
