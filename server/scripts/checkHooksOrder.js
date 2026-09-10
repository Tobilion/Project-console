/**
 * checkHooksOrder.js — Rules-of-Hooks structural guard (2026-09-10, after the real
 * App.tsx blank-page crash: portal hooks were inserted between the !profileLoaded
 * early return and the lock-screen return, so fresh loads called 3 MORE hooks once
 * loading finished — "Rendered more hooks than during the previous render", with a
 * recovery button that re-rendered into the same trap).
 *
 * tsc/vite/eslint-less CI cannot see this bug class (the code typechecks and builds
 * fine), so this AST check runs in CI + pre-commit instead. For every component or
 * custom hook in the src tree (tsx files) it reports:
 *   1. a hook call ordered after a top-level early return/throw (the App crash), and
 *   2. a hook call inside a conditional/loop/logical branch (a latent count change).
 * Nested function bodies are separate hook scopes and are not descended into; event
 * handlers and lowercase helpers are not components and are skipped.
 *
 * Run:  node server/scripts/checkHooksOrder.js   (exit 1 + file:line list on violation)
 */
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', '..', 'src');

function collectTsx(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (/\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Callee name if this call is a hook (useState, React.useState, use()...), else null. */
function hookCalleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  const e = node.expression;
  if (ts.isIdentifier(e) && (/^use[A-Z]/.test(e.text) || e.text === 'use')) return e.text;
  if (ts.isPropertyAccessExpression(e) && (/^use[A-Z]/.test(e.name.text) || e.name.text === 'use')) {
    return e.name.text;
  }
  return null;
}

/** Does this subtree call a hook, without crossing into a nested function boundary? */
function subtreeCallsHook(node) {
  let found = null;
  function visit(n) {
    if (found || !n || typeof n.getStart !== 'function') return;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    if (hookCalleeName(n)) {
      found = hookCalleeName(n);
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/** Does this subtree contain a return/throw, without crossing a function boundary? */
function subtreeExits(node) {
  let found = false;
  function visit(n) {
    if (found || !n || typeof n.getStart !== 'function') return;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function isComponentName(name) {
  return /^[A-Z]/.test(name) || /^use[A-Z]/.test(name);
}

function checkFunction(file, name, body, findings) {
  if (!body || !ts.isBlock(body)) return;
  let seenExit = false;
  for (const stmt of body.statements) {
    // Hook calls inside conditionals/loops/logical branches at any depth here.
    checkConditionalHooks(stmt, false, file, name, findings);
    const hook = subtreeCallsHook(stmt);
    if (hook && seenExit) {
      const pos = file.getLineAndCharacterOfPosition(stmt.getStart());
      findings.push(`${path.relative(process.cwd(), file)}:${pos.line + 1} ${name}: '${hook}' called after an early return/throw`);
    }
    if (subtreeExits(stmt)) seenExit = true;
  }
}

// inBranch=true once inside if/loop/conditional/logical (but not across functions).
function checkConditionalHooks(node, inBranch, file, name, findings) {
  if (!node || typeof node.getStart !== 'function') return;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
  const isBranch =
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) ||
    (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
    (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken);
  const hook = hookCalleeName(node);
  if (hook && inBranch) {
    const pos = file.getLineAndCharacterOfPosition(node.getStart());
    findings.push(`${path.relative(process.cwd(), file)}:${pos.line + 1} ${name}: '${hook}' called inside a conditional branch`);
    return;
  }
  ts.forEachChild(node, (child) => checkConditionalHooks(child, inBranch || isBranch, file, name, findings));
}

const findings = [];
for (const file of collectTsx(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  ts.forEachChild(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isComponentName(node.name.text) && node.body) {
      checkFunction(sf, node.name.text, node.body, findings);
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !isComponentName(decl.name.text)) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
          checkFunction(sf, decl.name.text, init.body, findings);
        }
      }
    }
  });
}

if (findings.length > 0) {
  console.log('checkHooksOrder: FAIL — hooks-after-return or conditional hooks found:');
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log('checkHooksOrder: ok — no hooks-after-return or conditional hooks in src/**/*.tsx');
