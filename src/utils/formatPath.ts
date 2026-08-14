// Path display helpers (Phase 1 modularization — extracted from Dashboard.tsx).

/** Shortens an absolute project path for UI display by replacing the given scan root with
 *  "~/". The root is the server's current scan directory (/api/projects scanPath) — passing it
 *  in keeps this machine-agnostic (the old hardcoded author path never matched on other
 *  machines). Paths outside the root are returned unchanged. */
export function formatPath(p: string, root?: string): string {
  if (!p || !root) return p;
  const normRoot = root.replace(/[\\/]+$/, '');
  if (p.startsWith(normRoot + '\\') || p.startsWith(normRoot + '/')) {
    return '~/' + p.slice(normRoot.length).replace(/\\/g, '/');
  }
  return p;
}
