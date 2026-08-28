// checkEncoding.js — encoding hygiene harness (2026-08-28):
// Fails on committed double-encoded UTF-8 mojibake (C3 A2 pattern) that produced the
// "Pick a PDFâ€¦" / "— → â—" artifacts fixed in the 2026-08-28 pass. Also catches stray
// "â" literals that are the visible symptom of that mojibake. Runs in CI so a future
// editor save with the wrong charset can't re-introduce it silently.

import fs from 'fs';
import { execSync } from 'child_process';

const MOJIBAKE = Buffer.from([0xC3, 0xA2]); // first bytes of double-encoded —/…

// Files that are allowed to mention mojibake in comments/docs (this file + docs explaining it)
const ALLOW = new Set([
  'server/scripts/checkEncoding.js',
]);

function listTracked() {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter(f => /\.(js|ts|tsx|css|json|md)$/.test(f));
}

let bad = [];
for (const f of listTracked()) {
  if (ALLOW.has(f)) continue;
  try {
    const buf = fs.readFileSync(f);
    if (buf.indexOf(MOJIBAKE) !== -1) {
      bad.push(`${f}: contains double-encoded mojibake bytes C3 A2 (likely —/… double-encoded via cp1252)`);
    }
  } catch {}
}

if (bad.length) {
  console.error('checkEncoding: FAILED — mojibake detected:\n' + bad.map(s => '  - ' + s).join('\n'));
  process.exit(1);
}
console.log('checkEncoding: ok — no mojibake bytes found');
