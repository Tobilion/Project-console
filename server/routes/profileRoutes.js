import fs from 'fs';
import path from 'path';

// App-global user profile (identity used in greetings), NOT per-project config.
// Lives in data/ — the app's own runtime-state home — so writes never trigger the
// per-project console.config.json file watcher or Vite's watch (data/ is excluded
// from both in server/index.js).
const PROFILE_FILE = path.resolve('data/user-profile.json');

const DEFAULT_PROFILE = {
  name: 'Tobi',
  title: 'Master',
  customRole: 'Software Engineer',
};

// Only plain, trimmed strings up to a sane length — mirrors the conservative
// validation elsewhere in this app, since the profile gets interpolated into UI strings.
function sanitizeField(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > 120) return fallback;
  return cleaned;
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
