import React, { useRef, useState } from 'react';
import { ModalShell } from './ui/ModalShell';
import { UserProfile } from '../hooks/useUserProfile';
import { Sparkles, FolderSearch, ArrowRight, ChevronDown, TerminalSquare } from 'lucide-react';

interface FirstRunSetupProps {
  open: boolean;
  scanPath: string;
  setScanPath: (v: string) => void;
  handleScan: (e: React.FormEvent<HTMLFormElement>) => void;
  onFinish: (updates: Partial<UserProfile>) => Promise<boolean> | boolean;
  /** Portal (2026-09-10): whether accounts already exist. The user-portal choice only
    makes sense on a fresh (disarmed) server — hide it when armed. */
  accountsArmed?: boolean;
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
export function FirstRunSetup({ open, scanPath, setScanPath, handleScan, onFinish, accountsArmed = false }: FirstRunSetupProps) {
  const [name, setName] = useState('');
  const [workspaceType, setWorkspaceType] = useState<'dev' | 'general'>('dev');
  const [showDev, setShowDev] = useState(false);
  // Portal choice (2026-09-10): "use the site normally" (default, today's open
  // behavior) vs "set up user accounts" (creates the first admin inline, arming login
  // for this install). Only offered while disarmed — once accounts exist the choice
  // is moot and the toggle hides entirely.
  const [wantPortal, setWantPortal] = useState(false);
  const [portalUser, setPortalUser] = useState('');
  const [portalPass, setPortalPass] = useState('');
  const [portalCreated, setPortalCreated] = useState<{ username: string; code: string } | null>(null);
  const [portalAck, setPortalAck] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  // A failed profile save must be VISIBLE — an optimistic close with a console-only error left
  // users thinking their settings saved (the wizard just reappeared on the next load instead;
  // 2026-08-26). Inline error + retry keeps the wizard open until the save actually lands.
  const [saveError, setSaveError] = useState<string | null>(null);
  // The pre-filled path as it was when the wizard mounted — a user who leaves it untouched
  // shouldn't pay for a pointless ~2s rescan (and an empty path previously dumped a "No path
  // given." error into a chat that may not even exist yet; audit 2026-08-17).
  const initialPathRef = useRef(scanPath);

  const createPortalAdmin = async () => {
    if (!portalUser.trim() || !portalPass || portalBusy) return;
    setPortalBusy(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: portalUser.trim(), password: portalPass }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        // Keep the password in state (never storage) for the one-tap login below.
        setPortalCreated({ username: data.user.username, code: data.recoveryCode });
      } else {
        setSaveError(data?.error || 'Account creation failed.');
      }
    } catch {
      setSaveError('Could not reach the server.');
    } finally {
      setPortalBusy(false);
    }
  };

  const handleContinue = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaveError(null);
    // Portal gate: choosing accounts means finishing WITH an admin — continuing without
    // one would arm nothing and silently drop the choice. Skipping bypasses the portal
    // entirely (documented under the toggle).
    if (wantPortal && !accountsArmed) {
      if (!portalCreated) {
        setSaveError('Create the admin account above first — or turn user accounts off to use the site normally.');
        return;
      }
      if (!portalAck) {
        setSaveError('Save your recovery code first — it is shown once, and it is the only way back in if you forget the password.');
        return;
      }
    }
    const pathChanged = scanPath.trim() && scanPath.trim() !== (initialPathRef.current || '').trim();
    if (pathChanged) handleScan(e);
    const ok = await onFinish({ name: name.trim(), setupComplete: true, defaultWorkspaceType: workspaceType });
    if (ok === false) {
      setSaveError("Couldn't save your settings — the server didn't accept them. Check that the console is running, then try again.");
      return;
    }
    // Portal landing: log the fresh admin straight in (in-memory password, one tap, no
    // retype) and reload into the armed app — post-auth state is only built at boot.
    if (wantPortal && portalCreated && !accountsArmed) {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: portalCreated.username, password: portalPass }),
        });
        if (res.ok) {
          window.location.reload();
          return;
        }
        setSaveError('Account created — please log in with it on the next screen.');
      } catch {
        setSaveError('Account created — please log in with it on the next screen.');
      }
    }
  };

  const handleSkip = async () => {
    setSaveError(null);
    const ok = await onFinish({ setupComplete: true, defaultWorkspaceType: workspaceType });
    if (ok === false) {
      setSaveError("Couldn't save your settings — the server didn't accept them. Check that the console is running, then try again.");
    }
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

          {!accountsArmed && (
            <div className="rounded-lg border border-border-soft px-3 py-2.5">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wantPortal}
                  onChange={(e) => setWantPortal(e.target.checked)}
                  className="mt-0.5 accent-accent-blue"
                />
                <span>
                  <span className="block text-sm text-fg">Set up user accounts (login)</span>
                  <span className="block text-[11px] text-fg-dim mt-0.5">
                    Off (default) = use the site normally, open to anyone on this machine. On = create
                    the first admin now; the console will require login afterwards, with per-user
                    chats and profiles. Skipping the wizard skips this too.
                  </span>
                </span>
              </label>
              {wantPortal && (
                <div className="mt-2.5 space-y-2">
                  {portalCreated ? (
                    <div className="rounded-lg bg-accent-orange/10 border border-accent-orange/30 px-3 py-2.5 space-y-2">
                      <p className="text-xs text-fg-strong">
                        Admin <span className="font-mono">@{portalCreated.username}</span> created. Save
                        this recovery code — shown <span className="font-bold">once</span>:
                      </p>
                      <p className="font-mono text-sm text-accent-orange font-bold tracking-wider">{portalCreated.code}</p>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={portalAck}
                          onChange={(e) => setPortalAck(e.target.checked)}
                          className="mt-0.5 accent-accent-blue"
                        />
                        <span className="text-[11px] text-fg-dim">I saved the recovery code</span>
                      </label>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={portalUser}
                        onChange={(e) => setPortalUser(e.target.value)}
                        placeholder="Admin username"
                        autoComplete="username"
                        className="flex-1 bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors"
                      />
                      <input
                        type="password"
                        value={portalPass}
                        onChange={(e) => setPortalPass(e.target.value)}
                        placeholder="Password (8+)"
                        autoComplete="new-password"
                        className="flex-1 bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors"
                      />
                      <button
                        type="button"
                        disabled={portalBusy || !portalUser.trim() || !portalPass}
                        onClick={createPortalAdmin}
                        className="shrink-0 px-3 py-2 rounded-lg text-xs font-bold bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {portalBusy ? '…' : 'Create'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg bg-scrim-faint border border-border-soft px-3 py-2">
            <p className="text-[11px] text-fg-muted">
              <span className="text-fg-strong font-semibold">About AI mode:</span> everything here works
              without AI. If you later want natural-language AI answers, install{' '}
              <a href="https://ollama.com" target="_blank" rel="noreferrer" className="text-accent-blue underline">Ollama</a>{' '}
              (a free local app) — then flip the AI toggle in the chat header. Nothing else is required.
            </p>
          </div>

          <div className="rounded-lg border border-border-soft">
            <button
              type="button"
              onClick={() => setShowDev((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-[11px] text-fg-subtle hover:text-fg-strong transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <TerminalSquare size={12} /> For developers: publishing & installing this app
              </span>
              <ChevronDown size={12} className={`transition-transform ${showDev ? 'rotate-180' : ''}`} />
            </button>
            {showDev && (
              <div className="px-3 pb-3 pt-1 space-y-2 text-[11px] text-fg-muted leading-relaxed">
                <p><span className="text-fg-strong font-semibold">Publish to npm</span> — others install with <code className="text-fg-strong font-mono">npm install -g local-project-console</code> (or run once via <code className="text-fg-strong font-mono">npx local-project-console</code>):</p>
                <pre className="bg-scrim border border-border-soft rounded-md px-3 py-2 font-mono text-[10px] text-fg-strong overflow-x-auto">npm login
npm version patch          # or minor / major
npm run build              # refresh dist/ before publishing
npm publish</pre>
                <p><span className="text-fg-strong font-semibold">Desktop installer</span> (no command line for the end user — NSIS .exe / .dmg / .AppImage):</p>
                <pre className="bg-scrim border border-border-soft rounded-md px-3 py-2 font-mono text-[10px] text-fg-strong overflow-x-auto">cd desktop
npm install
npm run dist</pre>
                <p><span className="text-fg-strong font-semibold">Common install errors:</span></p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><code className="font-mono">gyp ERR! Could not find any Visual Studio</code> — a native module (re2/embeddings) needs the VS "Desktop development with C++" workload. Those deps are <span className="text-fg-strong">optional</span>, so the install can succeed without them; matching falls back to fuzzy/NLP.</li>
                  <li><code className="font-mono">sharp: Request timed out</code> — just retry <code className="font-mono">npm install</code>; it only affects semantic search.</li>
                  <li><code className="font-mono">EPERM: operation not permitted, rmdir</code> — a locked folder (running process / antivirus / OneDrive). Close it, delete the partial <code className="font-mono">AppData\Roaming\npm\node_modules\local-project-console</code>, retry from an elevated terminal.</li>
                  <li>Never use <code className="font-mono">--ignore-scripts</code> to get past a build error — it silently breaks code search.</li>
                </ul>
                <p className="text-fg-dim">Full walkthrough is in the README "Publishing &amp; installing on another machine" section; chat "how do i publish this" answers it too.</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-6 pb-6 pt-2">
          <button type="button" onClick={handleSkip} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
            Skip for now
          </button>
          <button
            type="submit"
            className="flex items-center gap-1.5 px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity glass glass-btn"
          >
            Get Started <ArrowRight size={14} />
          </button>
        </div>
        {saveError && (
          <div className="px-6 pb-6">
            <p className="rounded-lg bg-accent-red/10 border border-accent-red/30 px-3 py-2 text-xs text-accent-red">
              {saveError}
            </p>
          </div>
        )}
      </form>
    </ModalShell>
  );
}
