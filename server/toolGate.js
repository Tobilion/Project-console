import { loadPluginManifest } from './pluginTools.js';

// Tool-approval gate + per-project permissions policy (Phase 9 split, 2026-08-04 — extracted
// from tools.js; re-exported from tools.js so external importers are untouched). This is the
// single decision point every tool invocation goes through — keep it security-first.

/** Cache for plugin manifests to avoid reading the file on every tool creation. */
const pluginManifestCache = new Map();

export async function getPluginManifest(root) {
  if (pluginManifestCache.has(root)) {
    const cached = pluginManifestCache.get(root);
    // If it's a promise (first call in flight), await it; otherwise return the resolved value
    return cached instanceof Promise ? cached : cached;
  }
  const promise = loadPluginManifest(root).then(result => {
    pluginManifestCache.set(root, result);
    return result;
  }).catch(() => {
    // Do NOT cache the failure (the old `set(root, null)` made a transient read error
    // permanent — every later call would return null from cache and never retry the manifest).
    // Deleting lets the next getPluginManifest call re-read the file.
    pluginManifestCache.delete(root);
    return null;
  });
  pluginManifestCache.set(root, promise);
  return promise;
}

/** Tool names whose effects are destructive/irreversible-ish and must be confirmed by the user before running. */
export const GATED_TOOLS = new Set(['writeFile', 'editFile', 'insertAtLine', 'appendToFile']);

/**
 * Phase 5 (2026-08-03, PASS 5.3): tools that ARE command
 * executions themselves (not just file edits), so they're always confirm-gated regardless of any
 * permissions policy or session grant — the same invariant that keeps `risky: true` executeCommand
 * un-approvable by any auto-approval path. resolveToolGate checks this BEFORE the session-grant
 * ("Approve this task") path can auto-approve them.
 */
export const ALWAYS_CONFIRM_TOOLS = new Set(['runTests', 'stopProcess']);

/**
 * Per-project risky custom plugin tools. Populated by createProjectTools() when loading
 * console.tools.json — maps project root -> Set of tool names with risky: true.
 */
export const CUSTOM_RISKY_TOOLS = new Map();

export function isGatedToolCall(toolName, args) {
  if (GATED_TOOLS.has(toolName)) return true;
  if (ALWAYS_CONFIRM_TOOLS.has(toolName)) return true;
  if (toolName === 'executeCommand' && args?.risky) return true;
  // saveMemory is deliberately NOT in GATED_TOOLS — a flat gate would require approval for every
  // save, including trivial ones ("user prefers dark mode"), which defeats the point of letting
  // the AI jot down low-stakes context without interrupting the conversation. Only a call the
  // model itself flagged as a judgment call (importance: 'judgment' — see ollamaContext.js's
  // rules for what qualifies) needs a human checkpoint before it's written.
  if (toolName === 'saveMemory' && args?.importance === 'judgment') return true;
  // Not a built-in tool name — could be a custom plugin tool with risky: true
  // (checked by project root context in runToolCall)
  return false;
}

/** Overload: check if a custom tool by name is registered as risky for a given project root. */
export function isCustomToolRisky(toolName, projectRoot) {
  const riskySet = CUSTOM_RISKY_TOOLS.get(projectRoot);
  return riskySet ? riskySet.has(toolName) : false;
}

/**
 * Phase 5 (2026-08-03, PASS 5.1): reads a project's
 * permissions policy for a single tool from its console.tools.json manifest. Returns the value
 * ('ask' | 'allow-after-first-ask' | 'deny') or undefined when the manifest has no policy for it
 * (undefined === the default 'ask'). executeCommand can never be anything but 'ask' (enforced at
 * parse time in pluginTools.js), so `risky: true` commands stay gated forever regardless of policy.
 */
export async function getToolPermission(projectRoot, toolName) {
  if (!projectRoot || !toolName) return undefined;
  const manifest = await getPluginManifest(projectRoot);
  return manifest?.permissions?.[toolName];
}

/** The session-scoped grant key for a (project, tool) pair — what allow-after-first-ask records
 *  and what "Approve this task" grants. Scoped per project root so a grant in one project can
 *  never leak to another. */
export function toolGrantKey(projectRoot, toolName) {
  return `${projectRoot}::${toolName}`;
}

/**
 * Phase 5 — the single decision point for whether a tool call needs user approval. Hierarchy:
 *  1. Policy 'deny'                    → never runs, no prompt (tool error instead).
 *  2. Not gated at all               → runs immediately ('allow').
 *  3. ALWAYS_CONFIRM_TOOLS members (runTests/stopProcess) and `risky: true` executeCommand →
 *     always 'ask', even with a session grant or a permissive policy. Nothing can auto-approve
 *     these — the belt-and-suspenders counterpart to PASS 5.1's parse-time enforcement.
 *  4. A session grant (held in sessionContext.toolGrants — set by "Approve this task", or
 *     recorded automatically after a first ask when the policy is 'allow-after-first-ask') →
 *     runs immediately ('allow', frontend shows an "auto-approved" note). deny is still checked
 *     first, so a policy 'deny' beats any grant.
 *  5. Otherwise → today's unchanged ask flow ('ask'), with an optional grantKey to record once
 *     the user approves, if policy is allow-after-first-ask.
 * `sessionGrants` is the sessionContext.toolGrants Set (or null when not applicable, e.g. direct
 * trigger-mode paths that shouldn't consult session grants).
 */
export async function resolveToolGate(toolName, args, projectRoot, sessionGrants) {
  if (!toolName) return { action: 'allow' };
  const permission = await getToolPermission(projectRoot, toolName);

  if (permission === 'deny') {
    return { action: 'deny' };
  }

  const gated = isGatedToolCall(toolName, args) || (projectRoot ? isCustomToolRisky(toolName, projectRoot) : false);
  if (!gated) return { action: 'allow' };

  // Command-execution tools and risky shell commands can never be auto-approved by ANY grant —
  // they go through the normal confirm flow every time, exactly like executeCommand with risky.
  if (ALWAYS_CONFIRM_TOOLS.has(toolName) || (toolName === 'executeCommand' && args?.risky)) {
    return { action: 'ask', grantKey: null };
  }

  const grantKey = toolGrantKey(projectRoot, toolName);
  if (sessionGrants && sessionGrants.has(grantKey)) {
    return { action: 'allow', autoApproved: true };
  }

  if (permission === 'allow-after-first-ask') {
    return { action: 'ask', grantKey };
  }
  return { action: 'ask', grantKey: null };
}
