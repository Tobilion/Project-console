// Phase I (2026-09-09): local user accounts — the persisted user record layer.
// Storage is a flat gitignored data/users.json (no new native dependency; better-sqlite3
// would add a compile step that breaks the Electron + esbuild-bundle packaging — see the
// desktop P0 notes). Passwords AND recovery codes are bcryptjs-hashed (pure JS, no native
// build); nothing secret is ever stored or logged in the clear. Env-overridable USERS_FILE
// for the harness, same pattern as SCHEDULES_FILE/WATCH_RULES_FILE/EDITORS_FILE.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { resolveData } from '../dataPath.js';
import { writeFileAtomicSync } from '../atomicWrite.js';

const USERS_FILE = process.env.USERS_FILE || resolveData('users.json');

// bcrypt cost: 10 is the OWASP-ish default for interactive logins (~100ms here — the
// login/register/reset paths are rare human-paced calls, never hot loops). Async API so
// the hash never blocks the WS/event-loop turn.
const SALT_ROUNDS = 10;
// Password policy: 8–128 chars. bcrypt truncates past 72 BYTES — 128 chars of ASCII can
// exceed that, so overlong input is rejected rather than silently truncated (a user who
// types a 100-char password must not get the security of its first 72 bytes unknowingly).
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
// Usernames: 3–32 chars of a-z0-9_-, case-insensitive unique. Narrow on purpose — the name
// lands in file paths (data/users/<id>/) and chat attribution, never in a shell.
const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

let users = [];

function persist() {
  try {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    writeFileAtomicSync(USERS_FILE, JSON.stringify({ users }, null, 2));
  } catch {
    // best-effort only — same convention as the sibling stores
  }
}

export function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.users)) {
      users = parsed.users.filter(
        (u) => u && typeof u.username === 'string' && typeof u.passwordHash === 'string',
      );
    }
  } catch {
    // corrupt file — start empty (an operator can delete it to reset auth entirely)
  }
}

export function listUsers() {
  // Public shape only — hashes never leave this module.
  return users.map((u) => ({ username: u.username, role: u.role, createdAt: u.createdAt }));
}

export function hasUsers() {
  return users.length > 0;
}

export function findUser(username) {
  const name = String(username || '').trim().toLowerCase();
  return users.find((u) => u.username === name) || null;
}

function validUsername(name) {
  return USERNAME_RE.test(String(name || '').trim().toLowerCase());
}

function passwordError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Password must be at most ${MAX_PASSWORD} characters.`;
  }
  return null;
}

function newRecoveryCode() {
  // 2× 32-bit words rendered as 8 unambiguous consonants each half (no vowels/lookalikes
  // in the alphabet — readable over the phone, ~60 bits of entropy).
  const alphabet = 'bcdfghjkmnpqrstvwxz2456789';
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Register a new user. Returns { user } or { error }.
 *  The recovery code is returned IN THE CLEAR exactly once (shown to the registering
 *  user, who must store it) — only its bcrypt hash is persisted.
 *  Roles: the FIRST user is always admin (requested role ignored — otherwise the
 *  world's first registrant could pick 'user' and brick administration, or an armed
 *  server's open-registration window could mint admins). Afterwards only an admin
 *  session may register (route-enforced), and may request 'admin' or 'user'. */
export async function registerUser(username, password, requestedRole) {
  const name = String(username || '').trim().toLowerCase();
  if (!validUsername(username)) {
    return { error: 'Username must be 3–32 chars of letters, numbers, _ or -.' };
  }
  const pwErr = passwordError(password);
  if (pwErr) return { error: pwErr };
  if (findUser(name)) return { error: `Username "${name}" is already taken.` };
  const first = users.length === 0;
  const role = first ? 'admin' : (requestedRole === 'admin' ? 'admin' : 'user');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const recoveryCode = newRecoveryCode();
  const recoveryHash = await bcrypt.hash(recoveryCode, SALT_ROUNDS);
  const user = {
    username: name,
    passwordHash,
    recoveryHash,
    role,
    createdAt: Date.now(),
  };
  users.push(user);
  persist();
  return { user: { username: user.username, role: user.role, createdAt: user.createdAt }, recoveryCode };
}

/** Verify a password. Returns the public user shape, or null. Timing-safe by
 *  construction: unknown users still pay one bcrypt compare against a dummy hash so
 *  "user exists" isn't measurable by response time. */
const DUMMY_HASH = '$2b$10$C6UzMDM.H6dfI/f/IKcEe.Q6r9Z9Q6r9Z9Q6r9Z9Q6r9Z9Q6r9Z9Q6u';
export async function verifyUser(username, password) {
  const user = findUser(username);
  const hash = user ? user.passwordHash : DUMMY_HASH;
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!ok || !user) return null;
  return { username: user.username, role: user.role, createdAt: user.createdAt };
}

/** Reset a password with a recovery code. Rotates the code (a fresh one is returned
 *  in the clear, once) so a used code can never be replayed. */
export async function resetPassword(username, recoveryCode, newPassword) {
  const user = findUser(username);
  // Same timing-shape as verifyUser: always compare something.
  const ok = await bcrypt.compare(
    String(recoveryCode || ''),
    user ? user.recoveryHash : DUMMY_HASH,
  );
  if (!ok || !user) return { error: 'Unknown user or wrong recovery code.' };
  const pwErr = passwordError(newPassword);
  if (pwErr) return { error: pwErr };
  user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const nextCode = newRecoveryCode();
  user.recoveryHash = await bcrypt.hash(nextCode, SALT_ROUNDS);
  persist();
  return { user: { username: user.username, role: user.role }, recoveryCode: nextCode };
}

/** Local-machine admin reset (I-5): set a password WITHOUT a recovery code, and
 *  rotate the recovery code (returned in the clear, once). This MUST only ever be
 *  called from a local-operator path (the bin/cli.js `auth` subcommand) — the caller
 *  proves machine ownership through filesystem access to USERS_FILE itself, the same
 *  trust already behind the "delete users.json to reset auth" escape hatch. Never
 *  expose over HTTP: anyone who can reach it remotely can take any account. */
export async function adminResetPassword(username, newPassword) {
  const user = findUser(username);
  if (!user) return { error: `Unknown user "${String(username || '').trim()}".` };
  const pwErr = passwordError(newPassword);
  if (pwErr) return { error: pwErr };
  user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const nextCode = newRecoveryCode();
  user.recoveryHash = await bcrypt.hash(nextCode, SALT_ROUNDS);
  persist();
  return { user: { username: user.username, role: user.role }, recoveryCode: nextCode };
}

/** Delete a user (admin console action). Returns true when someone was removed.
 *  Their sessions are the caller's job (destroyUserSessions) — orphaned chats stay on
 *  disk but become admin-visible-only, same as any other foreign-owned session. */
export function deleteUser(username) {
  const name = String(username || '').trim().toLowerCase();
  const at = users.findIndex((u) => u.username === name);
  if (at === -1) return false;
  users.splice(at, 1);
  persist();
  return true;
}

/** Remove every user and persist the empty list (admin "disable login" action).
 *  Returns the count removed. Sessions are the caller's job (destroyAllSessions). */
export function clearAllUsers() {
  const n = users.length;
  users = [];
  persist();
  return n;
}

/** Test hook — drop the in-memory list (the harness points USERS_FILE at a temp file). */
export function clearUsersForTests() {
  users = [];
}
