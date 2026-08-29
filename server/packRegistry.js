// Phase 17 (UPGRADE-ROADMAP.md, 2026-08-12): remote pack-registry support — the network half
// of the marketplace, layered ON TOP of the existing local-file pack install (connectionPack
// Admin.js). A registry is a plain JSON file hosted over HTTPS listing packs (name, description,
// author, version, manifestUrl, checksum). Deliberately NO default registry URL: no console
// ever talks to a network endpoint until the user explicitly sets one via `set pack registry
// <url>`, and fetching always goes through the existing SSRF guard (isSafeExternalUrl).
//
// Honesty note (per the roadmap): this project does NOT host, curate, or vet a public registry
// itself. A registry URL is whatever the user points it at, at their own risk — the same trust
// model as pointing npm at a custom registry. Installed packs still run through the exact same
// createPluginToolFn isSafeParamValue/isCommandBlocked checks at call time regardless of source.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeFileAtomicSync } from './atomicWrite.js';
import { resolveData } from './dataPath.js';
import { isSafeExternalUrl } from './urlSafety';
import { validateToolEntry, sanitizePermissions } from './pluginTools.js';

const REGISTRY_CONFIG_FILE = resolveData('registry-config.json');
const FETCH_TIMEOUT_MS = 8000;

export function getRegistryUrl() {
  try {
    if (!fs.existsSync(REGISTRY_CONFIG_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_CONFIG_FILE, 'utf-8'));
    return typeof parsed?.url === 'string' && parsed.url ? parsed.url : null;
  } catch {
    return null;
  }
}

export function setRegistryUrl(url) {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_CONFIG_FILE), { recursive: true });
    writeFileAtomicSync(REGISTRY_CONFIG_FILE, JSON.stringify({ url: url || null }, null, 2));
    return true;
  } catch {
    return false;
  }
}

function parseRegistryIndex(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Registry returned invalid JSON.' };
  }
  const packs = Array.isArray(parsed?.packs) ? parsed.packs : [];
  const valid = packs.filter((p) => p && typeof p.name === 'string' && typeof p.manifestUrl === 'string' && /^https:\/\//.test(p.manifestUrl));
  return { packs: valid };
}

/** Fetch the registry index (SSRF-guarded). Returns { packs } or { error }. */
export async function fetchRegistryIndex() {
  const url = getRegistryUrl();
  if (!url) return { error: 'No pack registry configured. Set one with `set pack registry <url>` (an HTTPS URL to a JSON index listing packs).' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `"${url}" isn't a valid URL.` };
  }
  if (parsed.protocol !== 'https:') return { error: 'The registry must be an HTTPS URL — a registry index fetched over plain http would be trivially spoofable.' };
  if (!isSafeExternalUrl(parsed)) return { error: 'Rejected: internal/private addresses are blocked by the SSRF guard. Use a public HTTPS registry URL.' };
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: `Registry responded ${res.status}.` };
    return parseRegistryIndex(await res.text());
  } catch (err) {
    return { error: `Could not fetch the registry: ${err.message}` };
  }
}

/** Fetch one pack's manifest from its HTTPS URL + verify the declared sha256 checksum.
 *  Returns { ok, tools, permissions, name, description } or { ok:false, error }. */
export async function fetchPackManifest(pack) {
  let parsed;
  try {
    parsed = new URL(pack.manifestUrl);
  } catch {
    return { ok: false, error: `${pack.name}: invalid manifest URL.` };
  }
  if (parsed.protocol !== 'https:' || !isSafeExternalUrl(parsed)) {
    return { ok: false, error: `${pack.name}: manifest URL must be public HTTPS (SSRF guard).` };
  }
  let text;
  try {
    const res = await fetch(pack.manifestUrl, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `${pack.name}: manifest responded ${res.status}.` };
    text = await res.text();
  } catch (err) {
    return { ok: false, error: `${pack.name}: could not fetch the manifest — ${err.message}` };
  }
  // A remote manifest with no declared checksum is refused outright — HTTPS alone isn't
  // integrity (a compromised registry could ship anything), so verification must never be
  // silently skipped (audit 2026-08-17). The declared value must also be a real sha256 hex.
  const declared = typeof pack.checksum === 'string' ? pack.checksum.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(declared)) {
    return { ok: false, error: `${pack.name}: the registry index declares no sha256 checksum for this pack — refusing to install.` };
  }
  const hash = crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
  if (hash !== declared) {
    return { ok: false, error: `${pack.name}: checksum mismatch — the manifest does not match the registry index's declared checksum (refusing to install).` };
  }
  let parsedManifest;
  try {
    parsedManifest = JSON.parse(text);
  } catch {
    return { ok: false, error: `${pack.name}: manifest isn't valid JSON.` };
  }
  if (!parsedManifest || typeof parsedManifest !== 'object' || !Array.isArray(parsedManifest.tools)) {
    return { ok: false, error: `${pack.name}: manifest doesn't look like a pack (expected a "tools" array).` };
  }
  const tools = [];
  const errors = [];
  parsedManifest.tools.forEach((entry, i) => {
    const result = validateToolEntry(entry, i);
    if (result.valid) tools.push(entry);
    else errors.push(...result.errors);
  });
  const permissions = sanitizePermissions(parsedManifest.permissions);
  return { ok: true, tools, permissions, errors, name: pack.name, description: pack.description || '' };
}
