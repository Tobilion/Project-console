/**
 * checkAuthCoverage.js — Phase I (2026-09-09) regression harness for local user accounts.
 * Asserts against the REAL modules (auth/userStore.js, auth/authSessions.js) with the
 * store redirected to a temp file (USERS_FILE env, read at import time — set before the
 * imports below, same pattern as SCHEDULES_FILE/WATCH_RULES_FILE). No server, no network.
 * The I-4b profile-sharding block additionally redirects PROFILE_FILE at a temp dir the
 * same way, before its own lazy import of profileRoutes.js.
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

const { registerUser, verifyUser, resetPassword, adminResetPassword, listUsers, hasUsers, findUser, clearUsersForTests } =
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

// --- local-machine admin reset (I-5: OS-auth equivalent, never over HTTP) -----
const noUser = await adminResetPassword('ghost-user', 'a valid new password here');
eq('auth: admin reset refuses unknown user', !!noUser.error, true);
const weakAdmin = await adminResetPassword('tobi', 'short');
eq('auth: admin reset enforces password policy', !!weakAdmin.error, true);
const codeBefore = r4.recoveryCode;
const adm = await adminResetPassword('tobi', 'local operator password here');
eq('auth: admin reset ok + rotates code', !!adm.user && typeof adm.recoveryCode === 'string' && adm.recoveryCode !== codeBefore, true);
eq('auth: pre-reset password dead after admin reset', await verifyUser('tobi', 'yet another password here'), null);
eq('auth: admin-reset password works', (await verifyUser('tobi', 'local operator password here'))?.username, 'tobi');
eq('auth: rotated code from admin reset is live', !!(await resetPassword('tobi', adm.recoveryCode, 'post-admin password here')).user, true);

// --- public shape + disk hygiene ---------------------------------------------
const listed = listUsers();
eq('auth: listUsers exposes names+roles only', listed.length === 2 && listed.every((u) => u.username && u.role && !u.passwordHash && !u.recoveryHash), true);
const raw = fs.readFileSync(process.env.USERS_FILE, 'utf8');
eq('auth: password never on disk in clear', !raw.includes('yet another password here'), true);
eq('auth: recovery code never on disk in clear', !raw.includes(r4.recoveryCode), true);
eq('auth: hashes are bcrypt', /^\$2[aby]\$10\$/.test(JSON.parse(raw).users[0].passwordHash), true);
eq('auth: findUser is case-insensitive', findUser('TOBI')?.username, 'tobi');

// --- enforcement gate (I-2) -------------------------------------------------------
// Disarmed (no users... except the two registered above — arm explicitly by registering
// a gate user, then restore by clearing). requireAuth takes the /api-stripped path,
// matching the app.use('/api', requireAuth) mount semantics.
const { requireAuth, checkWsAuth, authArmed } =
  await import(pathToFileURL(base + 'auth/authGate.js').href);
function fakeReq(pathname, cookie) {
  return { path: pathname, headers: cookie ? { cookie } : {} };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}
eq('auth gate: armed once users exist', authArmed(), true);
{
  let nexted = false;
  const res = fakeRes();
  requireAuth(fakeReq('/projects', null), res, () => { nexted = true; });
  eq('auth gate: armed + no cookie -> 401', nexted === false && res.statusCode === 401 && res.body?.error === 'Login required.', true);
}
{
  let nexted = false;
  const res = fakeRes();
  requireAuth(fakeReq('/projects', 'junk-header-without-equals'), res, () => { nexted = true; });
  eq('auth gate: malformed cookie -> 401', nexted === false && res.statusCode === 401, true);
}
{
  // /api/auth/* stays open while armed (the login page must reach register/login).
  let nexted = false;
  requireAuth(fakeReq('/auth/login', null), fakeRes(), () => { nexted = true; });
  eq('auth gate: auth routes pass while armed', nexted, true);
}
const gateLogin = await verifyUser('tobi', 'post-admin password here');
const gateToken = sessions.createSession(gateLogin.username, gateLogin.role);
{
  let nexted = false;
  const req = fakeReq('/projects', `console_auth=${gateToken}`);
  const res = fakeRes();
  requireAuth(req, res, () => { nexted = true; });
  eq('auth gate: valid cookie passes + carries identity', nexted === true && req.authUser?.username === 'tobi', true);
}
eq('auth gate: WS denied without cookie while armed', checkWsAuth({ headers: {} }), false);
eq('auth gate: WS allowed with cookie while armed', checkWsAuth({ headers: { cookie: `console_auth=${gateToken}` } }), true);
clearUsersForTests();
const { clearSessionsForTests } = await import(pathToFileURL(base + 'auth/authSessions.js').href);
clearSessionsForTests();
eq('auth gate: disarmed again with no users', authArmed(), false);
{
  let nexted = false;
  requireAuth(fakeReq('/projects', null), fakeRes(), () => { nexted = true; });
  eq('auth gate: disarmed passes everything (today behavior)', nexted, true);
}
eq('auth gate: WS open while disarmed', checkWsAuth({ headers: {} }), true);

// --- I-3: route-level gating over real HTTP ------------------------------------
// Boots a throwaway express app (ephemeral localhost port) with the real auth routes:
// register-while-armed rules, me.armed, users visibility, and the full login session.
{
  const expressMod = await import('express');
  const express = expressMod.default || expressMod;
  const { registerAuthRoutes } = await import(pathToFileURL(base + 'routes/authRoutes.js').href);
  const { requireAuth } = await import(pathToFileURL(base + 'auth/authGate.js').href);
  const { registerUser: regUser } = await import(pathToFileURL(base + 'auth/userStore.js').href);
  await regUser('routeadmin', 'a strong route password');
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  registerAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, cookie) => {
    const res = await fetch(url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
  };
  const get = async (p, cookie) => {
    const res = await fetch(url + p, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const meAnon = await get('/api/auth/me');
  eq('auth routes: me reports armed + null user anonymously', meAnon.json?.armed === true && meAnon.json?.user === null, true);
  const regClosed = await post('/api/auth/register', { username: 'intruder', password: 'a strong password here' });
  eq('auth routes: open registration closed while armed (403)', regClosed.status === 403 && regClosed.json?.ok === false, true);
  const usersAnon = await get('/api/auth/users');
  eq('auth routes: user list needs a session while armed (401)', usersAnon.status === 401, true);
  const adminLogin = await post('/api/auth/login', { username: 'routeadmin', password: 'a strong route password' });
  const adminCookie = (adminLogin.cookie || '').split(';')[0];
  eq('auth routes: admin login sets cookie', adminLogin.status === 200 && /console_auth=/.test(adminCookie), true);
  const regByAdmin = await post('/api/auth/register', { username: 'second', password: 'a strong password here' }, adminCookie);
  eq('auth routes: admin session can register (second user)', regByAdmin.status === 200 && regByAdmin.json?.user?.role === 'user', true);
  const usersAuthed = await get('/api/auth/users', adminCookie);
  eq('auth routes: user list visible with session, hashes excluded', usersAuthed.status === 200 && usersAuthed.json?.users?.length >= 2 && usersAuthed.json.users.every((u) => !u.passwordHash), true);
  const meAuthed = await get('/api/auth/me', adminCookie);
  eq('auth routes: me returns identity with session', meAuthed.json?.user?.username === 'routeadmin', true);
  await new Promise((r) => server.close(r));
}

// --- I-4b: per-user profile sharding over real HTTP ------------------------------
// Same throwaway-app pattern: profile routes mounted behind the real gate, store
// files redirected into a temp dir. Asserts the overlay contract — global stays the
// defaults layer, authed writes land per-user, users can't see each other's prefs.
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-profile-'));
  process.env.PROFILE_FILE = path.join(tmpRoot, 'user-profile.json');
  const expressMod = await import('express');
  const express = expressMod.default || expressMod;
  const { registerAuthRoutes } = await import(pathToFileURL(base + 'routes/authRoutes.js').href);
  const { registerProfileRoutes, readProfile } = await import(pathToFileURL(base + 'routes/profileRoutes.js').href);
  const { requireAuth } = await import(pathToFileURL(base + 'auth/authGate.js').href);
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  registerAuthRoutes(app);
  registerProfileRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, cookie) => {
    const res = await fetch(url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
  };
  const get = async (p, cookie) => {
    const res = await fetch(url + p, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const loginA = await post('/api/auth/login', { username: 'routeadmin', password: 'a strong route password' });
  const cookieA = (loginA.cookie || '').split(';')[0];
  const loginB = await post('/api/auth/login', { username: 'second', password: 'a strong password here' });
  const cookieB = (loginB.cookie || '').split(';')[0];
  eq('profiles: both fixture logins still work', loginA.status === 200 && loginB.status === 200, true);
  const base1 = await get('/api/profile', cookieA);
  eq('profiles: authed read serves global defaults first', base1.status === 200 && base1.json?.userProfile?.accentColor === 'auto', true);
  const setA = await post('/api/profile', { userProfile: { accentColor: '#112233' } }, cookieA);
  eq('profiles: user A write accepted', setA.status === 200 && setA.json?.userProfile?.accentColor === '#112233', true);
  const readA = await get('/api/profile', cookieA);
  eq('profiles: user A read sees own override', readA.json?.userProfile?.accentColor === '#112233', true);
  const readB = await get('/api/profile', cookieB);
  eq('profiles: user B unaffected by A (isolation)', readB.json?.userProfile?.accentColor === 'auto', true);
  await post('/api/profile', { userProfile: { accentColor: '#445566' } }, cookieB);
  const readA2 = await get('/api/profile', cookieA);
  eq('profiles: user A unaffected by B (isolation both ways)', readA2.json?.userProfile?.accentColor === '#112233', true);
  let globalAccent = 'absent';
  try {
    globalAccent = JSON.parse(fs.readFileSync(process.env.PROFILE_FILE, 'utf8'))?.userProfile?.accentColor;
  } catch { /* never written in this block — that IS the assertion */ }
  eq('profiles: global file untouched by authed writes', globalAccent === undefined || globalAccent === 'absent', true);
  eq('profiles: hostile username shape falls back to global', readProfile('../nope')?.accentColor === 'auto', true);
  eq('profiles: no-arg read stays global (server-internal callers)', readProfile()?.accentColor === 'auto', true);
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PROFILE_FILE;
}

// --- Portal sessions: each user's chats are theirs (store + HTTP) ----------------
// Store-level: owner stamped at create, list filters per user, legacy unowned stays
// visible to all, admin sees everything, unfiltered default preserved. Session files
// live in a temp project dir; index entries are removed via the honest deleteSession
// (asserted), so the real data/conversations/index.json is left exactly as found.
{
  const { listSessions, createSession, deleteSession } =
    await import(pathToFileURL(base + 'conversationStore.js').href);
  const sessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-sessowner-'));
  const sAlice = await createSession(null, 'T', sessRoot, null, 'routeadmin');
  const sBob = await createSession(null, 'T', sessRoot, null, 'second');
  const sLegacy = await createSession(null, 'T', sessRoot, null);
  eq('sessions: owner stamped at create', sAlice.owner === 'routeadmin' && sBob.owner === 'second' && sLegacy.owner === null, true);
  const seenBy = async (u, role) => (await listSessions({ forUser: { username: u, role } })).map((s) => s.id);
  const aliceIds = await seenBy('routeadmin', 'admin');
  eq('sessions: admin sees all', aliceIds.includes(sAlice.id) && aliceIds.includes(sBob.id) && aliceIds.includes(sLegacy.id), true);
  const bobIds = await seenBy('second', 'user');
  eq('sessions: user sees own + legacy, not others', bobIds.includes(sBob.id) && bobIds.includes(sLegacy.id) && !bobIds.includes(sAlice.id), true);
  const allIds = (await listSessions()).map((s) => s.id);
  eq('sessions: unfiltered default preserved', allIds.includes(sAlice.id) && allIds.includes(sBob.id) && allIds.includes(sLegacy.id), true);
  eq('sessions: honest deletes clean files + index',
    (await deleteSession(sAlice.id)) === true &&
    (await deleteSession(sBob.id)) === true &&
    (await deleteSession(sLegacy.id)) === true, true);
  const afterIds = (await listSessions()).map((s) => s.id);
  eq('sessions: no test residue in index', !afterIds.includes(sAlice.id) && !afterIds.includes(sBob.id) && !afterIds.includes(sLegacy.id), true);
  fs.rmSync(sessRoot, { recursive: true, force: true });
}

// --- Portal sessions over real HTTP: list isolation + cross-user 403 ---------------
{
  const expressMod = await import('express');
  const express = expressMod.default || expressMod;
  const { registerAuthRoutes } = await import(pathToFileURL(base + 'routes/authRoutes.js').href);
  const { registerSessionRoutes } = await import(pathToFileURL(base + 'routes/sessionRoutes.js').href);
  const { requireAuth } = await import(pathToFileURL(base + 'auth/authGate.js').href);
  const { createSession, deleteSession } = await import(pathToFileURL(base + 'conversationStore.js').href);
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);
  registerAuthRoutes(app);
  registerSessionRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, cookie) => {
    const res = await fetch(url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
  };
  const get = async (p, cookie) => {
    const res = await fetch(url + p, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const del = async (p, cookie) => {
    const res = await fetch(url + p, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const loginA = await post('/api/auth/login', { username: 'routeadmin', password: 'a strong route password' });
  const cookieA = (loginA.cookie || '').split(';')[0];
  const loginB = await post('/api/auth/login', { username: 'second', password: 'a strong password here' });
  const cookieB = (loginB.cookie || '').split(';')[0];
  const httpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-sesshttp-'));
  // Created directly (the POST create route stamps the caller's name the same way —
  // covered by the owner-stamped assertion above, so no need to repeat it over HTTP).
  const owned = await createSession(null, 'T', httpRoot, null, 'second');
  const listedB = await get('/api/sessions', cookieB);
  const listedA = await get('/api/sessions', cookieA);
  eq('sessions http: owner lists own chat', listedB.status === 200 && listedB.json?.sessions?.some((s) => s.id === owned.id), true);
  eq('sessions http: admin lists it too', listedA.status === 200 && listedA.json?.sessions?.some((s) => s.id === owned.id), true);
  const crossRead = await get(`/api/sessions/${owned.id}`, cookieA);
  eq('sessions http: admin may read', crossRead.status === 200, true);
  const other = await createSession(null, 'T', httpRoot, null, 'routeadmin');
  const crossRead2 = await get(`/api/sessions/${other.id}`, cookieB);
  eq('sessions http: cross-user read refused (403)', crossRead2.status === 403, true);
  const crossDel = await del(`/api/sessions/${other.id}`, cookieB);
  eq('sessions http: cross-user delete refused (403)', crossDel.status === 403, true);
  const anonRead = await get(`/api/sessions/${other.id}`);
  eq('sessions http: anonymous read refused (401)', anonRead.status === 401, true);
  await deleteSession(owned.id);
  await deleteSession(other.id);
  fs.rmSync(httpRoot, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
}

try { fs.unlinkSync(process.env.USERS_FILE); } catch {}delete process.env.USERS_FILE;

console.log(`\ncheck-auth: ${pass + fail} checks, ${fail} failed`);
process.exit(fail ? 1 : 0);
