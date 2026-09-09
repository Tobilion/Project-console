// Phase I (2026-09-09): enforcement gating for local accounts (I-2).
// The gate is ARMED exactly when at least one user exists (hasUsers) — a fresh install
// with no accounts behaves byte-identically to before auth existed (every route open,
// no login). The moment the first user registers, /api (except /api/auth/*) and the
// /stream WebSocket require a valid session. There is deliberately no "disable" switch:
// the escape hatch for a lockout is deleting data/users.json with filesystem access
// (documented in the login UI), which returns the server to open mode.
//
// Authenticated identity rides req.authUser ({ username, role }) for later phases to
// build per-user attribution/sharding on — I-2 only gates, it does not yet re-scope data.
import { hasUsers } from './userStore.js';
import { validateSession, tokenFromCookieHeader } from './authSessions.js';

/** True when the server currently requires login (≥1 registered user). */
export function authArmed() {
  return hasUsers();
}

/** Express middleware — mount as app.use('/api', requireAuth) BEFORE all route leaves.
 *  Inside the mount, req.path is the /api-stripped remainder (/projects, /auth/login). */
export function requireAuth(req, res, next) {
  if (!authArmed()) return next();
  if (req.path === '/auth' || req.path.startsWith('/auth/')) return next();
  const user = validateSession(tokenFromCookieHeader(req.headers.cookie));
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Login required.' });
  }
  req.authUser = user;
  return next();
}

/** WS upgrade check — true when this upgrade request may proceed. Browsers send the
 *  HttpOnly auth cookie automatically; non-browser clients (a future authed CLI) can
 *  send `Cookie: console_auth=<token>` by hand. */
export function checkWsAuth(request) {
  if (!authArmed()) return true;
  const cookie = request?.headers?.cookie;
  return validateSession(tokenFromCookieHeader(cookie)) !== null;
}
