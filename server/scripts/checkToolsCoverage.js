/**
 * checkToolsCoverage.js — committed regression harness for the tool layer (Phase 9,
 * 2026-08-04). Asserts against the REAL modules — tools.js orchestrator + its leaf modules
 * (toolAllow/toolGate/toolProcess/toolSandbox/toolFileTools) — no server, no network,
 * seconds to run.
 *
 * Run:  npm run check-tools
 * Probe: node server/scripts/checkToolsCoverage.js --probe   (prints actual values, no asserts)
 *
 * Same calibration flow as checkMatcherCoverage.js/checkIndexerCoverage.js: batteries are
 * self-asserting pairs baked from the current verified behavior of the real modules; `--probe`
 * prints actuals so a deliberate behavior change can be re-baked. Run after ANY edit to
 * tools.js or its leaf modules.
 *
 * Batteries:
 *  - SANDBOX: createResolveSafe path-escape rejection (../, absolute outside, symlink,
 *    new-file ancestor walk, workspace projectId redirect).
 *  - ALLOW: isCommandAllowed allowlist (incl. posix/win env-var prefixes) + the
 *    dangerousPatterns blocklist still catching catastrophic commands.
 *  - GATE: resolveToolGate matrix — policy deny wins over grants, always-confirm tools
 *    (runTests/stopProcess/risky executeCommand) can never be auto-approved, session grants,
 *    allow-after-first-ask grantKey, saveMemory low-vs-judgment, custom risky plugin tools.
 *  - PRESENCE: createProjectTools() returns all 18 base tools + manifest-registered custom
 *    tools, findTestCommand markers (incl. truncated package.json).
 *  - FILEOPS: write/read/append/insert/list/find/search/probe/process round-trips on fixture
 *    files, binary reject, getGitStatus + undoLastChange (git checkpoint + journal restore).
 *  - GUARD: aiGuardrails syntaxCheck (parse diagnostics, null for non-JS/TS), validateToolCall
 *    (warns on syntax-breaking edits, null for clean/escape/non-code), restorePreImage
 *    (restore + clear, delete non-existent files, error on unknown), undoLastChange({path}).
 *  - VERIFY: verifyHarness hasTypeScriptProject, parseTscResult, schedule/cancelVerification.
 *  - DISTILLATION: input->command trigger pairing (inferTriggerFromInput intent matching + fallback).
 *  - EDIT: editFile exact match, whitespace-normalized fallback, multi-hunk all-or-nothing
 *    (failing hunk writes nothing).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import util from 'node:util';
import { fileURLToPath, pathToFileURL } from 'url';

const execAsync = util.promisify(exec);

const PROBE = process.argv.includes('--probe');
// Derived from this script's own location, not hardcoded to one machine/username (audit
// 2026-08-10 — see checkMatcherCoverage.js for the full rationale).
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;
const FIXTURE_ROOT = path.join(os.tmpdir(), 'console-tools-fixtures');

const tools = await import(pathToFileURL(base + 'tools.js').href);
const toolAllow = await import(pathToFileURL(base + 'toolAllow.js').href);
const toolGate = await import(pathToFileURL(base + 'toolGate.js').href);
const toolSandbox = await import(pathToFileURL(base + 'toolSandbox.js').href);
const toolFileTools = await import(pathToFileURL(base + 'toolFileTools.js').href);
const toolProcess = await import(pathToFileURL(base + 'toolProcess.js').href);
const dangerous = await import(pathToFileURL(base + 'dangerousPatterns.js').href);
const typed = await import(pathToFileURL(base + 'typedCommand.js').href);
const cmdDir = await import(pathToFileURL(base + 'commandDir.js').href);
const guardMod = await import(pathToFileURL(base + 'aiGuardrails.js').href);
const verify = await import(pathToFileURL(base + 'verifyHarness.js').href);
const distillation = await import(pathToFileURL(base + 'distillation.js').href);

let total = 0, failed = 0;
function eq(label, got, expect) {
  total++;
  const g = JSON.stringify(got);
  const e = JSON.stringify(expect);
  const ok = g === e;
  if (!ok) failed++;
  if (PROBE) console.log(`  ${String(label).padEnd(48)} -> ${g}`);
  else if (!ok) console.log(`  FAIL ${label}\n    expected: ${e}\n    got:      ${g}`);
}
function throws(label, fn) {
  total++;
  let ok = false;
  try {
    fn();
  } catch {
    ok = true;
  }
  if (!ok) failed++;
  if (PROBE) console.log(`  ${String(label).padEnd(48)} -> threw=${ok}`);
  else if (!ok) console.log(`  FAIL ${label}\n    expected: thrown error, got: no throw`);
}

const norm = (p) => String(p).split(path.sep).join('/');

async function git(cwd, args) {
  await execAsync(`git ${args.join(' ')}`, { cwd });
}

/** Builds the fixture tree under FIXTURE_ROOT; returns { proj, other }. */
async function buildFixtures() {
  await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
  const proj = path.join(FIXTURE_ROOT, 'proj');
  const other = path.join(FIXTURE_ROOT, 'other');
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok' } }));
  await fs.writeFile(path.join(proj, 'tsconfig.json'), '{ "compilerOptions": {} }');
  await fs.writeFile(path.join(proj, 'console.tools.json'), JSON.stringify({
    tools: [
      { name: 'greet', description: 'greet someone', command: 'echo hello {{name}}',
        args: { name: { type: 'string', description: 'who to greet' } }, risky: true },
    ],
    permissions: { writeFile: 'deny', insertAtLine: 'allow-after-first-ask' },
  }));
  await fs.writeFile(path.join(proj, 'src', 'app.js'),
    'function greet() { return "hi"; }\nconst answer = 42;\n');
  await fs.writeFile(path.join(proj, 'src', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
  await fs.writeFile(path.join(proj, 'src', 'edits.txt'), 'line one\nline two\nline three\n');
  await fs.writeFile(path.join(other, 'keep.txt'), 'outside');
  await git(proj, ['init', '-q']);
  await git(proj, ['add', '-A']);
  await git(proj, ['-c', 'user.name=C', '-c', 'user.email=C@C', 'commit', '-q', '-m', 'seed']);
  let symlinkOk = false;
  try {
    await fs.symlink(other, path.join(proj, 'evil-link'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkOk = true;
  } catch {
    symlinkOk = false;
  }
  return { proj, other, symlinkOk };
}

console.log('Building fixtures...');
const { proj, other, symlinkOk } = await buildFixtures();
const project = {
  id: 'p1', name: 'proj', path: proj,
  config: { entries: [{ action: 'npm test' }] },
  contextFiles: ['CLAUDE.md'],
  parsedKnowledge: { stack: 'Node.js', commands: 'npm run dev' },
};

try {
  console.log('\n=== SANDBOX (createResolveSafe) ===');
  const rs = toolSandbox.createResolveSafe(proj);
  eq('resolves within root', norm(rs('src/app.js')), norm(path.join(proj, 'src', 'app.js')));
  eq('empty resolves to root', norm(rs('')), norm(proj));
  throws('parent-dir escape throws', () => rs('../outside.txt'));
  throws('absolute path outside throws', () => rs(path.join(other, 'keep.txt')));
  eq('new-file nested ancestor ok', norm(rs('newdir/deep/new.txt')), norm(path.join(proj, 'newdir', 'deep', 'new.txt')));
  throws('new-file parent escape throws', () => rs('../new.txt'));
  const rs2 = toolSandbox.createResolveSafe(proj, [{ id: 'other', path: other }]);
  eq('workspace projectId redirects root', norm(rs2('keep.txt', 'other')), norm(path.join(other, 'keep.txt')));
  eq('unknown projectId falls back to root', norm(rs2('src/app.js', 'missing-id')), norm(path.join(proj, 'src', 'app.js')));
  if (symlinkOk) throws('symlink escape throws', () => rs('evil-link/keep.txt'));
  else console.log('  (skipped symlink battery — fixture symlink could not be created on this platform)');

  console.log('\n=== ALLOW (isCommandAllowed + blocklist) ===');
  eq('npm allowed', toolAllow.isCommandAllowed('npm run dev'), true);
  eq('node allowed', toolAllow.isCommandAllowed('node server/index.js'), true);
  eq('posix env prefix tolerated', toolAllow.isCommandAllowed('PORT=3001 npm run dev'), true);
  eq('win env prefix tolerated', toolAllow.isCommandAllowed('set PORT=3001&& npm run dev'), true);
  eq('cmd.exe suffix normalized', toolAllow.isCommandAllowed('C:\\npm.cmd install'), true);
  eq('non-allowlisted exe rejected', toolAllow.isCommandAllowed('rm -rf /'), false);
  eq('empty string rejected', toolAllow.isCommandAllowed(''), false);
  eq('non-string rejected', toolAllow.isCommandAllowed(null), false);
  eq('blocklist catches rm -rf /', dangerous.isCommandBlocked('rm -rf /'), true);
  eq('blocklist catches force-push main', dangerous.isCommandBlocked('git push --force origin main'), true);
  eq('blocklist leaves npm run dev alone', dangerous.isCommandBlocked('npm run dev'), false);

  console.log('\n=== TYPED (extractCommandLine typed-command gate) ===');
  eq('typed exact allowlisted', typed.extractCommandLine('npm run dev'), 'npm run dev');
  eq('typed quoted', typed.extractCommandLine('"git status"'), 'git status');
  eq('typed trailing please', typed.extractCommandLine('git status please'), 'git status');
  eq('typed single-token not allowlisted', typed.extractCommandLine('status'), null);
  eq('typed prefix determiner rejected', typed.extractCommandLine('run the site'), null);
  eq('typed prefix my rejected', typed.extractCommandLine('run my project'), null);
  eq('typed prefix execute the rejected', typed.extractCommandLine('execute the plan'), null);
  eq('typed prefix non-exec rejected', typed.extractCommandLine('run banana split'), null);
  // Natural-language collision guard (Phase 2, 2026-08-11): find/sort/where resolve to real
  // Windows binaries, so plain-word sentences starting with them must reach the matcher.
  eq('typed sentence find rejected', typed.extractCommandLine('find duplicate files'), null);
  eq('typed sentence sort rejected', typed.extractCommandLine('sort these files by type'), null);
  eq('typed sentence where rejected', typed.extractCommandLine('where are my files'), null);
  eq('typed sentence convert rejected', typed.extractCommandLine('convert 5 km to miles'), null);
  eq('typed sentence convert with digits rejected', typed.extractCommandLine('convert 2 liters to cups'), null);
  eq('typed find with glob still runs', typed.extractCommandLine('find . -name "*.js"'), 'find . -name "*.js"');
  eq('typed sort with file arg still runs', typed.extractCommandLine('sort data.csv'), 'sort data.csv');
  const npmOnPath = typed.resolveExecutableOnPath('npm');
  eq('resolveExecutableOnPath npm', npmOnPath, true);
  if (npmOnPath) {
    // PATH-resolution rows only run where npm is actually on PATH (any machine with node
    // installed) — a machine without it must not fail the committed battery.
    eq('typed prefix PATH exec', typed.extractCommandLine('run npm dev'), 'npm dev');
    eq('typed exact PATH exec', typed.extractCommandLine('npm --version'), 'npm --version');
  } else {
    console.log('  (skipped PATH-resolution rows — npm not on PATH)');
  }

  console.log('\n=== COMMAND-DIR (wrapper sub-package rule) ===');
  const wrapperRoot = path.join(FIXTURE_ROOT, 'wrapper');
  await fs.mkdir(path.join(wrapperRoot, 'app'), { recursive: true });
  await fs.writeFile(path.join(wrapperRoot, 'app', 'package.json'), JSON.stringify({ scripts: { dev: 'ng serve', start: 'ng serve' } }));
  const wrapperProj = { path: wrapperRoot, codebaseIndex: { keyFiles: {} } };
  eq('commandDir wrapper sub', await cmdDir.getCommandDir(wrapperProj), 'app');
  eq('commandDir wrapper scripts', await cmdDir.getCommandDirScripts(wrapperProj), { dev: 'ng serve', start: 'ng serve' });
  const normalProj = { path: proj, codebaseIndex: { keyFiles: { 'package.json': '{"scripts":{"test":"echo ok"}}' } } };
  eq('commandDir normal null', await cmdDir.getCommandDir(normalProj), null);
  eq('commandDir scripts normal null', await cmdDir.getCommandDirScripts(normalProj), null);
  const workspaceProj = { path: wrapperRoot, codebaseIndex: { keyFiles: { 'package.json': '{"workspaces":["packages/*"]}' } } };
  eq('commandDir workspace root null', await cmdDir.getCommandDir(workspaceProj), null);
  await fs.mkdir(path.join(wrapperRoot, 'lib'), { recursive: true });
  await fs.writeFile(path.join(wrapperRoot, 'lib', 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  const monoProj = { path: wrapperRoot, codebaseIndex: { keyFiles: {} } };
  eq('commandDir two subs null', await cmdDir.getCommandDir(monoProj), null);
  // Task 0c (2026-08-11): the root ALSO has its own package.json — placeholder/lint-only scripts
  // must not disqualify the wrapper rule when exactly one sub-package carries a real launcher.
  const ambigRoot = path.join(FIXTURE_ROOT, 'wrapper-ambig');
  await fs.mkdir(path.join(ambigRoot, 'app'), { recursive: true });
  await fs.writeFile(path.join(ambigRoot, 'app', 'package.json'), JSON.stringify({ scripts: { dev: 'ng serve', start: 'ng serve' } }));
  const ambigLintProj = { path: ambigRoot, codebaseIndex: { keyFiles: { 'package.json': '{"scripts":{"lint":"eslint ."}}' } } };
  eq('commandDir ambig-root resolves to sub', await cmdDir.getCommandDir(ambigLintProj), 'app');
  eq('commandDir ambig-root scripts', await cmdDir.getCommandDirScripts(ambigLintProj), { dev: 'ng serve', start: 'ng serve' });
  const ambigLauncherProj = { path: ambigRoot, codebaseIndex: { keyFiles: { 'package.json': '{"scripts":{"start":"ng serve"}}' } } };
  eq('commandDir root launcher wins', await cmdDir.getCommandDir(ambigLauncherProj), null);
  const noLaunchRoot = path.join(FIXTURE_ROOT, 'wrapper-nolaunch');
  await fs.mkdir(path.join(noLaunchRoot, 'pkg'), { recursive: true });
  await fs.writeFile(path.join(noLaunchRoot, 'pkg', 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const noLaunchProj = { path: noLaunchRoot, codebaseIndex: { keyFiles: { 'package.json': '{"scripts":{"lint":"eslint ."}}' } } };
  eq('commandDir non-launcher root + sub no-launcher null', await cmdDir.getCommandDir(noLaunchProj), null);

  console.log('\n=== GATE (resolveToolGate matrix) ===');
  const grants = new Set([toolGate.toolGrantKey(proj, 'insertAtLine')]);
  eq('ungated tool allows', await toolGate.resolveToolGate('readFile', {}, proj, null), { action: 'allow' });
  eq('executeCommand non-risky allows', await toolGate.resolveToolGate('executeCommand', {}, proj, null), { action: 'allow' });
  eq('policy deny wins', await toolGate.resolveToolGate('writeFile', {}, proj, null), { action: 'deny' });
  eq('policy deny wins over grant', await toolGate.resolveToolGate('writeFile', {}, proj, grants), { action: 'deny' });
  eq('allow-after-first-ask asks + grantKey', await toolGate.resolveToolGate('insertAtLine', {}, proj, null),
    { action: 'ask', grantKey: toolGate.toolGrantKey(proj, 'insertAtLine') });
  eq('grant auto-approves gated file tool', await toolGate.resolveToolGate('insertAtLine', {}, proj, grants),
    { action: 'allow', autoApproved: true });
  eq('always-confirm ignores grant', await toolGate.resolveToolGate('runTests', {}, proj, grants),
    { action: 'ask', grantKey: null });
  eq('stopProcess always asks', await toolGate.resolveToolGate('stopProcess', {}, proj, grants),
    { action: 'ask', grantKey: null });
  eq('risky executeCommand always asks', await toolGate.resolveToolGate('executeCommand', { risky: true }, proj, grants),
    { action: 'ask', grantKey: null });
  eq('saveMemory low ungated', await toolGate.resolveToolGate('saveMemory', { importance: 'low' }, proj, null), { action: 'allow' });
  eq('saveMemory judgment asks', await toolGate.resolveToolGate('saveMemory', { importance: 'judgment' }, proj, null),
    { action: 'ask', grantKey: null });
  const dangerGrants = new Set([toolGate.toolGrantKey(proj, 'danger')]);
  toolGate.CUSTOM_RISKY_TOOLS.set(proj, new Set(['danger']));
  try {
    eq('custom risky tool asks without grant', await toolGate.resolveToolGate('danger', {}, proj, null),
      { action: 'ask', grantKey: null });
    eq('custom risky tool grantable', await toolGate.resolveToolGate('danger', {}, proj, dangerGrants),
      { action: 'allow', autoApproved: true });
  } finally {
    toolGate.CUSTOM_RISKY_TOOLS.delete(proj);
  }
  eq('isCustomToolRisky unregistered name', toolGate.isCustomToolRisky('nope', proj), false);
  eq('isGatedToolCall file tool', toolGate.isGatedToolCall('writeFile', {}), true);
  eq('isGatedToolCall readFile', toolGate.isGatedToolCall('readFile', {}), false);
  eq('isGatedToolCall saveMemory low', toolGate.isGatedToolCall('saveMemory', { importance: 'low' }), false);

  console.log('\n=== PRESENCE (createProjectTools + findTestCommand) ===');
  const baseTools = await tools.createProjectTools(project);
  const names = ['readFile', 'writeFile', 'editFile', 'findFiles', 'insertAtLine', 'appendToFile',
    'searchCode', 'listFiles', 'getProjectInfo', 'getGitStatus', 'undoLastChange', 'saveMemory',
    'listProcesses', 'stopProcess', 'probeUrl', 'runTests', 'webSearch', 'deepResearch'];
  eq('all 18 base tools present', names.filter((n) => typeof baseTools[n] === 'function').length, 18);
  eq('custom manifest tool present', typeof baseTools.greet, 'function');
  eq('builtin not overridden by manifest', typeof baseTools.readFile, 'function');
  eq('createProjectTools re-exports resolveToolGate', typeof tools.resolveToolGate, 'function');
  eq('createProjectTools re-exports findTestCommand', typeof tools.findTestCommand, 'function');
  const customRisky = toolGate.CUSTOM_RISKY_TOOLS.get(proj);
  eq('manifest risky tool registered', customRisky && customRisky.has('greet'), true);
  eq('findTestCommand npm', toolProcess.findTestCommand({ codebaseIndex: { keyFiles: { 'package.json': '{"scripts":{"test":"jest"}}' } } }), 'npm test');
  eq('findTestCommand cargo', toolProcess.findTestCommand({ codebaseIndex: { keyFiles: { 'cargo.toml': 'x' } } }), 'cargo test');
  eq('findTestCommand go', toolProcess.findTestCommand({ codebaseIndex: { keyFiles: { 'go.mod': 'x' } } }), 'go test ./...');
  eq('findTestCommand python', toolProcess.findTestCommand({ codebaseIndex: { keyFiles: { 'pyproject.toml': 'x' } } }), 'python -m pytest');
  eq('findTestCommand truncated package.json', toolProcess.findTestCommand(
    { codebaseIndex: { keyFiles: { 'package.json': '{"scripts":{"test":"jest"}}\n... (truncated)' } } }), 'npm test');
  eq('findTestCommand none', toolProcess.findTestCommand({ codebaseIndex: { keyFiles: {} } }), null);
  eq('re-exports intact: ALLOWED_COMMANDS', tools.ALLOWED_COMMANDS.includes('npm'), true);
  eq('re-exports intact: GATED_TOOLS', tools.GATED_TOOLS.has('editFile'), true);
  eq('re-exports intact: ALWAYS_CONFIRM_TOOLS', tools.ALWAYS_CONFIRM_TOOLS.has('runTests'), true);

  console.log('\n=== FILEOPS (round-trips through the real tools) ===');
  const r1 = await baseTools.writeFile({ path: 'src/app.js', content: 'function greet() { return "hi"; }\nconst answer = 42;\n' });
  eq('writeFile ok', r1.success, true);
  eq('writeFile wrote to disk', norm(r1.data), 'Written src/app.js');
  eq('writeFile missing content errors', (await baseTools.writeFile({ path: 'src/x.js' })).success, false);
  eq('writeFile missing path errors', (await baseTools.writeFile({ content: 'x' })).success, false);
  const r2 = await baseTools.readFile({ path: 'src/app.js' });
  eq('readFile round-trip', r2, { success: true, data: 'function greet() { return "hi"; }\nconst answer = 42;\n' });
  eq('readFile missing errors', (await baseTools.readFile({ path: 'src/nope.js' })).success, false);
  eq('readFile binary rejected', (await baseTools.readFile({ path: 'src/blob.bin' })).success, false);
  eq('appendToFile creates', norm((await baseTools.appendToFile({ path: 'src/log.txt', content: 'first' })).data),
    'Appended to src/log.txt');
  eq('appendToFile continues', norm((await baseTools.appendToFile({ path: 'src/log.txt', content: 'second' })).data),
    'Appended to src/log.txt');
  eq('appendToFile content', await fs.readFile(path.join(proj, 'src', 'log.txt'), 'utf-8'), 'first\nsecond\n');
  const ins = await baseTools.insertAtLine({ path: 'src/log.txt', line: 1, content: 'zero' });
  eq('insertAtLine ok', ins.success, true);
  eq('insertAtLine content', await fs.readFile(path.join(proj, 'src', 'log.txt'), 'utf-8'), 'zero\nfirst\nsecond\n');
  eq('insertAtLine bad line errors', (await baseTools.insertAtLine({ path: 'src/log.txt', line: 0, content: 'x' })).success, false);
  const listed = await baseTools.listFiles({});
  eq('listFiles includes fixtures', listed.success && listed.data.some((p) => norm(p) === 'src/app.js'), true);
  const found = await baseTools.findFiles({ pattern: 'edits' });
  eq('findFiles pattern', found.success && found.data.some((p) => norm(p) === 'src/edits.txt'), true);
  eq('findFiles missing pattern errors', (await baseTools.findFiles({})).success, false);
  const found2 = await baseTools.findFiles({ pattern: 'no-such-file-anywhere' });
  eq('findFiles no match -> empty', found2, { success: true, data: [] });
  const search = await baseTools.searchCode({ pattern: 'greet' });
  eq('searchCode finds line', search.success && search.data.some((m) => norm(m.file) === 'src/app.js' && m.line === 1), true);
  eq('searchCode ReDoS rejected', (await baseTools.searchCode({ pattern: '(a+b+)+' })).success, false);
  eq('searchCode missing pattern errors', (await baseTools.searchCode({})).success, false);
  const info = await baseTools.getProjectInfo({});
  eq('getProjectInfo shape', info.success && info.data, {
    id: 'p1', name: 'proj', path: proj, configEntries: 1, docFiles: 1, stack: 'Node.js', commandsFound: 'npm run dev',
    symbolGraph: '(no symbols indexed)',
  });
  const mem = await baseTools.saveMemory({ content: 'user prefers dark mode', importance: 'low' });
  eq('saveMemory ok', mem.success, true);
  const memFile = await fs.readFile(path.join(proj, '.console', 'memory.md'), 'utf-8');
  eq('saveMemory wrote memory.md', memFile.includes('user prefers dark mode'), true);
  eq('saveMemory dup skipped', (await baseTools.saveMemory({ content: 'user prefers dark mode', importance: 'low' })).data,
    'Already remembered (duplicate skipped).');
  eq('saveMemory bad importance errors', (await baseTools.saveMemory({ content: 'x', importance: 'high' })).success, false);
  eq('listProcesses empty', await baseTools.listProcesses({}), { success: true, data: [] });
  eq('stopProcess no-op', await baseTools.stopProcess({}), { success: true, data: 'No running process for this project.' });
  eq('probeUrl missing url errors', (await baseTools.probeUrl({})).success, false);
  eq('probeUrl refuses public URL', (await baseTools.probeUrl({ url: 'https://example.com' })).success, false);

  console.log('\n=== GUARD (aiGuardrails syntax check + edit journal) ===');
  const badContent = 'function broken( {\n';
  const goodContent = 'function fine() {}\n';
  const seedAppJs = 'function greet() { return "hi"; }\nconst answer = 42;\n';
  eq('syntaxCheck ok', await guardMod.syntaxCheck(goodContent, '.js'), { ok: true });
  const badCheck = await guardMod.syntaxCheck(badContent, '.js');
  eq('syntaxCheck broken flags', badCheck && badCheck.ok === false && typeof badCheck.line === 'number' && badCheck.message.length > 0, true);
  eq('syntaxCheck non-code ext -> null', await guardMod.syntaxCheck(goodContent, '.md'), null);
  eq('syntaxCheck py -> null (regex path)', await guardMod.syntaxCheck('def run():\n    pass', '.py'), null);
  eq('validateToolCall clean edit -> null', await guardMod.validateToolCall('editFile', { path: 'src/app.js', oldString: 'function greet', newString: 'function greet2' }, proj), null);
  eq('validateToolCall non-file tool -> null', await guardMod.validateToolCall('readFile', { path: 'src/app.js' }, proj), null);
  eq('validateToolCall escape path -> null', await guardMod.validateToolCall('writeFile', { path: '../outside.js', content: badContent }, proj), null);
  eq('validateToolCall edits.txt -> null (non-JS)', await guardMod.validateToolCall('editFile', { path: 'src/edits.txt', oldString: 'line two', newString: 'bad' }, proj), null);
  const broken = await guardMod.validateToolCall('editFile', { path: 'src/app.js', oldString: seedAppJs, newString: 'function broken( {\n' }, proj);
  eq('validateToolCall broken edit warns', broken && broken.ok === true && String(broken.warning).includes('SYNTAX WARNING in src/app.js'), true);
  const restored = await guardMod.restorePreImage(path.join(proj, 'src', 'app.js'), proj);
  eq('restorePreImage restores + clears', restored, { success: true, data: 'Restored src/app.js from the pre-edit journal.' });
  eq('restore removed clears journal entry', await guardMod.restorePreImage(path.join(proj, 'src', 'app.js'), proj), { success: false, error: 'No journaled pre-edit content for src/app.js.' });
  const newBad = await guardMod.validateToolCall('writeFile', { path: 'src/newbad.js', content: badContent }, proj);
  eq('validateToolCall broken new-file warns', newBad && newBad.ok === true && String(newBad.warning).includes('SYNTAX WARNING in src/newbad.js'), true);
  const removed = await guardMod.restorePreImage(path.join(proj, 'src', 'newbad.js'), proj);
  eq('restorePreImage deletes non-existent-file', removed, { success: true, data: 'Removed src/newbad.js (it did not exist before the edit).' });
  eq('newbad.js is gone', await fs.stat(path.join(proj, 'src', 'newbad.js')).catch(() => null), null);
  eq('restorePreImage unknown path errors', await guardMod.restorePreImage(path.join(proj, 'src', 'app.js'), proj), { success: false, error: 'No journaled pre-edit content for src/app.js.' });
  // Re-populate the journal entry for app.js so the undoLastChange({path}) flow has something to restore.
  eq('validateToolCall re-records pre-image', (await guardMod.validateToolCall('editFile', { path: 'src/app.js', oldString: seedAppJs, newString: badContent }, proj))?.ok === true, true);
  eq('undoLastChange {path} journal restore', (await baseTools.undoLastChange({ path: 'src/app.js' })), { success: true, message: 'Restored src/app.js from the pre-edit journal.' });
  eq('undoLastChange {path} second call errors', (await baseTools.undoLastChange({ path: 'src/app.js' })), { success: false, message: 'No journaled pre-edit content for src/app.js.' });
  const seedApp = await fs.readFile(path.join(proj, 'src', 'app.js'), 'utf-8');
  eq('undoLastChange {path} left seed content', seedApp === seedAppJs, true);

  console.log('\n=== VERIFY (verifyHarness parse policy + debounce) ===');
  eq('hasTypeScriptProject true (tsconfig)', await verify.hasTypeScriptProject(proj), true);
  eq('hasTypeScriptProject false (no tsconfig)', await verify.hasTypeScriptProject(other), false);
  eq('hasTypeScriptProject null root', await verify.hasTypeScriptProject(null), false);
  const sample = 'src/a.ts:1:2 - error TS1234: bad\nanother line\n2 error(s)';
  const parsed = verify.parseTscResult(1, sample, '');
  eq('parseTscResult errors from summary', parsed.errors, 2);
  eq('parseTscResult exitCode', parsed.exitCode, 1);
  const noSummary = 'src/a.ts:1:2 - error TS1234: bad\nsrc/b.ts:5:1 - error TS5678: worse';
  eq('parseTscResult fallback counts TS lines', verify.parseTscResult(1, noSummary, '').errors, 2);
  eq('parseTscResult zero errors', verify.parseTscResult(0, '', '').errors, 0);
  eq('scheduleVerification no-throw on undefined root', (() => { verify.scheduleVerification(undefined); return true; })(), true);
  eq('cancelVerification idempotent', (() => { verify.cancelVerification(proj); verify.cancelVerification(proj); return true; })(), true);

  console.log('\n=== DISTILLATION (input->command trigger pairing) ===');
  eq('trigger pairs dev intent', distillation.inferTriggerFromInput('how do I start the dev server', 'dev'), 'start the dev server');
  eq('trigger pairs start script to dev intent', distillation.inferTriggerFromInput('start the server', 'start'), 'start the dev server');
  eq('trigger pairs test intent', distillation.inferTriggerFromInput('run the tests', 'test'), 'run the tests');
  eq('trigger pairs build intent', distillation.inferTriggerFromInput('build the project', 'build'), 'build the project');
  eq('trigger pairs lint intent', distillation.inferTriggerFromInput('run lint please', 'lint'), 'run the linter');
  eq('trigger mismatch falls back', distillation.inferTriggerFromInput('run the tests', 'dev'), 'run dev');
  eq('trigger empty input fallback', distillation.inferTriggerFromInput('', 'lint'), 'run lint');
  eq('trigger custom script fallback', distillation.inferTriggerFromInput('start the server', 'custom'), 'run custom');

  console.log('\n=== EDIT (editFile exact / fallback / multi-hunk) ===');
  eq('editFile exact', await baseTools.editFile({ path: 'src/edits.txt', oldString: 'line two', newString: 'LINE TWO' }),
    { success: true, data: 'Edited src/edits.txt' });
  eq('editFile whitespace fallback', (await baseTools.editFile({ path: 'src/edits.txt', oldString: 'line   three', newString: 'line THREE' })).data,
    'Edited src/edits.txt (matched via whitespace-normalized fallback — verify the result looks right)');
  eq('editFile identical replacement errors', (await baseTools.editFile({ path: 'src/edits.txt', oldString: 'LINE TWO', newString: 'LINE TWO' })).success, false);
  const multiOk = await baseTools.editFile({ path: 'src/edits.txt', oldStrings: ['LINE TWO', 'line THREE'], newStrings: ['X', 'Y'] });
  eq('editFile multi-hunk ok', multiOk, { success: true, data: 'Edited src/edits.txt (2 hunks)' });
  const multiFail = await baseTools.editFile({ path: 'src/edits.txt', oldStrings: ['X', 'NOPE'], newStrings: ['Z', 'W'] });
  eq('editFile multi-hunk failure names hunk', multiFail.success === false && multiFail.error.includes('Hunk 2 of 2'), true);
  const afterFail = await fs.readFile(path.join(proj, 'src', 'edits.txt'), 'utf-8');
  eq('multi-hunk failure writes nothing', afterFail.includes('X') && !afterFail.includes('Z'), true);
  eq('editFile unmatched single errors', (await baseTools.editFile({ path: 'src/edits.txt', oldString: 'NOT THERE', newString: 'x' })).success, false);
  eq('editFile missing file errors', (await baseTools.editFile({ path: 'src/nope.txt', oldString: 'a', newString: 'b' })).success, false);
  eq('editFile uneven arrays error', (await baseTools.editFile({ path: 'src/edits.txt', oldStrings: ['a'], newStrings: ['b', 'c'] })).success, false);
  eq('undoLastChange refuses non-checkpoint', (await baseTools.undoLastChange({})).success, false);

  console.log('\n=== GIT (getGitStatus against the real fixture repo) ===');
  await git(proj, ['add', '-A']);
  await git(proj, ['-c', 'user.name=C', '-c', 'user.email=C@C', 'commit', '-q', '-m', 'seed2']);
  eq('getGitStatus clean', await baseTools.getGitStatus({}), { success: true, data: '(clean)' });
} finally {
  await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
  console.log('\nFixtures cleaned up.');
}

if (PROBE) {
  console.log('\nProbe complete — bake the desired outputs into the expectations.');
  process.exit(0);
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
