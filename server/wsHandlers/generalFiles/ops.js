import fs from 'fs';
import path from 'path';
import { createResolveSafe } from '../../toolSandbox.js';
import { appendAction } from '../../actionHistory.js';
import { MAX_PREIMAGE_BYTES, MAX_TIDY_MOVES } from './constants.js';

// J (explorer file ops, 2026-09-10): create-file/folder, delete, and copy/duplicate for
// the Folder Explorer — project-scoped direct-REST siblings of the D-7 rename/move
// endpoints, following their exact safety shape: createResolveSafe containment,
// checkpoint-first at the route layer, never-overwrite, and appendAction journaling so
// `revert action <id>` undoes every op here. Panel REST only, never chat (a chat phrase
// carrying a filename to delete would persist a destructive intent in the transcript).

const PROTECTED_PREFIXES = ['.console/', '.git/', 'node_modules/'];

function isProtected(rel) {
  const norm = rel.replace(/\\/g, '/');
  return PROTECTED_PREFIXES.some((p) => norm === p.slice(0, -1) || norm.startsWith(p));
}

function cleanName(name) {
  const n = (name || '').trim();
  if (!n || n.length > 255) return null;
  if (n === '.' || n === '..' || /[\\/]/.test(n) || /[\u0000-\u001f\u007f]/.test(n)) return null;
  return n;
}

/** Create one empty file or folder inside dir (both project-relative). */
export async function performCreate(root, dir, name, isDir) {
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: 'That name is not usable — pick a plain file or folder name.' };
  const resolveSafe = createResolveSafe(root);
  let absDir, absTarget;
  try {
    absDir = resolveSafe(dir || '.');
    absTarget = resolveSafe(path.posix.join(dir || '.', clean));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  let st;
  try {
    st = fs.statSync(absDir);
  } catch {
    return { ok: false, error: `"${dir || '.'}" doesn't exist.` };
  }
  if (!st.isDirectory()) return { ok: false, error: `"${dir || '.'}" is not a folder.` };
  if (fs.existsSync(absTarget)) return { ok: false, error: `"${clean}" already exists — the console never overwrites.` };
  try {
    if (isDir) fs.mkdirSync(absTarget, { recursive: false });
    else fs.writeFileSync(absTarget, '', 'utf-8');
  } catch (err) {
    return { ok: false, error: `Create failed: ${err.message}` };
  }
  const rel = path.relative(root, absTarget).replace(/\\/g, '/');
  const id = appendAction(root, { type: 'file_write', description: `Created ${isDir ? 'folder' : 'file'} ${rel} (explorer)`, path: rel, existed: false });
  return { ok: true, path: rel, actionIds: id ? [id] : [] };
}

/** Delete files and empty folders (project-relative paths). Files journal with a
 *  pre-image cap exactly like duplicates_delete; non-empty folders refuse with a
 *  message rather than recursing blindly. Console metadata dirs are off-limits. */
export async function performDelete(root, paths) {
  const rels = Array.isArray(paths) ? paths.map((p) => String(p || '').trim()).filter(Boolean) : [];
  if (rels.length === 0) return { ok: false, error: 'Nothing to delete.' };
  if (rels.length > MAX_TIDY_MOVES) return { ok: false, error: `Delete is capped at ${MAX_TIDY_MOVES} items per run.` };
  const resolveSafe = createResolveSafe(root);
  let deleted = 0;
  let skippedJournal = 0;
  const actionIds = [];
  for (const rel of rels) {
    if (isProtected(rel)) return { ok: false, error: `"${rel}" is console metadata — it cannot be deleted from the explorer.`, deleted, skippedJournal, actionIds };
    let abs;
    try {
      abs = resolveSafe(rel);
    } catch (err) {
      return { ok: false, error: err.message, deleted, skippedJournal, actionIds };
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return { ok: false, error: `"${rel}" doesn't exist.`, deleted, skippedJournal, actionIds };
    }
    if (st.isDirectory()) {
      let kids = [];
      try {
        kids = fs.readdirSync(abs);
      } catch (err) {
        return { ok: false, error: `Could not read ${rel}: ${err.message}`, deleted, skippedJournal, actionIds };
      }
      if (kids.length > 0) return { ok: false, error: `"${rel}" is not empty — empty it first (recursive folder deletes stay a deliberate manual step).`, deleted, skippedJournal, actionIds };
      try {
        fs.rmdirSync(abs);
      } catch (err) {
        return { ok: false, error: `Delete of ${rel} failed: ${err.message}`, deleted, skippedJournal, actionIds };
      }
      const id = appendAction(root, { type: 'file_write', description: `Deleted empty folder ${rel} (explorer)`, path: rel, existed: true, preContent: '' });
      if (id) actionIds.push(id);
      deleted++;
      continue;
    }
    let preContent = null;
    try {
      if (st.size <= MAX_PREIMAGE_BYTES) preContent = fs.readFileSync(abs, 'utf-8');
    } catch {
      return { ok: false, error: `Could not read ${rel} before deleting.`, deleted, skippedJournal, actionIds };
    }
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      return { ok: false, error: `Delete of ${rel} failed: ${err.message}`, deleted, skippedJournal, actionIds };
    }
    if (preContent === null) {
      skippedJournal++;
    } else {
      const id = appendAction(root, { type: 'file_write', description: `Deleted ${rel} (explorer)`, path: rel, existed: true, preContent });
      if (id) actionIds.push(id);
    }
    deleted++;
  }
  return { ok: true, deleted, skippedJournal, actionIds };
}

/** Copy/duplicate one file (or an empty folder) to a sibling "copy" name or an explicit
 *  target dir. Created files journal as existed:false; caps match tidy bounds. */
export async function performCopy(root, from, toDir) {
  const resolveSafe = createResolveSafe(root);
  let absFrom;
  try {
    absFrom = resolveSafe(from);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (isProtected(from)) return { ok: false, error: `"${from}" is console metadata — it cannot be copied from the explorer.` };
  let st;
  try {
    st = fs.statSync(absFrom);
  } catch {
    return { ok: false, error: `"${from}" doesn't exist.` };
  }
  if (st.isDirectory()) {
    let kids = [];
    try {
      kids = fs.readdirSync(absFrom);
    } catch (err) {
      return { ok: false, error: `Could not read ${from}: ${err.message}` };
    }
    if (kids.length > 0) return { ok: false, error: `Only empty folders copy for now — "${from}" has ${kids.length} item(s).` };
  } else if (st.size > MAX_PREIMAGE_BYTES * 50) {
    return { ok: false, error: `"${from}" is too large to copy safely from the panel.` };
  }
  const parent = path.posix.dirname(from);
  const base = path.posix.basename(from);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let targetRel = toDir && toDir !== '.' && toDir !== parent
    ? path.posix.join(toDir, base)
    : path.posix.join(parent === '.' ? '' : parent, `${stem} copy${ext}`);
  let absTo;
  try {
    absTo = resolveSafe(targetRel);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  for (let i = 2; fs.existsSync(absTo) && i < 100; i++) {
    const alt = parent === '.' || parent === ''
      ? `${stem} copy ${i}${ext}`
      : path.posix.join(parent, `${stem} copy ${i}${ext}`);
    try {
      absTo = resolveSafe(alt);
      targetRel = alt;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  if (fs.existsSync(absTo)) return { ok: false, error: `"${targetRel}" already exists — the console never overwrites.` };
  try {
    if (st.isDirectory()) fs.mkdirSync(absTo);
    else fs.copyFileSync(absFrom, absTo);
  } catch (err) {
    return { ok: false, error: `Copy failed: ${err.message}` };
  }
  const rel = path.relative(root, absTo).replace(/\\/g, '/');
  const id = appendAction(root, { type: 'file_write', description: `Copied ${from} -> ${rel} (explorer)`, path: rel, existed: false });
  return { ok: true, path: rel, actionIds: id ? [id] : [] };
}
