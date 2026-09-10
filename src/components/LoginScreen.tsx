// Phase I (2026-09-09): lock screen for armed servers (accounts exist, no session).
// Rendered by App instead of the whole console when /api/auth/me reports armed + anon.
// Raw fetch throughout (auth failures are real HTTP statuses — apiFetchJson discards
// non-2xx bodies, which would eat the server's error text). Any successful login/reset
// reloads the page: the correct post-auth state (profile, sessions, WS identity)
// is only ever built fresh at boot, and a reload is one line versus re-driving it all.
import { useState } from 'react';

type Tab = 'login' | 'register' | 'reset';

async function postJson(path: string, body: object) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const inputCls =
  'w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors';

export function LoginScreen({ prefillUsername = '' }: { prefillUsername?: string }) {
  const [tab, setTab] = useState<Tab>('login');
  // Portal account switching pre-fills the picked name (consumed-once hint set by App
  // before reloading into this screen) — the password is always re-typed, there is no
  // passwordless hop between accounts.
  const [username, setUsername] = useState(prefillUsername);
  const [password, setPassword] = useState('');
  const [regUser, setRegUser] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regSuccess, setRegSuccess] = useState<{ username: string; code: string } | null>(null);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await postJson('/api/auth/login', { username: username.trim(), password });
      if (status === 200 && data?.ok) {
        window.location.reload();
        return;
      }
      setError(data?.error || 'Login failed.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regUser.trim() || !regPass || busy) return;
    setBusy(true);
    setError(null);
    setRegSuccess(null);
    try {
      const { status, data } = await postJson('/api/auth/register', { username: regUser.trim(), password: regPass });
      if (status === 200 && data?.ok) {
        setRegSuccess({ username: data.user.username, code: data.recoveryCode });
        // Auto-log in with the new credentials so the user lands straight in the app
        const login = await postJson('/api/auth/login', { username: regUser.trim(), password: regPass });
        if (login.status === 200 && login.data?.ok) {
          window.location.reload();
          return;
        }
        setError(null);
        return;
      }
      setError(data?.error || 'Registration failed.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !code.trim() || !newPassword || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await postJson('/api/auth/reset', {
        username: username.trim(),
        recoveryCode: code.trim(),
        newPassword,
      });
      if (status === 200 && data?.ok) {
        window.location.reload();
        return;
      }
      setError(data?.error || 'Reset failed.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm bg-panel border border-border-strong rounded-2xl shadow-modal p-6">
        <h1 className="text-display text-fg-strong text-center">Project Console</h1>
        <p className="text-caption text-fg-dim text-center mt-1 mb-5">
          This console requires login.
        </p>

        <div className="flex gap-1 mb-5 p-1 rounded-xl bg-surface">
          {(['login', 'register', 'reset'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setError(null); setRegSuccess(null); }}
              className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                tab === t ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-muted hover:text-fg-strong'
              }`}
            >
              {t === 'login' ? 'Log in' : t === 'register' ? 'Create account' : 'Reset password'}
            </button>
          ))}
        </div>

        {tab === 'login' ? (
          <form onSubmit={submitLogin} className="space-y-3">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoComplete="username"
              autoFocus
              className={inputCls}
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              type="password"
              autoComplete="current-password"
              className={inputCls}
            />
            {error && <p className="text-xs text-accent-red">{error}</p>}
            <button
              type="submit"
              disabled={busy || !username.trim() || !password}
              className="w-full px-3 py-2 text-sm font-bold rounded-xl bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed glass glass-btn"
            >
              {busy ? 'Logging in…' : 'Log in'}
            </button>
            <p className="text-[11px] text-fg-dim text-center">
              No account yet? Switch to <button type="button" onClick={() => { setTab('register'); setError(null); }} className="text-accent-blue underline">Create account</button>.
            </p>
          </form>
        ) : tab === 'register' ? (
          regSuccess ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-accent-orange/10 border border-accent-orange/30 px-3 py-2.5 space-y-2">
                <p className="text-xs text-fg-strong">
                  Account <span className="font-mono">@{regSuccess.username}</span> created. Save this recovery code — shown <span className="font-bold">once</span>:
                </p>
                <p className="font-mono text-sm text-accent-orange font-bold tracking-wider">{regSuccess.code}</p>
                <p className="text-[11px] text-fg-dim">You are being logged in… if nothing happens, switch to Log in and sign in with your new password.</p>
              </div>
              <button type="button" onClick={() => { setTab('login'); setUsername(regSuccess.username); setRegSuccess(null); }} className="w-full px-3 py-2 text-sm font-bold rounded-xl bg-accent-blue text-white hover:opacity-90 transition-opacity glass glass-btn">Go to Log in</button>
            </div>
          ) : (
            <form onSubmit={submitRegister} className="space-y-3">
              <input
                value={regUser}
                onChange={(e) => setRegUser(e.target.value)}
                placeholder="Choose a username (3–32 chars)"
                autoComplete="username"
                autoFocus
                className={inputCls}
              />
              <input
                value={regPass}
                onChange={(e) => setRegPass(e.target.value)}
                placeholder="Choose a password (8+ characters)"
                type="password"
                autoComplete="new-password"
                className={inputCls}
              />
              {error && <p className="text-xs text-accent-red">{error}</p>}
              <p className="text-[11px] text-fg-dim leading-relaxed">
                On a fresh console this creates the first admin. Once login is armed, only an admin can create accounts — you will see "Registration is closed — ask your admin" if self-registration is not allowed.
              </p>
              <button
                type="submit"
                disabled={busy || !regUser.trim() || !regPass}
                className="w-full px-3 py-2 text-sm font-bold rounded-xl bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed glass glass-btn"
              >
                {busy ? 'Creating…' : 'Create account'}
              </button>
            </form>
          )
        ) : (
          <form onSubmit={submitReset} className="space-y-3">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoComplete="username"
              className={inputCls}
            />
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Recovery code (shown once at registration)"
              autoComplete="off"
              className={`${inputCls} font-mono`}
            />
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+ characters)"
              type="password"
              autoComplete="new-password"
              className={inputCls}
            />
            {error && <p className="text-xs text-accent-red">{error}</p>}
            <button
              type="submit"
              disabled={busy || !username.trim() || !code.trim() || !newPassword}
              className="w-full px-3 py-2 text-sm font-bold rounded-xl bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed glass glass-btn"
            >
              {busy ? 'Resetting…' : 'Reset password & log in'}
            </button>
          </form>
        )}

        <p className="text-[11px] text-fg-dim mt-5 leading-relaxed">
          Locked out with no recovery code? On the server machine itself, run{' '}
          <code className="font-mono">node bin/cli.js auth reset-password &lt;username&gt;</code> to set a
          new password (proves machine ownership via file access), or delete{' '}
          <code className="font-mono">data/users.json</code> to reset auth entirely (the server
          returns to open mode).
        </p>
      </div>
    </div>
  );
}
