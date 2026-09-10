// Phase I (2026-09-09): local user accounts — register/login/logout/me/reset over REST.
// I-1 ships the account machinery with NO enforcement: every existing route stays exactly
// as open as today until I-2 wires the gate (so this commit cannot lock anyone out and
// cannot change single-user behavior). Status codes are real HTTP semantics (400/401/409,
// not {ok:false}-at-200 — auth failures are not business-logic results), so the login UI
// uses raw fetch, never apiFetchJson (which discards non-2xx bodies).
import { registerUser, verifyUser, resetPassword, adminResetPassword, deleteUser, listUsers, hasUsers, clearAllUsers } from '../auth/userStore.js';
import {
  createSession,
  validateSession,
  destroySession,
  destroyUserSessions,
  destroyAllSessions,
  tokenFromCookieHeader,
  authCookie,
  clearAuthCookie,
} from '../auth/authSessions.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerAuthRoutes(app) {
  app.post(
    '/api/auth/register',
    asyncHandler(async (req, res) => {
      // Open registration ONLY while no users exist (first-admin setup). Once armed,
      // creating accounts requires an admin session — otherwise anyone on the LAN could
      // self-provision into an armed server. (I-3: the login UI only shows the register
      // tab when the server reports registered:false.)
      if (hasUsers() && req.authUser?.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Registration is closed — ask your admin to create an account.' });
      }
      const { username, password, role } = req.body || {};
      const result = await registerUser(username, password, role);
      if (result.error) {
        // 409 only for the taken-name case; everything else is a 400 validation failure.
        const status = /already taken/.test(result.error) ? 409 : 400;
        return res.status(status).json({ ok: false, error: result.error });
      }
      // NOTE: recoveryCode is shown ONCE, here. It is never stored or logged in the clear.
      res.json({ ok: true, user: result.user, recoveryCode: result.recoveryCode });
    }),
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body || {};
      const user = await verifyUser(username, password);
      if (!user) return res.status(401).json({ ok: false, error: 'Unknown user or wrong password.' });
      const token = createSession(user.username, user.role);
      res.setHeader('Set-Cookie', authCookie(token));
      res.json({ ok: true, user });
    }),
  );

  app.post('/api/auth/logout', (req, res) => {
    const token = tokenFromCookieHeader(req.headers.cookie);
    if (token) destroySession(token);
    res.setHeader('Set-Cookie', clearAuthCookie());
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = validateSession(tokenFromCookieHeader(req.headers.cookie));
    // `armed` lets clients (web login screen, CLI) decide the flow without probing
    // protected routes: false = today's open server, no login exists.
    res.json({ user, armed: hasUsers() });
  });

  app.post(
    '/api/auth/reset',
    asyncHandler(async (req, res) => {
      const { username, recoveryCode, newPassword } = req.body || {};
      const result = await resetPassword(username, recoveryCode, newPassword);
      if (result.error) return res.status(401).json({ ok: false, error: result.error });
      // A rotated credential must not leave the old password's sessions alive.
      destroyUserSessions(result.user.username);
      res.json({ ok: true, user: result.user, recoveryCode: result.recoveryCode });
    }),
  );

  // Account list (usernames + roles only, never hashes). Requires a session while
  // armed — no anonymous user enumeration. Open while disarmed (harmless: no accounts).
  app.get('/api/auth/users', (req, res) => {
    if (hasUsers() && !req.authUser) {
      return res.status(401).json({ ok: false, error: 'Login required.' });
    }
    res.json({ users: listUsers() });
  });

  // Admin password reset (web console counterpart to the local CLI reset). Same
  // adminResetPassword machinery, same rotated-code response — the fresh recovery code
  // is returned once so the UI can show it. Never anonymous, never non-admin.
  app.post(
    '/api/auth/admin/reset',
    asyncHandler(async (req, res) => {
      if (req.authUser?.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Admin only.' });
      }
      const { username, newPassword } = req.body || {};
      const result = await adminResetPassword(username, newPassword);
      if (result.error) return res.status(400).json({ ok: false, error: result.error });
      destroyUserSessions(result.user.username);
      res.json({ ok: true, user: result.user, recoveryCode: result.recoveryCode });
    }),
  );

  // Admin account removal. Refuses self-deletion and removing the last admin (both
  // would brick administration with live sessions still running). The removed user's
  // chats stay on disk and become admin-visible-only, like any foreign-owned session.
  app.delete(
    '/api/auth/users/:username',
    asyncHandler(async (req, res) => {
      if (req.authUser?.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Admin only.' });
      }
      const name = String(req.params.username || '').trim().toLowerCase();
      if (!name || name === req.authUser.username) {
        return res.status(400).json({ ok: false, error: 'You cannot delete your own account.' });
      }
      if (listUsers().filter((u) => u.role === 'admin').length <= 1 &&
          listUsers().some((u) => u.username === name && u.role === 'admin')) {
        return res.status(400).json({ ok: false, error: 'Cannot delete the last admin.' });
      }
      if (!deleteUser(name)) return res.status(404).json({ ok: false, error: 'Unknown user.' });
      destroyUserSessions(name);
      res.json({ ok: true });
    }),
  );

  // Self-service password change (logged-in user, old password required). Every user
  // — including non-admins — can change their own password without a recovery code.
  app.post(
    '/api/auth/change-password',
    asyncHandler(async (req, res) => {
      if (!req.authUser) return res.status(401).json({ ok: false, error: 'Login required.' });
      const { currentPassword, newPassword } = req.body || {};
      const user = await verifyUser(req.authUser.username, currentPassword);
      if (!user) return res.status(401).json({ ok: false, error: 'Current password is wrong.' });
      const result = await adminResetPassword(req.authUser.username, newPassword);
      if (result.error) return res.status(400).json({ ok: false, error: result.error });
      // Keep the current session alive — only kill *other* sessions of this user so
      // a stolen session elsewhere is invalidated but this browser stays logged in.
      const currentToken = tokenFromCookieHeader(req.headers.cookie);
      let killed = 0;
      if (currentToken) {
        // destroyUserSessions kills all — re-create the current one so the caller
        // does not get logged out immediately after changing their own password.
        const kept = validateSession(currentToken);
        destroyUserSessions(req.authUser.username);
        if (kept) {
          // validateSession already refreshed lastSeen; re-inserting keeps the token valid
          // for this response. The simplest path: mint a fresh token for the caller.
          const fresh = createSession(req.authUser.username, req.authUser.role);
          res.setHeader('Set-Cookie', authCookie(fresh));
        }
      } else {
        destroyUserSessions(req.authUser.username);
      }
      res.json({ ok: true, recoveryCode: result.recoveryCode });
    }),
  );

  // Admin: disable login entirely (clear every account, destroy all sessions).
  // Returns the server to open mode — the site AND the desktop app share the same
  // server and the same data/users.json, so disabling in one place disables both
  // by design (there is no separate "site auth" vs "app auth" — the app is a
  // wrapper around the same local server). Requires admin and a double-confirm
  // body flag so a stray click cannot wipe auth.
  app.post(
    '/api/auth/disable',
    asyncHandler(async (req, res) => {
      if (req.authUser?.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Admin only.' });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({ ok: false, error: 'Send { confirm: true } to disable login.' });
      }
      const removed = clearAllUsers();
      destroyAllSessions();
      // Expire the caller's cookie too — they will land on the open console next reload.
      res.setHeader('Set-Cookie', clearAuthCookie());
      res.json({ ok: true, removed });
    }),
  );
}
