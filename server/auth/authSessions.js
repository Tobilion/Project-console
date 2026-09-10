// Phase I (2026-09-09): opaque session tokens for authenticated HTTP + WebSocket.
// Deliberately NOT JWT (no signature library, no expiry-claim clock math): a
// crypto.randomUUID token minted at login, kept in a server-side Map, delivered as an
// HttpOnly SameSite=Lax cookie and accepted on the WS upgrade request. Sessions are
// process-memory only — a server restart logs everyone out (documented, not a bug: the
// alternative is persisting bearer tokens to disk next to the password hashes). 30-day
// sliding expiry, refreshed on each validated use; periodic sweep drops the expired.

import crypto from 'crypto';

const COOKIE_NAME = 'console_auth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// token -> { username, role, createdAt, lastSeen }
const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(token);
  }
}

/** Mint a session for an already-verified user. Returns the raw token (set as cookie). */
export function createSession(username, role) {
  if (sessions.size % 50 === 0) sweep();
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomBytes(8).toString('hex');
  sessions.set(token, { username, role, createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}

/** Validate a token (sliding expiry). Returns { username, role } or null. */
export function validateSession(token) {
  if (typeof token !== 'string' || !token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = Date.now();
  return { username: s.username, role: s.role };
}

/** Destroy one session (logout). Returns true when something was removed. */
export function destroySession(token) {
  return sessions.delete(token);
}

/** Destroy every session of a user (used after a password reset — a rotated credential
 *  must not leave the old password's sessions alive). Returns the count removed. */
export function destroyUserSessions(username) {
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.username === username) {
      sessions.delete(token);
      n++;
    }
  }
  return n;
}

/** Parse the auth cookie out of a Cookie header (no cookie-parser dependency — one name,
 *  strict value charset, everything else ignored). */
export function tokenFromCookieHeader(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      const value = part.slice(idx + 1).trim();
      return /^[A-Za-z0-9]+$/.test(value) ? value : null;
    }
  }
  return null;
}

/** Set-Cookie header value for a fresh login. */
export function authCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Expired Set-Cookie value for logout. */
export function clearAuthCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME };

/** Destroy every session (used when login is disabled entirely). */
export function destroyAllSessions() {
  const n = sessions.size;
  sessions.clear();
  return n;
}

/** Test hook — drop all sessions. */
export function clearSessionsForTests() {
  sessions.clear();
}
