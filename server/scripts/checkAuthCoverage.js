/**
 * checkAuthCoverage.js — Phase I (2026-09-09) regression harness for local user accounts.
 * Asserts against the REAL modules (auth/userStore.js, auth/authSessions.js) with the
 * store redirected to a temp file (USERS_FILE env, read at import time — set before the
 * imports below, same pattern as SCHEDULES_FILE/WATCH_RULES_FILE). No server, no network.
 *
 * Run:  npm run check-auth
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.USERS_FILE = path.join(os.tmpdir(), `console-users-${Date.now()}.json`);

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}

const { registerUser, verifyUser, resetPassword, listUsers, hasUsers, findUser } =
  await import(pathToFileURL(base + 'auth/userStore.js').href);
const sessions =
  await import(pathToFileURL(base + 'auth/authSessions.js').href);

// --- registration -----------------------------------------------------------
eq('auth: no users initially', hasUsers(), false);
const r1 = await registerUser('Tobi', 'correct horse battery staple');
eq('auth: register ok', !!r1.user && !r1.error, true);
eq('auth: first user is admin', r1.user?.role, 'admin');
eq('auth: username lowercased', r1.user?.username, 'tobi');
eq('auth: recovery code issued once', typeof r1.recoveryCode === 'string' && r1.recoveryCode.length >= 8, true);
const recoveryCode = r1.recoveryCode;
const r2 = await registerUser('tobi', 'another valid password here');
eq('auth: duplicate name refused', !!r2.error && /already taken/.test(r2.error), true);
const r3 = await registerUser('second-user_1', 'another valid password here');
eq('auth: second user is not admin', r3.user?.role, 'user');
eq('auth: bad username refused', !!(await registerUser('ab', 'another valid password here')).error, true);
eq('auth: short password refused', !!(await registerUser('someone', 'short')).error, true);
eq('auth: overlong password refused (no silent bcrypt truncation)', !!(await registerUser('someone', 'x'.repeat(129))).error, true);

// --- login ------------------------------------------------------------------
const okLogin = await verifyUser('tobi', 'correct horse battery staple');
eq('auth: correct password verifies', okLogin?.username, 'tobi');
eq('auth: wrong password fails', await verifyUser('tobi', 'wrong password here'), null);
eq('auth: unknown user fails', await verifyUser('nobody-here', 'correct horse battery staple'), null);
eq('auth: empty password fails', await verifyUser('tobi', ''), null);

// --- sessions ---------------------------------------------------------------
const token = sessions.createSession('tobi', 'admin');
eq('auth: session validates', sessions.validateSession(token)?.username, 'tobi');
eq('auth: garbage token fails', sessions.validateSession('not-a-real-token'), null);
eq('auth: empty token fails', sessions.validateSession(''), null);
eq('auth: cookie parse extracts token', sessions.tokenFromCookieHeader(`a=b; console_auth=${token}; c=d`), token);
eq('auth: cookie parse rejects hostile value', sessions.tokenFromCookieHeader('console_auth=../../etc'), null);
eq('auth: cookie parse tolerates missing header', sessions.tokenFromCookieHeader(undefined), null);
eq('auth: cookie setter is HttpOnly', /HttpOnly/.test(sessions.authCookie(token)), true);
eq('auth: logout destroys', sessions.destroySession(token) === true && sessions.validateSession(token) === null, true);

// --- reset ------------------------------------------------------------------
const badReset = await resetPassword('tobi', 'wrongcode1', 'brand new password here');
eq('auth: wrong recovery code refused', !!badReset.error, true);
const goodReset = await resetPassword('tobi', recoveryCode, 'brand new password here');
eq('auth: reset ok + rotates code', !!goodReset.user && typeof goodReset.recoveryCode === 'string' && goodReset.recoveryCode !== recoveryCode, true);
eq('auth: old password dead after reset', await verifyUser('tobi', 'correct horse battery staple'), null);
eq('auth: new password works', (await verifyUser('tobi', 'brand new password here'))?.username, 'tobi');
eq('auth: used code cannot replay', !!(await resetPassword('tobi', recoveryCode, 'another new password here')).error, true);

// --- reset kills sessions ----------------------------------------------------
const t1 = sessions.createSession('tobi', 'admin');
const t2 = sessions.createSession('tobi', 'admin');
const r4 = await resetPassword('tobi', goodReset.recoveryCode, 'yet another password here');
eq('auth: second rotation ok', !!r4.user, true);
sessions.destroyUserSessions('tobi');
eq('auth: reset destroys live sessions', sessions.validateSession(t1) === null && sessions.validateSession(t2) === null, true);

// --- public shape + disk hygiene ---------------------------------------------
const listed = listUsers();
eq('auth: listUsers exposes names+roles only', listed.length === 2 && listed.every((u) => u.username && u.role && !u.passwordHash && !u.recoveryHash), true);
const raw = fs.readFileSync(process.env.USERS_FILE, 'utf8');
eq('auth: password never on disk in clear', !raw.includes('yet another password here'), true);
eq('auth: recovery code never on disk in clear', !raw.includes(r4.recoveryCode), true);
eq('auth: hashes are bcrypt', /^\$2[aby]\$10\$/.test(JSON.parse(raw).users[0].passwordHash), true);
eq('auth: findUser is case-insensitive', findUser('TOBI')?.username, 'tobi');

try { fs.unlinkSync(process.env.USERS_FILE); } catch {}
delete process.env.USERS_FILE;

console.log(`\ncheck-auth: ${pass + fail} checks, ${fail} failed`);
process.exit(fail ? 1 : 0);
