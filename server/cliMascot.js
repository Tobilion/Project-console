// ASCII mascot greeting (2026-08-24, split out of cli-client.js). Shown above the project
// picker on the TTY path, matching the figlet banner. The animal is picked at random from a
// curated list validated against the installed cowsay package's cows/ directory (2026-08-10:
// cat/owl/dragon/robot/stegosaurus all present); the fallback exists because cowsay.say()
// throws on an unknown f value, and the greeting name comes from the tracked user profile when
// available, never hardcoded per user.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveData } from './dataPath.js';
import cowsay from 'cowsay';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MASCOT_COWS = ['cat', 'owl', 'dragon', 'robot', 'stegosaurus', 'tux', 'doge'];

export function renderMascot() {
  // Generic fallback, not a hardcoded person's name — data/user-profile.json isn't published
  // with the npm package and only exists once a user sets their own profile, so a fresh install
  // used to greet every stranger as "Tobi" (the original author) by name (audit 2026-08-10,
  // raised while generalizing for npm/public distribution).
  let name = 'there';
  try {
    const profile = JSON.parse(fs.readFileSync(resolveData('user-profile.json'), 'utf8'));
    if (profile.userProfile?.name) name = profile.userProfile.name;
  } catch {
    // Missing/corrupt profile must not fail the whole CLI — keep the fallback name.
  }
  const animal = MASCOT_COWS[Math.floor(Math.random() * MASCOT_COWS.length)];
  let art;
  try {
    art = cowsay.say({ text: `Welcome back, ${name}! Select a project to initialize session:`, e: 'oO', T: 'U ', f: animal });
  } catch {
    art = cowsay.say({ text: `Welcome back, ${name}!`, f: 'cat' });
  }
  console.log(chalk.cyan(art));
}