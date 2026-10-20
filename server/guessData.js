import { isWindows } from './platformCommand.js';

// Best-guess command fallback table — when no intent matches but the input resembles a dev
// task, infer the likely command and offer it with confirmation. Split out of commandGuesser.js
// (Phase 2 modularization) so the patterns live as pure data, separate from the matching loop.
//
// Only fires after the full matching pipeline (embedding → Fuse.js → keyword → NLP.js) returned
// nothing. Pure regex heuristics, not AI — precision over recall.
//
// `executeCommand()` spawns with `shell: true`, which resolves to cmd.exe on Windows and
// /bin/sh elsewhere — so any guess here that uses a shell *builtin* (as opposed to a real
// cross-platform binary like npm/git/python) must branch on `process.platform`, or it will
// throw "command not found" on macOS/Linux. `npx`, `npm`, `git`, and `python` guesses below
// don't need branching; `dir`, `del`, `type` do.

/**
 * A captured argument only counts as a COMMAND TARGET when it looks like one: a single token
 * (a package name, a filename, a path) or an explicitly quoted string.
 *
 * This guard exists because the guesser used to accept ANY text after the verb. Live examples
 * of what that produced:
 *   "add a note that the API needs a key"  ->  git add "a note that the API needs a key"
 *   "remove the old component"              ->  npm uninstall "the old component"
 *   "delete everything"                     ->  del /f /q "everything"
 * A multi-word phrase is a request the matcher did not understand, not a command argument —
 * the right outcome there is the fallback suggestions, not a confirm card for a nonsense
 * command.
 */
function isCommandTarget(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^".*"$|^'.*'$/.test(t)) return true; // the user named the exact thing
  return !/\s/.test(t);
}

/**
 * Stricter variant for the rules that DELETE or display a FILE: the target must look like a
 * path or a filename (it has a separator, a leading dot, or an extension). "delete everything"
 * and "remove the old component" are prose, not filenames.
 */
function isFileTarget(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^".*"$|^'.*'$/.test(t)) return true;
  if (/\s/.test(t)) return false;
  return /[\\/]/.test(t) || /^\./.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
}

export const GUESSES = [
  {
    // "remove node_modules from git" → "git rm --cached -r node_modules"
    pattern: /remove\s+(.+?)\s+from\s+git/i,
    build: (match) => {
      const target = match[1].trim();
      if (!isCommandTarget(target)) return null;
      return {
        command: `git rm --cached -r "${target}"`,
        description: `Remove ${target} from git tracking (keeps file on disk)`,
      };
    },
  },
  {
    // "add .env to gitignore" → append to .gitignore
    pattern: /add\s+(.+?)\s+to\s+gi?ignore/i,
    build: (match) => {
      const target = match[1].trim();
      if (!isCommandTarget(target)) return null;
      return {
        command: `echo "${target}" >> .gitignore`,
        description: `Add ${target} to .gitignore`,
      };
    },
  },
  {
    // "create a file called X" → echo > file
    //
    // The trailing $ matters: without it the lazy capture stopped at the FIRST character
    // (everything after it was optional), so "create a file called notes.txt" captured "n"
    // and would have created a file named "n".
    pattern: /create\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?["']?(.+?)["']?(?:\s+with\s+content\s+(.+))?$/i,
    build: (match) => {
      const name = match[1].trim();
      if (!isFileTarget(name)) return null;
      return {
        command: match[2]
          ? `echo "${match[2].trim()}" > "${name}"`
          : isWindows ? `type nul > "${name}"` : `touch "${name}"`,
        description: `Create file ${name}${match[2] ? ' with provided content' : ''}`,
      };
    },
  },
  {
    // "install express" → npm install express
    //
    // Anchored at the start: an unanchored "install\s+" also matched the tail of
    // "uninstall express", which then produced `npm install express` for an uninstall.
    pattern: /^install\s+(.+?)(?:\s+as\s+(?:a\s+)?(?:dev\s+)?dependency)?$/i,
    build: (match) => {
      const pkg = match[1].trim();
      if (!isCommandTarget(pkg)) return null;
      return {
        command: `npm install ${pkg}`,
        description: `Install npm package ${pkg}`,
      };
    },
  },
  {
    // "install express as dev dependency" → npm install --save-dev express
    pattern: /install\s+(.+?)\s+as\s+(?:a\s+)?dev\s+dependency/i,
    build: (match) => {
      const pkg = match[1].trim();
      if (!isCommandTarget(pkg)) return null;
      return {
        command: `npm install --save-dev ${pkg}`,
        description: `Install ${pkg} as dev dependency`,
      };
    },
  },
  {
    // "delete notes.txt" / "remove notes.txt" → delete that FILE.
    //
    // This rule comes BEFORE the npm-uninstall rule on purpose: "remove notes.txt" means the
    // file, and the package rule would otherwise read it as `npm uninstall notes.txt`.
    // The target must look like a file (path, extension or dotfile) — "delete everything" and
    // "remove the old component" are prose and get no guess at all.
    pattern: /(?:delete|remove|erase)\s+(?:the\s+)?(?:file\s+)?["']?(.+?)["']?$/i,
    build: (match) => {
      const target = match[1].trim();
      if (!isFileTarget(target)) return null;
      return {
        command: isWindows ? `del /f /q "${target}"` : `rm -f "${target}"`,
        description: `Delete file ${target}`,
      };
    },
  },
  {
    // "uninstall express" / "remove express" → npm uninstall express
    pattern: /(?:uninstall|remove)\s+(.+?)(?:\s+package)?$/i,
    build: (match) => {
      const pkg = match[1].trim();
      if (!isCommandTarget(pkg)) return null;
      return {
        command: `npm uninstall ${pkg}`,
        description: `Uninstall npm package ${pkg}`,
      };
    },
  },
  {
    // "run dev" → npm run dev (only when no script name is given)
    pattern: /^run\s+(?:the\s+)?(?:dev|development|start|build|test|lint|format|preview)$/i,
    build: (match) => ({
      command: `npm run ${match[0].replace(/^run\s+(the\s+)?/i, '').toLowerCase()}`,
      description: `Run npm script: ${match[0].replace(/^run\s+(the\s+)?/i, '').toLowerCase()}`,
    }),
  },
  {
    // "start the server" → npm start
    pattern: /start\s+(?:the\s+)?(?:server|app|application|dev|site)/i,
    build: () => ({
      command: 'npm start',
      description: 'Start the project (npm start)',
    }),
  },
  {
    // "show me the file X" / "read file X"
    pattern: /(?:show|read|view|open|display|cat)\s+(?:me\s+)?(?:the\s+)?(?:file\s+|contents?\s+of\s+)?["']?(.+?)["']?$/i,
    build: (match) => {
      const target = match[1].trim();
      if (!isFileTarget(target)) return null;
      return {
        command: isWindows ? `type "${target}"` : `cat "${target}"`,
        description: `Display contents of ${target}`,
      };
    },
  },
  {
    // "list all files" / "show files" — but not if it already matched project.context.structure
    pattern: /^(?:list|show)\s+(?:all\s+)?(?:the\s+)?(?:files?|contents?)\s*(?:in\s+(.+))?$/i,
    build: (match) => ({
      command: isWindows
        ? (match[1] ? `dir /b "${match[1].trim()}"` : 'dir /b')
        : (match[1] ? `ls -1 "${match[1].trim()}"` : 'ls -1'),
      description: match[1] ? `List files in ${match[1].trim()}` : 'List all files in current directory',
    }),
  },
  {
    // "git add X" → git add specific file
    pattern: /^(?:git\s+)?add\s+["']?(.+?)["']?$/i,
    build: (match) => {
      const target = match[1].trim();
      if (!isFileTarget(target)) return null;
      return {
        command: `git add "${target}"`,
        description: `Stage ${target} for commit`,
      };
    },
  },
  {
    // "npx serve ." → serve current directory
    pattern: /^npx\s+serve\b/i,
    build: () => ({
      command: 'npx serve .',
      description: 'Serve this folder as a static site via npx serve',
    }),
  },
  {
    // "python -m http.server 8080" → start Python HTTP server
    pattern: /^python\s+-m\s+http\.server\b/i,
    build: () => ({
      command: 'python -m http.server 8080',
      description: 'Start Python HTTP server on port 8080',
    }),
  },
  {
    // "start index.html" → open file
    pattern: /^start\s+.+\.html$/i,
    build: (match) => ({
      command: match[0],
      description: `Open ${match[0].replace(/^start\s+/, '')} in default browser`,
    }),
  },
  {
    // "python main.py" / "python app.py"
    pattern: /^python\s+\w+\.py$/i,
    build: (match) => ({
      command: match[0],
      description: `Run Python script: ${match[0]}`,
    }),
  },
];
