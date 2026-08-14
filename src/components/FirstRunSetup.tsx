import React, { useState } from 'react';
import { ModalShell } from './ui/ModalShell';
import { UserProfile } from '../hooks/useUserProfile';
import { Sparkles, FolderSearch, ArrowRight } from 'lucide-react';

interface FirstRunSetupProps {
  open: boolean;
  scanPath: string;
  setScanPath: (v: string) => void;
  handleScan: (e: React.FormEvent<HTMLFormElement>) => void;
  onFinish: (updates: Partial<UserProfile>) => void;
}

/**
 * One-time setup wizard shown when `userProfile.setupComplete` is false — which is true for
 * every fresh install, since `data/user-profile.json` isn't published with the npm package
 * (see package.json's "files" list) and only exists once someone saves a profile. Before this
 * existed, a new user's very first paint greeted them by the original author's name ("Tobi")
 * with no prompt to make it their own (audit 2026-08-10, raised while generalizing the package
 * for public distribution).
 *
 * Deliberately non-blocking: every field is optional and "Skip for now" is always available —
 * this collects a name/scan-directory if the user wants to give them, it never gates access to
 * the app. Reuses the exact same `/api/scan-path` form-submit handler the sidebar's scan box
 * uses (`handleScan`) rather than re-implementing scan logic here.
 */
export function FirstRunSetup({ open, scanPath, setScanPath, handleScan, onFinish }: FirstRunSetupProps) {
  const [name, setName] = useState('');
  const [workspaceType, setWorkspaceType] = useState<'dev' | 'general'>('dev');

  const handleContinue = (e: React.FormEvent<HTMLFormElement>) => {
    // Only actually rescan if the user changed the pre-filled path — the default scan
    // directory has usually already been scanned once by the time this wizard renders.
    handleScan(e);
    onFinish({ name: name.trim(), setupComplete: true, defaultWorkspaceType: workspaceType });
  };

  const handleSkip = () => {
    onFinish({ setupComplete: true, defaultWorkspaceType: workspaceType });
  };

  return (
    <ModalShell open={open} onClose={handleSkip} maxWidth="max-w-lg">
      <form onSubmit={handleContinue}>
        <div className="flex items-center gap-3 px-6 pt-6 pb-2">
          <div className="p-2 bg-accent-teal/10 rounded-lg text-accent-teal">
            <Sparkles size={22} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-fg-strong">Welcome to Project Console</h2>
            <p className="text-xs text-fg-dim">A couple of quick things, then you're in.</p>
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs text-fg-dim mb-1.5">What should we call you? (optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="Your name"
              className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors"
            />
            <p className="text-[11px] text-fg-dim mt-1">Used for greetings only — change it anytime from the profile settings.</p>
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs text-fg-dim mb-1.5">
              <FolderSearch size={13} /> Where are your projects?
            </label>
            <input
              type="text"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              placeholder="C:\Users\you\Desktop\Projects"
              className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg font-mono focus:outline-none focus:border-accent-blue transition-colors"
            />
            <p className="text-[11px] text-fg-dim mt-1">The folder containing your project folders — you can rescan a different one anytime from the sidebar.</p>
          </div>

          <div>
            <label className="block text-xs text-fg-dim mb-1.5">What's the default workspace type? (optional)</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setWorkspaceType('dev')}
                className={`flex-1 px-3 py-2 rounded-lg border text-left transition-colors ${workspaceType === 'dev' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}
              >
                <span className="block text-sm text-fg">Developer</span>
                <span className="block text-[10px] text-fg-dim mt-0.5">git, npm, run commands, diagnostics</span>
              </button>
              <button
                type="button"
                onClick={() => setWorkspaceType('general')}
                className={`flex-1 px-3 py-2 rounded-lg border text-left transition-colors ${workspaceType === 'general' ? 'border-accent-blue bg-accent-blue/10' : 'border-border-soft bg-surface hover:border-border-strong'}`}
              >
                <span className="block text-sm text-fg">General</span>
                <span className="block text-[10px] text-fg-dim mt-0.5">files, notes, reminders, PDF tools — a tools-first landing</span>
              </button>
            </div>
            <p className="text-[11px] text-fg-dim mt-1">Used as the default when a project isn't auto-classified — switch any project anytime from the header tabs.</p>
          </div>

          <div className="rounded-lg bg-scrim-faint border border-border-soft px-3 py-2">
            <p className="text-[11px] text-fg-muted">
              <span className="text-fg-strong font-semibold">About AI mode:</span> everything here works
              without AI. If you later want natural-language AI answers, install{' '}
              <a href="https://ollama.com" target="_blank" rel="noreferrer" className="text-accent-blue underline">Ollama</a>{' '}
              (a free local app) — then flip the AI toggle in the chat header. Nothing else is required.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 pb-6 pt-2">
          <button type="button" onClick={handleSkip} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
            Skip for now
          </button>
          <button
            type="submit"
            className="flex items-center gap-1.5 px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity"
          >
            Get Started <ArrowRight size={14} />
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
