// Hard blocklist for catastrophic commands. This list is inherently incomplete — it is a
// last-resort net, not a security boundary. Anything marked `risky: true` in a project config,
// or any AI-initiated write/risky command, must still go through explicit user confirmation
// (see server/wsHandlers/matchedEntry.js and server/wsHandlers/aiQuery.js) rather than relying
// on this list alone.
const DANGEROUS_PATTERNS = [
  // Destructive recursive deletes (Unix, incl. relative/home-relative forms)
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(\/|~|\*|\.$|\.\s|\$HOME)/i,
  /\brm\s+-rf\s+\//i,

  // Windows recursive/forced deletes
  /\bdel\s+\/s\s+\/q\s+[c-z]:\\/i,
  /\brd\s+\/s\s+\/q\s+[c-z]:\\/i,
  /\brmdir\s+\/s\s+\/q\s+[c-z]:\\/i,

  // PowerShell destructive removal
  /Remove-Item\s+.*-Recurse.*-Force/i,
  /Remove-Item\s+.*-Force.*-Recurse/i,

  // Disk-level operations
  /\bformat\s+[c-z]:/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=.*of=\/dev\/sd/i,

  // Git history destruction / force-push to protected branches
  /git\s+push\s+.*(-f\b|--force\b|--force-with-lease\b).*\b(origin\s+)?(main|master)\b/i,
  /git\s+push\s+.*(main|master).*(-f\b|--force\b)/i,
  /git\s+reset\s+--hard\s+.*(origin\/(main|master))/i,
  /git\s+branch\s+-D\s+(main|master)\b/i,

  // System shutdown / power state
  /\bshutdown\s+(\/s|\/r|-h|-r)\b/i,
  /\bReflect(-Computer|-System)\b/i,

  // Fork-bomb style patterns
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;/,
];

export function isCommandBlocked(command) {
  if (!command) return false;
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}
