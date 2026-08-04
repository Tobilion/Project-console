// Path display helpers (Phase 1 modularization — extracted from Dashboard.tsx).

/** Shortens an absolute project path for UI display by replacing the user's Projects root with
 *  "~/". Unrecognized paths (outside the known root) are returned unchanged. */
export function formatPath(p: string): string {
  const PREFIX = 'C:\\Users\\tobil\\Desktop\\Projects\\';
  if (p.startsWith(PREFIX)) return '~/' + p.slice(PREFIX.length).replace(/\\/g, '/');
  return p;
}
