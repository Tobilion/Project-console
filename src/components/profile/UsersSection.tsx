// Users admin section (portal, 2026-09-10): account management for login-armed servers.
// - Disarmed: create-first-admin inline form (the server leaves registration open ONLY
//   while zero users exist, so this doubles as the post-setup onboarding path).
// - Armed + admin: user list with per-row password reset (confirm + new-password input,
//   rotated recovery code shown once) and deletion (two-click confirm; self and last
//   admin are refused server-side).
// - Armed non-admin: the parent hides this section entirely.
// Raw fetch throughout (admin failures are real HTTP statuses — apiFetchJson discards
// non-2xx bodies). After creating the first admin the page reloads into the login
// screen (post-auth state is only ever built fresh at boot).

import { useState, useEffect } from 'react';

interface PortalUser {
  username: string;
  role: string;
}

async function rawFetch(path: string, opts?: RequestInit) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export function UsersSection({ authArmed, authRole }: { authArmed: boolean; authRole: string | null }) {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdCode, setCreatedCode] = useState<{ username: string; code: string; password: string } | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPass, setResetPass] = useState('');
  const [resetCode, setResetCode] = useState<string | null>(null);
  const [deleteArm, setDeleteArm] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const { status, data } = await rawFetch('/api/auth/users');
      if (status === 200 && Array.isArray(data?.users)) setUsers(data.users);
      else setError(data?.error || 'Could not load users.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authArmed) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authArmed]);

  const createFirst = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPass || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await rawFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username: newName.trim(), password: newPass }),
      });
      if (status === 200 && data?.ok) {
        // Keep the just-typed password for the one-tap login below (state, never storage).
        setCreatedCode({ username: data.user.username, code: data.recoveryCode, password: newPass });
        setNewName('');
      } else {
        setError(data?.error || 'Registration failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const loginAs = async (username: string, password: string) => {
    const { status } = await rawFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (status === 200) window.location.reload();
    else setError('Account created, but automatic login failed — use the login screen.');
  };

  const doReset = async (username: string) => {
    if (!resetPass || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await rawFetch('/api/auth/admin/reset', {
        method: 'POST',
        body: JSON.stringify({ username, newPassword: resetPass }),
      });
      if (status === 200 && data?.ok) {
        setResetCode(data.recoveryCode);
        setResetPass('');
      } else {
        setError(data?.error || 'Reset failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (username: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setDeleteArm(null);
        void refresh();
      } else {
        setError(data?.error || 'Delete failed.');
        setDeleteArm(null);
      }
    } catch {
      setError('Could not reach the server.');
      setDeleteArm(null);
    } finally {
      setBusy(false);
    }
  };

  // Not armed yet: first-admin onboarding (also reachable post-setup — the server keeps
  // registration open exactly until the first account exists).
  if (!authArmed) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] text-fg-dim leading-relaxed">
          User accounts are off — this console is open to anyone who can reach it. Create the
          first admin account to require login (per-user chats and profiles activate with it).
        </p>
        {createdCode ? (
          <div className="rounded-lg bg-accent-orange/10 border border-accent-orange/30 px-3 py-2.5 space-y-2">
            <p className="text-xs text-fg-strong">
              Admin <span className="font-mono">@{createdCode.username}</span> created. Save this
              recovery code — it is shown <span className="font-bold">once</span>:
            </p>
            <p className="font-mono text-sm text-accent-orange font-bold tracking-wider">{createdCode.code}</p>
            <button
              type="button"
              onClick={() => loginAs(createdCode.username, createdCode.password)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-accent-blue text-white hover:opacity-90 transition-opacity"
            >
              I saved it — log in
            </button>
          </div>
        ) : (
          <form onSubmit={createFirst} className="space-y-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Admin username (3–32 chars)"
              autoComplete="username"
              className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors"
            />
            <input
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="Password (8+ characters)"
              type="password"
              autoComplete="new-password"
              className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors"
            />
            {error && <p className="text-xs text-accent-red">{error}</p>}
            <button
              type="submit"
              disabled={busy || !newName.trim() || !newPass}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Creating…' : 'Create admin account'}
            </button>
          </form>
        )}
      </div>
    );
  }

  // Armed but not admin: parent hides the section; this is the backstop.
  if (authRole !== 'admin') {
    return <p className="text-[11px] text-fg-dim">User management is admin-only.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-fg-dim">{users.length} account{users.length === 1 ? '' : 's'} — chats and profiles are per-user.</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[11px] text-fg-dim hover:text-fg-strong transition-colors"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="text-xs text-accent-red">{error}</p>}
      {users.map((u) => (
        <div key={u.username} className="rounded-lg bg-surface border border-border-soft px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm text-fg-strong font-mono truncate">@{u.username}</span>
            <span className="text-[10px] uppercase tracking-wider text-fg-dim">{u.role}</span>
            <button
              type="button"
              onClick={() => { setResetFor(resetFor === u.username ? null : u.username); setResetCode(null); setResetPass(''); }}
              className="px-2 py-1 rounded-md text-[11px] text-fg-dim hover:text-fg-strong hover:bg-scrim-faint transition-colors"
              title={`Reset ${u.username}'s password`}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => setDeleteArm(deleteArm === u.username ? null : u.username)}
              className="px-2 py-1 rounded-md text-[11px] text-fg-dim hover:text-accent-red hover:bg-accent-red/10 transition-colors"
              title={`Delete ${u.username}`}
            >
              Delete
            </button>
          </div>
          {resetFor === u.username && (
            <div className="mt-2 space-y-2 border-t border-border-faint pt-2">
              <p className="text-[11px] text-fg-dim">
                Set a new password for <span className="font-mono">@{u.username}</span> (confirm below —
                their live sessions are killed and a fresh recovery code is issued).
              </p>
              <div className="flex gap-2">
                <input
                  value={resetPass}
                  onChange={(e) => setResetPass(e.target.value)}
                  placeholder="New password (8+ characters)"
                  type="password"
                  autoComplete="new-password"
                  className="flex-1 bg-background border border-border-soft rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors"
                />
                <button
                  type="button"
                  disabled={busy || !resetPass}
                  onClick={() => void doReset(u.username)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? '…' : 'Confirm reset'}
                </button>
              </div>
              {resetCode && (
                <p className="text-[11px] text-accent-orange">
                  Done — new recovery code (shown once): <span className="font-mono font-bold">{resetCode}</span>
                </p>
              )}
            </div>
          )}
          {deleteArm === u.username && (
            <div className="mt-2 border-t border-border-faint pt-2 flex items-center gap-2">
              <p className="flex-1 text-[11px] text-fg-dim">
                Permanently delete <span className="font-mono">@{u.username}</span>? Their chats stay on
                disk, admin-visible only.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void doDelete(u.username)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-accent-red text-white hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setDeleteArm(null)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-fg-dim hover:text-fg-strong transition-colors"
              >
                Keep
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
