import fs from 'fs';
import path from 'path';
import { syncClipboardPolling } from '../clipboardHistory.js';

// App-global user profile (identity used in greetings), NOT per-project config.
// Lives in data/ — the app's own runtime-state home — so writes never trigger the
// per-project console.config.json file watcher or Vite's watch (data/ is excluded
// from both in server/index.js).
const PROFILE_FILE = path.resolve('data/user-profile.json');

// Neutral defaults for a fresh install — `data/user-profile.json` isn't published with the npm
// package (see package.json's "files" list) and is only ever created once a user sets their own
// profile via the UI, but until they do, every brand-new install used to greet every stranger as
// "Tobi" (the original author) — clearly wrong for a tool meant for public distribution (audit
// 2026-08-10, raised while generalizing for npm). An empty string (not a hardcoded name) lets
// every caller's existing "name || 'there'"-style fallback (see src/utils/greetings.ts,
// cli-client.js's renderMascot) do the right thing with zero further changes, and matches the
// frontend's `UserProfile.name: string` type so client/server defaults stay in sync.
const DEFAULT_PROFILE = {
  name: '',
  title: '',
  customRole: '',
  // Drives the first-run setup wizard (src/components/FirstRunSetup.tsx): false until the user
  // completes (or explicitly skips) it once, then stays true forever so it never nags again.
  // Distinct from `name` being empty — a user can skip setup and keep no name set, and that
  // must not re-trigger the wizard on every reload.
  setupComplete: false,
  // Phase 3 (2026-08-10): opt-in restricted context for confirmed risky commands (see
  // executorSandbox.js). Default false by spec — never silently enabled; toggling this ON is
  // an explicit user decision in the profile modal.
  sandboxRiskyCommands: false,
  // Phase 8 (2026-08-12): opt-in OS clipboard READ polling (clipboardHistory.js). Default
  // false — an always-on clipboard reader is a real privacy surface (passwords, tokens,
  // personal data routinely pass through a clipboard), so it must never be silently on.
  clipboardHistory: false,
  // Phase 8: a SECOND, separate opt-in — persisting clipboard history to disk is a materially
  // bigger privacy commitment than an in-memory buffer that clears on restart.
  clipboardPersist: false,
  // Phase 13 (2026-08-12): the workspace-type default chosen in the first-run wizard —
  // 'dev' or 'general'. The App falls back to this when a project has no per-project tab
  // preference and the server's heuristic hasn't classified it yet.
  defaultWorkspaceType: 'dev',
  // Phase 14 (2026-08-12): phrase-matching locale ('en' default; 'de' is the POC). Locale
  // phrases ADD to English — never a replacement. Answer text/UI strings are NOT translated
  // (scope boundary, see localeIntents.js).
  locale: 'en',
};

// Only plain, trimmed strings up to a sane length — mirrors the conservative
// validation elsewhere in this app, since the profile gets interpolated into UI strings.
function sanitizeField(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > 120) return fallback;
  return cleaned;
}

function sanitizeBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function readProfile() {
  try {
    const raw = fs.readFileSync(PROFILE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const p = parsed?.userProfile || parsed || {};
    return {
      name: sanitizeField(p.name, DEFAULT_PROFILE.name),
      title: sanitizeField(p.title, DEFAULT_PROFILE.title),
      customRole: sanitizeField(p.customRole, DEFAULT_PROFILE.customRole),
      setupComplete: sanitizeBool(p.setupComplete, DEFAULT_PROFILE.setupComplete),
      sandboxRiskyCommands: sanitizeBool(p.sandboxRiskyCommands, DEFAULT_PROFILE.sandboxRiskyCommands),
      clipboardHistory: sanitizeBool(p.clipboardHistory, DEFAULT_PROFILE.clipboardHistory),
      clipboardPersist: sanitizeBool(p.clipboardPersist, DEFAULT_PROFILE.clipboardPersist),
      defaultWorkspaceType: p.defaultWorkspaceType === 'general' ? 'general' : 'dev',
      locale: typeof p.locale === 'string' && p.locale.length <= 8 ? p.locale : 'en',
    };
  } catch {
    // Missing or corrupt file — serve defaults without touching disk.
    return { ...DEFAULT_PROFILE };
  }
}

// Exported for the executor's per-command check (executor.js only consults it when a caller
// flags the command as risk-gated, so the profile file is not read on every normal run).
export { readProfile };

// Single write path for the profile — used by the POST route AND the Phase 6 workspace
// import, so the import overwrites the file exactly the way a UI save would.
export function writeProfile(profile) {
  try {
    fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify({ userProfile: profile }, null, 2), 'utf-8');
    return null;
  } catch (err) {
    return err;
  }
}

export function registerProfileRoutes(app) {
  app.get('/api/profile', (req, res) => {
    res.json({ userProfile: readProfile() });
  });

  app.post('/api/profile', (req, res) => {
    const body = req.body?.userProfile || req.body || {};
    const current = readProfile();
    const updated = {
      name: sanitizeField(body.name, current.name),
      title: sanitizeField(body.title, current.title),
      customRole: sanitizeField(body.customRole, current.customRole),
      setupComplete: sanitizeBool(body.setupComplete, current.setupComplete),
      sandboxRiskyCommands: sanitizeBool(body.sandboxRiskyCommands, current.sandboxRiskyCommands),
      clipboardHistory: sanitizeBool(body.clipboardHistory, current.clipboardHistory),
      clipboardPersist: sanitizeBool(body.clipboardPersist, current.clipboardPersist),
      defaultWorkspaceType: body.defaultWorkspaceType === 'general' ? 'general' : 'dev',
      locale: typeof body.locale === 'string' && body.locale.length <= 8 ? body.locale : 'en',
    };
    const err = writeProfile(updated);
    if (err) {
      res.status(500).json({ error: `Failed to save profile: ${err.message}` });
      return;
    }
    // Phase 8: clipboard polling state follows the setting live (off -> on starts the
    // background poll without a restart; on -> off stops it).
    syncClipboardPolling();
    res.json({ userProfile: updated });
  });
}
