// Atomic boot claim (2026-10-20, hardening pass 2).
//
// THE RACE THIS FIXES: several launchers started at the same instant with no console
// running all probed, all found nothing, and all booted their own server. Measured on this
// machine: three concurrent `node bin/cli.js cli` launches bound ports 3000, 3001 AND 3002
// at the same time — three copies of the embedding model, three consoles, and the two
// losing clients' terminals flooded with the server's own boot logs instead of the answer.
//
// THE MECHANISM: a claim file in the data dir, created with O_EXCL (atomic on every
// supported filesystem). The first launcher to create it owns the boot; the others wait
// for the console to come up and attach to it. A claim whose owner died (or that is older
// than the TTL) is stale and can be taken over, so a crashed launcher never blocks the
// next one forever.
//
// The claim is a LOCK, not a registry: it says "someone is booting right now", not "this is
// the running console". The running-console check stays the existing /api/projects probe —
// a claim cannot tell a live console from a dead one, and the port may have been taken by
// something else entirely.
import fs from 'fs';
import path from 'path';
import { resolveData } from './dataPath.js';
import { log } from './logger.js';

// A boot that takes longer than this is presumed dead. The cold boot on this machine is
// ~13s (source mode) to ~40s on a slow machine, so 5 minutes is generous: it only matters
// when the booter CRASHED, and a crashed boot should not block the next launch for long.
export const CLAIM_TTL_MS = 5 * 60 * 1000;

const CLAIM_FILE = 'console-boot-claim.json';

export function claimFilePath() {
  return resolveData(CLAIM_FILE);
}

function readClaim(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number') return parsed;
  } catch { /* unreadable or corrupt claim — treat as absent */ }
  return null;
}

/** True when the claim's owner is gone. A claim from another machine (shared data dir)
 *  cannot be checked by pid, so it is treated as alive until it ages out. */
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return err && err.code === 'EPERM';
  }
}

export function isStaleClaim(claim, now = Date.now()) {
  if (!claim) return true;
  if (now - (claim.startedAt || 0) > CLAIM_TTL_MS) return true;
  if (claim.pid === process.pid) return false;
  return !ownerAlive(claim.pid);
}

/**
 * Tries to become the one launcher allowed to boot a server.
 *
 * Returns { claimed: true, path } when this process owns the boot, or
 * { claimed: false, claim } when someone else is already booting.
 */
export function acquireBootClaim(options = {}) {
  const filePath = options.path || claimFilePath();
  const now = options.now || Date.now();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch { /* the dir may already exist */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL makes the create atomic: exactly one launcher can win this.
      const fd = fs.openSync(filePath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, port: null }));
      } finally {
        fs.closeSync(fd);
      }
      return { claimed: true, path: filePath };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // A claim file we cannot create (permissions, a read-only data dir) must not stop
        // the launcher from booting — fall through and boot anyway.
        log.warn(`[bootClaim] could not create the boot claim (${err.message}) — booting without it.`);
        return { claimed: false, claim: null, unusable: true };
      }
      const existing = readClaim(filePath);
      if (!isStaleClaim(existing, now)) {
        return { claimed: false, claim: existing };
      }
      // The claim is stale (its owner died or it aged out). Remove it and try once more;
      // a racing taker will get EEXIST again and then wait like everyone else.
      try {
        fs.unlinkSync(filePath);
      } catch { /* someone else removed it first — that is fine */ }
    }
  }
  return { claimed: false, claim: readClaim(filePath) };
}

/** Records the port the booting launcher ended up with (diagnostics + staleness checks). */
export function setClaimPort(filePath, port) {
  try {
    const claim = readClaim(filePath) || { pid: process.pid, startedAt: Date.now() };
    claim.port = port;
    fs.writeFileSync(filePath, JSON.stringify(claim));
  } catch { /* diagnostics only — never fatal */ }
}

/** Releases the claim. Safe to call when the file is already gone. */
export function releaseBootClaim(filePath) {
  try {
    const claim = readClaim(filePath);
    // Only the owner may release it: a launcher that lost the race must not delete the
    // winner's claim.
    if (claim && claim.pid !== process.pid) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Reads the current claim (null when there is none). */
export function readBootClaim(filePath = claimFilePath()) {
  return readClaim(filePath);
}
