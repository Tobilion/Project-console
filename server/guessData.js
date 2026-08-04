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

export const GUESSES = [
  {
    // "remove node_modules from git" → "git rm --cached -r node_modules"
    pattern: /remove\s+(.+?)\s+from\s+git/i,
    build: (match) => ({
      command: `git rm --cached -r "${match[1].trim()}"`,
      description: `Remove ${match[1].trim()} from git tracking (keeps file on disk)`,
    }),
  },
  {
    // "add .env to gitignore" → append to .gitignore
    pattern: /add\s+(.+?)\s+to\s+gi?ignore/i,
    build: (match) => ({
      command: `echo "${match[1].trim()}" >> .gitignore`,
      description: `Add ${match[1].trim()} to .gitignore`,
    }),
  },
  {
    // "create a file called X" → echo > file
    pattern: /create\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?["']?(.+?)["']?(?:\s+with\s+content\s+(.+))?/i,
    build: (match) => ({
      command: match[2]
        ? `echo "${match[2].trim()}" > "${match[1].trim()}"`
        : isWindows ? `type nul > "${match[1].trim()}"` : `touch "${match[1].trim()}"`,
      description: `Create file ${match[1].trim()}${match[2] ? ' with provided content' : ''}`,
    }),
  },
  {
    // "install express" → npm install express
    pattern: /install\s+(.+?)(?:\s+as\s+(?:a\s+)?(?:dev\s+)?dependency)?$/i,
    build: (match) => ({
      command: `npm install ${match[1].trim()}`,
      description: `Install npm package ${match[1].trim()}`,
    }),
  },
  {
    // "install express as dev dependency" → npm install --save-dev express
    pattern: /install\s+(.+?)\s+as\s+(?:a\s+)?dev\s+dependency/i,
    build: (match) => ({
      command: `npm install --save-dev ${match[1].trim()}`,
      description: `Install ${match[1].trim()} as dev dependency`,
    }),
  },
  {
    // "uninstall express" / "remove express" → npm uninstall express
    pattern: /(?:uninstall|remove)\s+(.+?)(?:\s+package)?$/i,
    build: (match) => ({
      command: `npm uninstall ${match[1].trim()}`,
      description: `Uninstall npm package ${match[1].trim()}`,
    }),
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
    // "delete file X" / "remove file X"
    pattern: /(?:delete|remove|erase)\s+(?:the\s+)?(?:file\s+)?["']?(.+?)["']?$/i,
    build: (match) => ({
      command: isWindows ? `del /f /q "${match[1].trim()}"` : `rm -f "${match[1].trim()}"`,
      description: `Delete file ${match[1].trim()}`,
    }),
  },
  {
    // "show me the file X" / "read file X"
    pattern: /(?:show|read|view|open|display|cat)\s+(?:me\s+)?(?:the\s+)?(?:file\s+|contents?\s+of\s+)?["']?(.+?)["']?$/i,
    build: (match) => ({
      command: isWindows ? `type "${match[1].trim()}"` : `cat "${match[1].trim()}"`,
      description: `Display contents of ${match[1].trim()}`,
    }),
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
    build: (match) => ({
      command: `git add "${match[1].trim()}"`,
      description: `Stage ${match[1].trim()} for commit`,
    }),
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
