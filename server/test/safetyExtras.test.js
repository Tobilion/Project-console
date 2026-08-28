import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { isGatedToolCall, isAskModeBlocked, resolveToolGate, toolGrantKey, GATED_TOOLS, ALWAYS_CONFIRM_TOOLS, getToolPermission } from '../toolGate';
import { isDestructiveCommand } from '../commandRisk';
import { createCheckpoint, pushCommandWithUpstream, performUndo } from '../gitSafety';

// Helper to create temp git repo
function makeRepo(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-safety-'));
  execSync('git init', {cwd: dir});
  execSync('git config user.email "t@t.com"', {cwd: dir});
  execSync('git config user.name "t"', {cwd: dir});
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  execSync('git add -A && git commit -m "init"', {cwd: dir});
  return dir;
}

test('gitSafety: createCheckpoint on non-git returns false', async ()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-nogit-'));
  const r = await createCheckpoint(dir, 'test');
  assert.equal(r.success, false);
  assert.match(r.message, /not a git repository/);
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: createCheckpoint creates commit with correct message', async ()=>{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
  const r = await createCheckpoint(dir, 'my trigger');
  assert.equal(r.success, true);
  assert.match(r.message, /console-checkpoint: before "my trigger"/);
  const log = execSync('git log -1 --pretty=%B', {cwd: dir, encoding:'utf8'});
  assert.match(log, /console-checkpoint: before "my trigger"/);
  // trigger with quotes should be handled via -F tempfile, not interpolated
  fs.writeFileSync(path.join(dir, 'c.txt'), 'y');
  const r2 = await createCheckpoint(dir, 'deploy "my site"');
  assert.equal(r2.success, true);
  const log2 = execSync('git log -1 --pretty=%B', {cwd: dir, encoding:'utf8'});
  assert.match(log2, /deploy "my site"/);
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: concurrent checkpoints both succeed via mutex', async ()=>{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'x.txt'), '1');
  fs.writeFileSync(path.join(dir, 'y.txt'), '2');
  const [r1, r2] = await Promise.all([
    createCheckpoint(dir, 'c1'),
    createCheckpoint(dir, 'c2')
  ]);
  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
  const log = execSync('git log --oneline -3', {cwd: dir, encoding:'utf8'});
  assert.match(log, /c1/);
  assert.match(log, /c2/);
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: pushCommandWithUpstream adds --set-upstream when needed', async ()=>{
  const dir = makeRepo();
  // No remote yet, should still return with origin fallback
  const cmd = await pushCommandWithUpstream(dir, 'git push');
  // Since no remote, it should add --set-upstream origin <branch>
  // branch is master or main depending on git init default
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {cwd: dir, encoding:'utf8'}).trim();
  assert.match(cmd, new RegExp(`--set-upstream (origin|\\S+) ${branch}`));
  // Add a fake remote and set upstream, then it should return unchanged
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: pushCommandWithUpstream on detached HEAD returns unchanged', async ()=>{
  const dir = makeRepo();
  execSync('git checkout --detach HEAD', {cwd: dir});
  const cmd = await pushCommandWithUpstream(dir, 'git push');
  assert.equal(cmd, 'git push');
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: performUndo refuses when last commit not checkpoint', async ()=>{
  const dir = makeRepo();
  const r = await performUndo(dir);
  assert.equal(r.success, false);
  assert.match(r.message, /not a Console checkpoint/);
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: performUndo succeeds after checkpoint', async ()=>{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
  await createCheckpoint(dir, 'to undo');
  const before = execSync('git rev-parse HEAD', {cwd: dir, encoding:'utf8'}).trim();
  const r = await performUndo(dir);
  assert.equal(r.success, true);
  const after = execSync('git rev-parse HEAD', {cwd: dir, encoding:'utf8'}).trim();
  assert.notEqual(before, after);
  fs.rmSync(dir, {recursive:true, force:true});
});

test('gitSafety: performUndo on non-git fails', async ()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-nogit2-'));
  const r = await performUndo(dir);
  assert.equal(r.success, false);
  fs.rmSync(dir, {recursive:true, force:true});
});

// toolGate
test('toolGate: GATED_TOOLS are gated', ()=>{
  for(const t of GATED_TOOLS){
    assert.equal(isGatedToolCall(t), true, t);
  }
});
test('toolGate: ALWAYS_CONFIRM are gated', ()=>{
  for(const t of ALWAYS_CONFIRM_TOOLS){
    assert.equal(isGatedToolCall(t), true, t);
  }
});
test('toolGate: executeCommand with risky or destructive is gated', ()=>{
  assert.equal(isGatedToolCall('executeCommand', {command: 'git push', risky: false}), true); // destructive via commandRisk
  assert.equal(isGatedToolCall('executeCommand', {command: 'git status', risky: false}), false);
  assert.equal(isGatedToolCall('executeCommand', {command: 'git status', risky: true}), true);
  assert.equal(isGatedToolCall('executeCommand', {command: 'rm -rf /', risky: false}), true);
});
test('toolGate: saveMemory only gated for judgment', ()=>{
  assert.equal(isGatedToolCall('saveMemory', {importance: 'judgment'}), true);
  assert.equal(isGatedToolCall('saveMemory', {importance: 'low'}), false);
  assert.equal(isGatedToolCall('saveMemory', {}), false);
  assert.equal(isGatedToolCall('readFile'), false);
});
test('toolGate: isAskModeBlocked blocks gated and unknown', ()=>{
  assert.equal(isAskModeBlocked('writeFile'), true);
  assert.equal(isAskModeBlocked('executeCommand'), true);
  assert.equal(isAskModeBlocked('readFile'), false);
  assert.equal(isAskModeBlocked('unknownToolX'), true);
});
test('toolGate: resolveToolGate returns allow for non-gated', async ()=>{
  const r = await resolveToolGate('readFile', {}, null, null);
  assert.equal(r.action, 'allow');
});
test('toolGate: resolveToolGate asks for gated without grant', async ()=>{
  const r = await resolveToolGate('writeFile', {}, '/tmp', new Set());
  assert.equal(r.action, 'ask');
});
test('toolGate: resolveToolGate allow when grant present', async ()=>{
  const key = toolGrantKey('/tmp', 'writeFile');
  const grants = new Set([key]);
  const r = await resolveToolGate('writeFile', {}, '/tmp', grants);
  // writeFile is gated but not ALWAYS, so grant should allow
  assert.equal(r.action, 'allow');
  assert.equal(r.autoApproved, true);
});
test('toolGate: ALWAYS_CONFIRM never auto-approved even with grant', async ()=>{
  const key = toolGrantKey('/tmp', 'runTests');
  const grants = new Set([key]);
  const r = await resolveToolGate('runTests', {}, '/tmp', grants);
  assert.equal(r.action, 'ask');
  assert.equal(r.grantKey, null);
});
test('toolGate: executeCommand destructive never auto-approved', async ()=>{
  const key = toolGrantKey('/tmp', 'executeCommand');
  const grants = new Set([key]);
  const r = await resolveToolGate('executeCommand', {command: 'git push', risky: false}, '/tmp', grants);
  assert.equal(r.action, 'ask');
});
test('toolGate: toolGrantKey format', ()=>{
  assert.equal(toolGrantKey('/a', 'b'), '/a::b');
});
test('toolGate: getToolPermission handles missing manifest and optional chaining', async ()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-perm-'));
  // No manifest -> undefined, should not throw
  assert.equal(await getToolPermission(dir, 'writeFile'), undefined);
  // Create manifest with no permissions
  fs.writeFileSync(path.join(dir, 'console.tools.json'), JSON.stringify({tools: []}));
  assert.equal(await getToolPermission(dir, 'writeFile'), undefined);
  // With permissions
  fs.writeFileSync(path.join(dir, 'console.tools.json'), JSON.stringify({tools: [], permissions: {writeFile: 'deny'}}));
  // Need to invalidate cache to re-read
  const { invalidatePluginManifest } = await import('../toolGate.js');
  invalidatePluginManifest(dir);
  assert.equal(await getToolPermission(dir, 'writeFile'), 'deny');
  assert.equal(await getToolPermission(dir, 'readFile'), undefined);
  // Test optional chaining safety: manifest null case already covered, ensure no throw
  assert.equal(await getToolPermission('', 'writeFile'), undefined);
  assert.equal(await getToolPermission(null, 'writeFile'), undefined);
  fs.rmSync(dir, {recursive:true, force:true});
});
test('commandRisk: tab whitespace still destructive', ()=>{
  assert.equal(isDestructiveCommand('git\tpush -f'), true);
  assert.equal(isDestructiveCommand('rm\t-rf\t/'), true);
  assert.equal(isDestructiveCommand('git push\t-f'), true);
});
