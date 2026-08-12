// Phase 14 (UPGRADE-ROADMAP.md, 2026-08-12): i18n scaffolding for intent phrases — ONE fully
// translated POC locale (German) covering a small high-value subset: greeting/farewell/help/
// status (chitChatIntents.js) + calculate. Infrastructure only: this phase does NOT translate
// answer text or UI strings — phrase matching only (explicit scope boundary, documented in
// CLAUDE.md). Locale phrases ADD to English (a mixed-language user must not lose English
// commands by picking a locale) — they are appended to each intent's example list, never a
// replacement. The locale is read from the user profile (data/user-profile.json `locale`,
// default 'en'); the matcher is global by design, so the locale is a global setting, not
// per-project.
import fs from 'fs';
import path from 'path';

export const LOCALE_PHRASES = {
  de: {
    'system.chit_chat.greeting': [
      'hallo', 'hallo console', 'guten tag', 'moin', 'servus', 'hi zusammen',
    ],
    'system.chit_chat.farewell': [
      'tschüss', 'tschau', 'auf wiedersehen', 'bis später', 'gute nacht',
    ],
    'system.chit_chat.help': [
      'hilfe', 'was kannst du', 'was kann ich tun', 'zeig mir die befehle',
      'welche befehle gibt es', 'hilf mir',
    ],
    'system.chit_chat.status': [
      'wie läuft es', 'was läuft gerade', 'status anzeigen', 'wie ist der status',
    ],
    'system.chit_chat.calculate': [
      'was ist 12 mal 7', 'rechne 2 plus 2', 'was ist 10 minus 4',
      'berechne 144 geteilt durch 12', 'was ist 25 minus 13',
    ],
  },
};

const PROFILE_FILE = path.join(process.cwd(), 'data', 'user-profile.json');

/** The active locale from the user profile (default 'en' — no phrase additions). */
export function getActiveLocale() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return 'en';
    const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
    const loc = parsed?.userProfile?.locale || parsed?.locale;
    return typeof loc === 'string' && loc.length <= 8 ? loc : 'en';
  } catch {
    return 'en';
  }
}

/** Locale phrases for the active locale, or null when 'en' (nothing to add). */
export function getLocalePhrases() {
  return LOCALE_PHRASES[getActiveLocale()] || null;
}
