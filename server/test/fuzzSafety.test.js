// Property/fuzz tests for the safety-critical leaf modules (audit 2026-08-26).
//
// These modules had zero automated coverage and are exactly the code a future edit could
// silently weaken: isSafeParamValue (command-injection gate for parameter substitution),
// urlSafety (SSRF guards), commandRisk + dangerousPatterns (the destructive-command layers),
// and toolAllow (the executable allowlist). Property tests catch shapes no hand-written row
// ever enumerated. Run via `npm test` alongside matcher.test.js.
//
// Conventions: deterministic seeds (fast-check defaults to a fixed seed per run unless
// --runInBand changes it; numRuns is bounded so the suite stays seconds, not minutes), pure
// properties only, no timers, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { isSafeParamValue, extractParamValue, substituteParams } from '../paramCommand';
import { isSafeExternalUrl, isProbeableUrl } from '../urlSafety';
import { isDestructiveCommand } from '../commandRisk';
import { isCommandBlocked } from '../dangerousPatterns';
import { isCommandAllowed, ALLOWED_COMMANDS } from '../toolAllow';

// ---- isSafeParamValue -------------------------------------------------------

const METACHARS = ['&', ';', '|', '`', '$', '<', '>', '\r', '\n', '"', "'"];
// Backslash is deliberately ALLOWED (Windows paths) — see paramCommand.js's comment on
// UNSAFE_VALUE_RE. This corpus guards that decision: nothing in it may ever start tripping.
const SAFE_CHAR_CORPUS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-/\\,:=+@()[]{}';

test('[FUZZ isSafeParamValue] any string containing a shell metacharacter is rejected', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (s) => {
      const hasMeta = METACHARS.some((c) => s.includes(c));
      assert.equal(isSafeParamValue(s), !hasMeta && s.length > 0 && s.length <= 300, `input: ${JSON.stringify(s)}`);
    }),
    { numRuns: 1000, seed: 0x5afe0001 },
  );
});

test('[FUZZ isSafeParamValue] safe-corpus strings are accepted within the length cap', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...SAFE_CHAR_CORPUS.split('')), { minLength: 1, maxLength: 250 }),
      (chars) => {
        const s = chars.join('');
        assert.equal(isSafeParamValue(s), true, `input: ${JSON.stringify(s)}`);
      },
    ),
    { numRuns: 300, seed: 0x5afe0002 },
  );
});

test('[FUZZ isSafeParamValue] backslash remains allowed and never flips to rejected', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom('\\', 'a', '1', '/', '.', '_', '-'), { minLength: 1, maxLength: 100 }), (chars) => {
      assert.equal(isSafeParamValue(chars.join('')), true);
    }),
    { numRuns: 200, seed: 0x5afe0003 },
  );
});

test('[FUZZ isSafeParamValue] non-strings and empty strings are rejected', () => {
  fc.assert(
    fc.property(fc.oneof(fc.integer(), fc.boolean(), fc.object(), fc.string({ minLength: 0, maxLength: 0 })), (v) => {
      assert.equal(isSafeParamValue(v), false);
    }),
    { numRuns: 200, seed: 0x5afe0004 },
  );
});

// ---- urlSafety (SSRF guards) -------------------------------------------------

// Every private/loopback/APIPA shape in every textual encoding the WHATWG URL parser
// canonicalizes (dotted decimal, decimal integer, hex, octal, dotted-encoded components,
// truncated forms, IPv6 loopback/mapped/link-local). These are verified to normalize to a
// blocklist-matching hostname on Node >= 20 — the property pins that behavior.
const PRIVATE_HOST_SHAPES = [
  '127.0.0.1', '127.1', '127.0.1', '2130706433', '0x7f000001', '0177.0.0.1', '017700000001',
  '0x7f.1', '10.0.0.1', '10.1', '167772161', '0x0a000001', '192.168.0.1', '3232235521',
  '0xc0a80001', '169.254.169.254', '2852039166', '172.16.0.1', '172.31.255.254', '0.0.0.0', '0.0.0.1',
  '::1', '[::1]', '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]', 'fe80::1', '[fe80::1]',
  'fe80::1%25eth0', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '0:0:0:0:0:ffff:7f00:1',
  '[0:0:0:0:0:ffff:7f00:1]', '::ffff:7f00:1', 'localhost', 'LOCALHOST', 'LocalHost',
  'localhost.localdomain', 'localhost.', '127.0.0.1.nip.io',
];

test('[FUZZ urlSafety] every private/loopback/APIPA encoding is rejected for external fetch', () => {
  for (const host of PRIVATE_HOST_SHAPES) {
    for (const protocol of ['http:', 'https:']) {
      let url;
      try {
        url = new URL(`${protocol}//${host}/`);
      } catch {
        // An unparseable host can never be fetched — treat as rejected.
        continue;
      }
      assert.equal(isSafeExternalUrl(url), false, `${protocol}//${host} (hostname ${url.hostname}) must be rejected`);
    }
  }
});

test('[FUZZ urlSafety] every random private IPv4 (dotted + integer + hex + octal) is rejected', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 0xffffffffn }), (n) => {
      const i = Number(n);
      const dotted = `${i >>> 24}.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      const shapes = [dotted, String(i), `0x${i.toString(16)}`, `0${i.toString(8)}`];
      for (const host of shapes) {
        let url;
        try {
          url = new URL(`https://${host}/`);
        } catch {
          continue;
        }
        const first = url.hostname.split('.')[0];
        const isPrivate =
          first === 'localhost' ||
          url.hostname.startsWith('127.') ||
          url.hostname.startsWith('10.') ||
          url.hostname.startsWith('192.168.') ||
          url.hostname.startsWith('169.254.') ||
          url.hostname.startsWith('0.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
        if (isPrivate) {
          assert.equal(isSafeExternalUrl(url), false, `${host} -> ${url.hostname} is private and must be rejected`);
        } else {
          assert.equal(isSafeExternalUrl(url), true, `${host} -> ${url.hostname} is public and must be accepted`);
        }
      }
    }),
    { numRuns: 400, seed: 0x5afe0005 },
  );
});

test('[FUZZ urlSafety] public hostnames (incl. punycode) are accepted on http/https only', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), { minLength: 1, maxLength: 60 }),
      fc.array(fc.constantFrom('com', 'net', 'io', 'dev', 'example'), { minLength: 1, maxLength: 2 }),
      (label, tlds) => {
        const host = `${label.join('')}.${tlds.join('.')}`;
        const https = new URL(`https://${host}/`);
        assert.equal(isSafeExternalUrl(https), true, host);
        const http = new URL(`http://${host}/`);
        assert.equal(isSafeExternalUrl(http), true, host);
      },
    ),
    { numRuns: 300, seed: 0x5afe0006 },
  );
});

test('[FUZZ urlSafety] non-http(s) schemes are always rejected', () => {
  for (const proto of ['ftp:', 'file:', 'javascript:', 'data:', 'ws:', 'wss:', 'gopher:']) {
    let url;
    try {
      url = new URL(`${proto}//example.com/`);
    } catch {
      continue;
    }
    assert.equal(isSafeExternalUrl(url), false, `${proto}//example.com must be rejected`);
    assert.equal(isProbeableUrl(url), false, `${proto}//example.com must be rejected by probe too`);
  }
});

test('[FUZZ urlSafety] probeable is the inverse: private yes, public/link-local/metadata no', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '[::1]']) {
    let url;
    try {
      url = new URL(`http://${host}/`);
    } catch {
      continue;
    }
    assert.equal(isProbeableUrl(url), true, `${host} is a local target and must be probeable`);
    assert.equal(isSafeExternalUrl(url), false, `${host} must never be externally fetchable`);
  }
  for (const host of ['169.254.169.254', '[fe80::1]', 'example.com']) {
    let url;
    try {
      url = new URL(`http://${host}/`);
    } catch {
      continue;
    }
    assert.equal(isProbeableUrl(url), false, `${host} must not be probeable`);
  }
  // DNS-rebinding names (nip.io) resolve to localhost and are thus probeable by the
  // prefix-based allowlist — a documented syntax-level limitation shared by both guards
  // (real DNS resolution is out of scope for these synchronous checks).
  const rebinding = new URL('http://127.0.0.1.nip.io/');
  assert.equal(isProbeableUrl(rebinding), true);
  assert.equal(isSafeExternalUrl(rebinding), false, 'rebinding name must never be externally fetchable');
});

// ---- commandRisk vs dangerousPatterns (differential) --------------------------

// One representative command per DANGEROUS_PATTERNS entry (dangerousPatterns.js). The
// differential invariant: the hard blocklist is a strict subset of the confirm classifier's
// view — anything the blocklist would refuse must also be confirm-worthy, so a future
// refactor that bypasses the blocklist still cannot run these unconfirmed.
const BLOCKLIST_SAMPLES = [
  'rm -rf /', 'rm -fr ~', 'rm -rf .', 'rm -rf $HOME',
  'del /s /q c:\\windows', 'rd /s /q c:\\data', 'rmdir /s /q c:\\data',
  'Remove-Item -Recurse -Force C:\\Windows', 'Remove-Item -Force -Recurse C:\\',
  'format c:', 'echo x > /dev/sda', 'mkfs.ext4 /dev/sdb', 'dd if=/dev/zero of=/dev/sda',
  'git push -f origin main', 'git push origin main -f', 'git reset --hard origin/main',
  'git branch -D main', 'shutdown /s', 'shutdown -r', 'Reflect-Computer', 'Reflect-System',
  ':(){ :|:& };:',
];

const SAFE_COMMANDS = [
  'git status', 'git pull', 'git log --oneline', 'git diff', 'git stash list',
  'npm install', 'npm run dev', 'npm test', 'tsc --noEmit', 'node server/index.js',
  'python main.py serve', 'git commit -m "hello"', 'echo hi', 'git add .',
];

test('[FUZZ differential] every hard-blocklisted sample is also classified destructive', () => {
  for (const cmd of BLOCKLIST_SAMPLES) {
    assert.equal(isCommandBlocked(cmd), true, `blocklist must flag: ${cmd}`);
    assert.equal(isDestructiveCommand(cmd), true, `risk classifier must also flag: ${cmd}`);
  }
});

test('[FUZZ differential] safe everyday commands are neither blocked nor destructive', () => {
  for (const cmd of SAFE_COMMANDS) {
    assert.equal(isCommandBlocked(cmd), false, `blocklist must pass: ${cmd}`);
    assert.equal(isDestructiveCommand(cmd), false, `risk classifier must pass: ${cmd}`);
  }
});

// Whitespace injection: `git   push` or `rm\t-rf\t/` must never dodge either layer.
test('[FUZZ differential] random whitespace between tokens never dodges blocklist or classifier', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...BLOCKLIST_SAMPLES.map((s) => s.split(' '))),
      fc.constantFrom(' ', '  ', '\t', ' \t '),
      (tokens, gap) => {
        const cmd = tokens.join(gap);
        assert.equal(isCommandBlocked(cmd), true, `whitespace-injected blocklist sample must stay blocked: ${JSON.stringify(cmd)}`);
        assert.equal(isDestructiveCommand(cmd), true, `whitespace-injected blocklist sample must stay destructive: ${JSON.stringify(cmd)}`);
      },
    ),
    { numRuns: 400, seed: 0x5afe0007 },
  );
});

// ---- isCommandAllowed (allowlist round-trips) ---------------------------------

test('[FUZZ isCommandAllowed] every allowlisted executable is accepted bare and with flags', () => {
  for (const exe of ALLOWED_COMMANDS) {
    assert.equal(isCommandAllowed(exe), true, exe);
    assert.equal(isCommandAllowed(`${exe} --help`), true, `${exe} --help`);
    assert.equal(isCommandAllowed(`${exe}.exe`), true, `${exe}.exe`);
  }
});

test('[FUZZ isCommandAllowed] non-allowlisted executables are always rejected', () => {
  const FORBIDDEN = ['evil', 'curl', 'wget', 'powershell', 'cmd', 'sh', 'bash', 'rm', 'del', 'python2', 'node_modules', 'ruby.exe.bak'];
  fc.assert(
    fc.property(
      fc.constantFrom(...FORBIDDEN),
      fc.array(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 2 }),
      (exe, gaps) => {
        const cmd = exe + gaps.join('') + ' --flag';
        assert.equal(isCommandAllowed(cmd), false, cmd);
      },
    ),
    { numRuns: 100, seed: 0x5afe0008 },
  );
});

test('[FUZZ isCommandAllowed] env-prefix stripping never changes the decision', () => {
  const bases = [...ALLOWED_COMMANDS.map((e) => `${e} run`), ...['evil run', 'curl -o x', 'bash -c "x"']];
  fc.assert(
    fc.property(
      fc.constantFrom(...bases),
      fc.constantFrom('PORT=3001', 'PORT=3001', 'NODE_ENV=prod', 'FOO=bar=baz'),
      (base, env) => {
        const direct = isCommandAllowed(base);
        assert.equal(isCommandAllowed(`${env} ${base}`), direct, `${env} ${base}`);
        assert.equal(isCommandAllowed(`set ${env}&& ${base}`), direct, `set ${env}&& ${base}`);
      },
    ),
    { numRuns: 300, seed: 0x5afe0009 },
  );
});

test('[FUZZ isCommandAllowed] Windows path forms resolve to the basename', () => {
  for (const exe of ALLOWED_COMMANDS) {
    assert.equal(isCommandAllowed(`C:\\Windows\\System32\\${exe.toUpperCase()}.EXE`), true, `C:\\...\\${exe}.EXE`);
    assert.equal(isCommandAllowed(`C:\\Windows\\System32\\${exe}.cmd`), true, `C:\\...\\${exe}.cmd`);
  }
  assert.equal(isCommandAllowed('C:\\Users\\x\\evil.exe'), false);
  assert.equal(isCommandAllowed('C:\\Windows\\System32\\not-node.exe'), false);
});

// ---- paramCommand round-trips -------------------------------------------------

test('[FUZZ paramCommand] extractParamValue/substituteParams keep values safe end-to-end', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...'0123456789'), { minLength: 1, maxLength: 20 }),
      (digits) => {
        const value = digits.join('');
        const extracted = extractParamValue(`watch every ${value} minutes`, '\\d+');
        assert.equal(extracted, value);
        const substituted = substituteParams('python main.py watch --interval {n}', { n: value });
        assert.ok(substituted.includes(`--interval ${value}`));
        assert.equal(isSafeParamValue(value), true);
      },
    ),
    { numRuns: 100, seed: 0x5afe000a },
  );
});