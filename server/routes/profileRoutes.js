import fs from 'fs';
import path from 'path';

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
    };
  } catch {
    // Missing or corrupt file — serve defaults without touching disk.
    return { ...DEFAULT_PROFILE };
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
    };
    try {
      fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
      fs.writeFileSync(PROFILE_FILE, JSON.stringify({ userProfile: updated }, null, 2), 'utf-8');
      res.json({ userProfile: updated });
    } catch (err) {
      res.status(500).json({ error: `Failed to save profile: ${err.message}` });
    }
  });
}
