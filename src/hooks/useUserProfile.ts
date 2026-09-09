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
  // Phase 5.2: persistRemindersAcrossRestart — when true (default), reminders survive app
  // restarts. When false, all reminders are cleared on shutdown.
  persistRemindersAcrossRestart: boolean;
  // Phase 3.2: reminderToastDurationMs — how long reminder toasts display (2000-30000).
  reminderToastDurationMs: number;
  // Phase 3.2: reminderToastPosition — where toasts appear on screen.
  reminderToastPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  // Phase 2.2: askBeforeDeleteLinkedNote — when true, deleting a note with a linked
  // reminder asks the user whether to delete the reminder too.
  askBeforeDeleteLinkedNote: boolean;
  // Phase 4.2: aiRedirectDelayMs — pause before auto-opening a panel/tab after an AI
  // trigger command (0 = instant, default 2000ms).
  aiRedirectDelayMs: number;
  // F-3 (2026-09-09): General-tools-first landing — General opens the Tools grid once a
  // project is active. Default true (long-standing behavior); off lands on chat instead.
  generalToolsFirst: boolean;
  // B.3 (2026-09-09): default AI model name — the picker's last explicit choice, reselected
  // on boot when still installed. Empty means "auto" (cloud-first, else first local).
  defaultAiModel: string;
  // E-4 (2026-09-09): quiet hours — local hour pushing stops/starts (desktop + webhook
  // held; history + in-app toasts continue). Null = off; overnight wraps; equal = off.
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
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
  persistRemindersAcrossRestart: true,
  reminderToastDurationMs: 8000,
  reminderToastPosition: 'bottom-right',
  askBeforeDeleteLinkedNote: true,
  aiRedirectDelayMs: 2000,
  generalToolsFirst: true,
  defaultAiModel: '',
  quietHoursStart: null,
  quietHoursEnd: null,
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
        if (data?.userProfile) {
          setProfile(data.userProfile);
          syncProfilePrefs(data.userProfile);
        }
      })
      .catch(() => console.warn('Using default local profile state'))
      .finally(() => setLoaded(true));
  }, []);

  const updateProfile = useCallback(async (updates: Partial<UserProfile>): Promise<boolean> => {
    const updated = { ...profile, ...updates };
    setProfile(updated);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userProfile: updated }),
      });
      if (!res.ok) {
        // A non-2xx save must be reported, not swallowed — the first-run wizard shows an
        // inline error instead of closing optimistically (2026-08-26).
        console.error('Profile save rejected:', res.status);
        setProfile(profile); // revert the optimistic update so gated UI (first-run wizard) stays open
        return false;
      }
      const data = await res.json();
      // Reflect the server's sanitized/merged value back (it may fall back on invalid input).
      if (data?.userProfile) {
        setProfile(data.userProfile);
        syncProfilePrefs(data.userProfile);
      }
      return true;
    } catch (err) {
      console.error('Failed to persist profile to server:', err);
      setProfile(profile); // revert the optimistic update
      return false;
    }
  }, [profile]);

  const getFormattedName = useCallback((): string => formatUserName(profile), [profile]);

  return { profile, updateProfile, getFormattedName, loaded };
}

/**
 * Mirror the display/timing prefs that module-level (non-React) call sites need into
 * localStorage['console.profile'] — the toast store's reminderToastDuration/
 * reminderToastPosition helpers and wsMessageCases' aiRedirectDelay reader all read this
 * key. Only called with server-confirmed values (initial load + successful saves), never
 * the optimistic pre-save state, so readers never see a value the server rejected.
 */
function syncProfilePrefs(p: Pick<UserProfile, 'aiRedirectDelayMs' | 'reminderToastDurationMs' | 'reminderToastPosition' | 'defaultAiModel'>): void {
  try {
    localStorage.setItem(PROFILE_MIRROR_KEY, JSON.stringify({
      aiRedirectDelayMs: p.aiRedirectDelayMs,
      reminderToastDurationMs: p.reminderToastDurationMs,
      reminderToastPosition: p.reminderToastPosition,
      defaultAiModel: p.defaultAiModel,
    }));
  } catch {
    // Private-mode quota etc. — readers fall back to defaults, so never throw here.
  }
}

/** localStorage key for the server-confirmed profile mirror (see syncProfilePrefs). */
export const PROFILE_MIRROR_KEY = 'console.profile';

/** Read the mirrored prefs (or {} when absent/unparseable — every reader has defaults). */
export function readSyncedProfile(): {
  aiRedirectDelayMs?: unknown;
  reminderToastDurationMs?: unknown;
  reminderToastPosition?: unknown;
  defaultAiModel?: unknown;
} {
  try {
    const raw = localStorage.getItem(PROFILE_MIRROR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
