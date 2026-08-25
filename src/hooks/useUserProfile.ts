import { useState, useEffect, useCallback } from 'react';
import { formatUserName } from '../utils/formatUserName';

export interface UserProfile {
  name: string;
  title: string;
  customRole: string;
  // True once the first-run setup wizard (FirstRunSetup.tsx) has been completed or skipped —
  // distinct from `name` being empty, since a user can skip setup and keep no name set without
  // the wizard reappearing on every reload.
  setupComplete: boolean;
  // Phase 3 (2026-08-10): opt-in restricted context for confirmed risky commands (server:
  // executorSandbox.js). Default false; toggled from the UserProfileModal.
  sandboxRiskyCommands: boolean;
  // Phase 8 (2026-08-12): opt-in OS clipboard history polling + separate opt-in to persist
  // history to disk. Defaults false — both are explicit privacy decisions.
  clipboardHistory: boolean;
  clipboardPersist: boolean;
  // Phase 13 (2026-08-12): workspace-type default chosen in the first-run wizard.
  defaultWorkspaceType: 'dev' | 'general';
  // Phase 14 (2026-08-12): phrase-matching locale ('en' default; 'de' is the POC).
  locale: string;
  // Stage H (2026-08-12): accent-color override for --color-accent-blue. 'auto' follows
  // the theme's per-theme blue; a #RRGGBB hex overrides it in both themes.
  accentColor: string;
  // Phase T (2026-08-14): include every immediate subfolder of the scan root as a project,
  // even folders with no dev-code signals (they classify 'general'). Off by default.
  scanAllFolders: boolean;
  // Phase T2 (2026-08-14): Folder Explorer default view — 'list' (lines) or 'grid' (objects).
  explorerViewMode: 'list' | 'grid';
  // Round-6 audit (2026-08-24): permission mode — 'default' or 'ask' (read-only AI tool
  // paths; mutating tools are blocked with an explanation instead of prompting/approving).
  permissionMode: 'default' | 'ask';
}

// Neutral defaults, not a hardcoded person's name/title — matches server/routes/profileRoutes.js's
// DEFAULT_PROFILE (audit 2026-08-10, raised while generalizing the package for npm/public
// distribution: a fresh install used to hardcode the original author's own name into the hero
// greeting for every stranger's first paint, before the async profile fetch even resolved). An
// empty name string flows through getRandomGreeting()'s existing `name || 'there'` fallback
// (src/utils/greetings.ts) with no further changes needed.
const DEFAULT_PROFILE: UserProfile = {
  name: '',
  title: '',
  customRole: '',
  setupComplete: false,
  sandboxRiskyCommands: false,
  clipboardHistory: false,
  clipboardPersist: false,
  defaultWorkspaceType: 'dev',
  locale: 'en',
  accentColor: 'auto',
  scanAllFolders: false,
  explorerViewMode: 'list',
  permissionMode: 'default',
};

/** Client state for the user profile persisted to the server (GET/POST /api/profile).
 *  Starts from the same neutral defaults the server uses; the real profile (if the user has
 *  set one) loads asynchronously right after and replaces this. */
export function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then((data) => {
        if (data?.userProfile) setProfile(data.userProfile);
      })
      .catch(() => console.warn('Using default local profile state'))
      .finally(() => setLoaded(true));
  }, []);

  const updateProfile = useCallback(async (updates: Partial<UserProfile>) => {
    const updated = { ...profile, ...updates };
    setProfile(updated);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userProfile: updated }),
      });
      const data = await res.json();
      // Reflect the server's sanitized/merged value back (it may fall back on invalid input).
      if (data?.userProfile) setProfile(data.userProfile);
    } catch (err) {
      console.error('Failed to persist profile to server:', err);
    }
  }, [profile]);

  const getFormattedName = useCallback((): string => formatUserName(profile), [profile]);

  return { profile, updateProfile, getFormattedName, loaded };
}
