// Phase 3 (2026-08-10): the opt-in "restricted execution context" for confirmed risky
// commands — approach (a) from the spec: environment allowlist + restricted working
// directory. Honest guarantees, documented because the name says "sandbox" and this is
// NOT a container:
//   - Env allowlist: only the listed variables pass through, so env-carried secrets
//     (tokens, keys, project-specific vars) cannot leak into a sandboxed run.
//   - Restricted cwd: the process is pinned to the project directory (the caller already
//     passes the project path as cwd; nothing here can change that).
//   - CONSOLE_SANDBOXED / CONSOLE_SANDBOX_ROOT markers: a sandboxed process can detect
//     its own confinement and scripts can choose to self-limit.
//   - NO network isolation on Windows (would need elevation or a WFP driver) and NO
//     OS-level file-access boundary (would need AppContainer/ACLs): a sandboxed `git
//     push` still reaches the network. This layer is secret-leakage containment plus a
//     detectable boundary, not a security wall — see CLAUDE.md.
export const SANDBOX_ENV_ALLOWLIST: string[] = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'windir', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USER', 'LOGNAME',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME',
  'LANG', 'LC_ALL', 'LC_MESSAGES',
];

/** Builds the restricted environment for a sandboxed spawn: allowlist + markers.
 *  `baseEnv` is typically process.env; `projectPath` becomes CONSOLE_SANDBOX_ROOT. */
export function buildSandboxEnv(baseEnv: Record<string, string | undefined>, projectPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (value !== undefined) out[key] = value;
  }
  out.CONSOLE_SANDBOXED = '1';
  out.CONSOLE_SANDBOX_ROOT = projectPath;
  return out;
}