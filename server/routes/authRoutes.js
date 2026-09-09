// Phase I (2026-09-09): local user accounts — register/login/logout/me/reset over REST.
// I-1 ships the account machinery with NO enforcement: every existing route stays exactly
// as open as today until I-2 wires the gate (so this commit cannot lock anyone out and
// cannot change single-user behavior). Status codes are real HTTP semantics (400/401/409,
// not {ok:false}-at-200 — auth failures are not business-logic results), so the login UI
// uses raw fetch, never apiFetchJson (which discards non-2xx bodies).
import { registerUser, verifyUser, resetPassword, listUsers } from '../auth/userStore.js';
import {
  createSession,
  validateSession,
  destroySession,
  destroyUserSessions,
  tokenFromCookieHeader,
  authCookie,
  clearAuthCookie,
} from '../auth/authSessions.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerAuthRoutes(app) {
  app.post(
    '/api/auth/register',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body || {};
      const result = await registerUser(username, password);
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
    res.json({ user });
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

  // Admin visibility (used by the future login UI + Phase L docs): usernames + roles only.
  app.get('/api/auth/users', (req, res) => {
    res.json({ users: listUsers() });
  });
}
