// project.context.* intents — codebase-index-derived Q&A (structure, languages, file counts,
// entry points, tests, dependencies, config) plus the newer deep-structure questions (API routes,
// file import relations, monorepo detection, TODOs, biggest files). Split out of intentsData.js
// (2026-07-30) — see chitChatIntents.js's header comment for why.
export const PROJECT_CONTEXT_INTENTS = {
  'project.context.structure': {
    examples: [
      'show me the project structure', 'what are the directories',
      'list the folders', 'folder structure', 'directory tree',
      'how are files organized', 'show file structure', 'project layout',
      'show me around', 'explore the project', 'how is this organized',
      'show directory structure', 'list directories',
      'what folders exist', 'show me the folder layout',
      'file organization', 'directory listing', 'list folders',
      'show me the directory tree', 'project tree',
      'what is the folder structure', 'explore the codebase',
      'show me folders', 'list all directories', 'tree view',
      'give me a tree of the project', 'whats in the root folder',
      'what top level folders exist', 'show top level structure',
      'give me the folder map', 'display the file tree',
      'how is the codebase laid out',
    ],
  },
  'project.context.languages': {
    examples: [
      'what languages', 'what programming languages', 'what language is this',
      'which languages are used', 'programming languages',
      'languages in this project', 'what is this written in',
      'what languages does this use', 'coding languages',
      'languages used', 'what code languages', 'tell me the languages',
      'what is the code written in', 'what languages are in use',
      'language breakdown', 'language diversity', 'language list',
      'show languages', 'what programming languages are used',
      'what is this coded in', 'languages breakdown',
      'what language dominates this repo', 'main language of this project',
      'primary programming language', 'what is the majority language here',
      'language stats', 'what languages show up most',
    ],
  },
  'project.context.file_count': {
    examples: [
      'how many files', 'project size', 'how big is this project',
      'file count', 'total files', 'how many files in the project',
      'count files', 'number of files', 'how many source files',
      'how many directories', 'total directories', 'project stats',
      'project statistics', 'how large is this', 'file statistics',
      'total lines of code', 'loc', 'lines of code',
      'how many lines', 'project metrics', 'size of project',
      'how much code', 'codebase size', 'repository size',
      'how big is the codebase', 'whats the file count', 'give me project stats',
      'how many source files are there', 'total number of files',
      'how much is in this repo',
    ],
  },
  'project.context.entry_point': {
    examples: [
      'what is the entry point', 'where does the app start',
      'main file', 'entry point', 'start file', 'where do i start',
      'index file', 'main entry', 'what file runs first',
      'what is the main file', 'starting point',
      'how do i launch this', 'where is the main function',
      'what is the root file', 'where does execution begin',
      'startup file', 'launch file', 'primary entry',
      'what gets run first', 'main entry point',
      'which file is the entry', 'app start file',
      'where does this program begin', 'what file kicks things off',
      'first file that runs', 'bootstrap file', 'initial file',
      'what triggers the app to start',
    ],
  },
  'project.context.tech_preview': {
    examples: [
      'give me a summary', 'project summary', 'tl dr', 'summary',
      'what do i need to know', 'tech overview', 'technical preview',
      'show me the project', 'quick overview', 'what should I know',
      'quick summary', 'brief me', 'executive summary',
      'high level summary', 'quick look', 'at a glance',
      'whats the gist', 'bottom line', 'key points',
      'essential info', 'fast overview',
      'brief overview', 'condensed info', 'key things to know',
      'give it to me short', 'short version please', 'sum it up',
      'in a nutshell', 'headline summary', 'give me the highlights',
    ],
  },
  'project.context.tests': {
    // Intent expansion (Phase 1, 2026-08-03): "run the tests" now dispatches to the new
    // run_tests intent in npmAndFileIntents.js (the one intentional dispatch change of the
    // phase) — that phrase no longer lives here. This intent stays question/information-shaped
    // ("how do i test", "what tests are there"), and per the intent-expansion spec's forbidden
    // list the action-flavored "execute ..."/"kick off ..."/"check test results" phrases stay
    // here rather than moving to run_tests — run_tests is purely "run ..." imperative.
    examples: [
      'how do i test',
      'testing framework', 'what tests are there', 'show tests',
      'test status', 'are there tests',
      'how to run tests',
      'tell me about tests', 'test coverage',
      'what testing tools', 'how to test this', 'unit tests',
      'integration tests', 'test setup', 'testing approach',
      'is there test coverage', 'how is testing done',
      'show test files', 'list tests', 'where are the tests',
      'does this project have tests',
      'execute tests', 'execute the test suite', 'kick off the tests',
      'check test results', 'verify the tests pass',
    ],
  },
  'project.context.dependencies': {
    examples: [
      'show dependencies', 'what packages', 'list dependencies',
      'what does this depend on', 'npm packages', 'requirements',
      'package list', 'dependent packages', 'what packages does it use',
      'show package dependencies', 'what are the dependencies',
      'list packages', 'npm dependencies', 'package requirements',
      'third party packages', 'external packages', 'what libraries',
      'what is imported', 'dependency list', 'what does this need',
      'show me the packages', 'what are the requirements',
      'external dependencies', 'software dependencies',
      'what modules does this rely on', 'show me package.json dependencies',
      'what third party code is used', 'list all packages used',
      'show installed packages', 'whats in requirements.txt',
    ],
  },
  'project.context.config': {
    examples: [
      'show config', 'configuration files', 'config files',
      'what settings', 'environment config', 'env file', 'env',
      'project configuration', 'show configuration', 'config settings',
      'what config files exist', 'show env file', 'display config',
      'configuration details', 'setup files', 'show settings',
      'list config files', 'view configuration', 'config options',
      'what environment variables', 'show the env', 'read config',
      'environment setup', 'settings files', 'project settings',
      'show me the dotenv file', 'what env vars are set', 'show environment variables',
      'display the .env', 'whats in the config folder', 'show config directory',
    ],
  },
  'project.context.routes': {
    examples: [
      'show api routes', 'list api routes', 'what endpoints does this expose',
      'show me the endpoints', 'what routes exist', 'list all routes',
      'what api endpoints are there', 'show http routes', 'what does this app expose over http',
      'list the endpoints', 'show endpoints', 'what urls does this app serve',
      'what are the api routes', 'display api routes', 'api surface',
      'what endpoints are defined', 'show flask routes', 'show express routes',
      'show django urls', 'what routes are defined', 'list the api',
      'what api does this expose', 'show me the routes', 'route list',
      'what get and post routes exist', 'what pages does this serve',
      'show the url patterns', 'what endpoints can i hit',
    ],
  },
  'project.context.file_relations': {
    examples: [
      'which files import this', 'what imports this file', 'who imports this file',
      'which files use this', 'who uses this file', 'what depends on this file',
      'what does this file import', 'what does this file depend on',
      'show imports for this file', 'what imports state.js',
      'which files import utils.js', 'who imports config.js',
      'what uses this module', 'what other files reference this',
      'show what imports this', 'show what this file imports',
      'find files that import this', 'what files depend on this one',
      'trace the imports for this file', 'show dependency links for this file',
      'what is this file used by', 'is this file used anywhere',
      'where is this file imported', 'show me the import graph for this file',
      'what references this file', 'which modules import this one',
      // Added 2026-07-30 (confirmed live — "who uses connection.js" was matching
      // project.knowledge.stack instead, since every example above used a generic "this
      // file"/placeholder shape with no real-looking filename). These give the embedding stage a
      // closer match for the common real phrasing of naming an actual file directly.
      'who uses connection.js', 'who uses this file', 'what uses connection.js',
      'who imports connection.js', 'which files import connection.js',
      'who uses index.js', 'who imports app.py', 'what imports main.py',
      'which files use executor.js', 'who depends on this module',
      'show me who uses this file', 'find who imports this file',
      'what other files use connection.js', 'is connection.js used anywhere',
    ],
  },
  'project.context.monorepo': {
    examples: [
      'is this a monorepo', 'is this a mono repo', 'does this have sub packages',
      'what sub packages exist', 'list sub packages', 'show sub packages',
      'is this project a monorepo', 'how many packages are in this repo',
      'what packages does this monorepo have', 'show me the monorepo structure',
      'is this a multi package repo', 'are there multiple packages here',
      'show workspaces', 'list workspaces', 'what workspaces exist',
      'does this repo have multiple projects in it', 'is this a workspace setup',
      'how is this monorepo organized', 'what are the independent packages here',
    ],
  },
  'project.context.todos': {
    examples: [
      'find all todos', 'show todos', 'list todos', 'find todo comments',
      'show me the todos', 'what todos are in the code', 'find fixme comments',
      'show fixme comments', 'list fixmes', 'find hack comments',
      'show all todo and fixme comments', 'what needs to be done according to the code',
      'search for todos', 'search the codebase for todos', 'any outstanding todos',
      'what todos exist in this project', 'list all todo comments',
      'find leftover todos', 'show unfinished work markers', 'scan for todos',
      'find xxx comments', 'what are the pending todos', 'todo list from code',
      'show me things marked as todo', 'find incomplete markers in the code',
    ],
  },
  'project.context.biggest_files': {
    examples: [
      "what is the biggest file", "what are the biggest files", "show largest files",
      'what is the largest file', 'show the biggest files', 'find the biggest file',
      'which file is the largest', 'show file sizes', 'list files by size',
      'what are the largest files in this project', 'biggest files in the repo',
      'show me the heaviest files', 'which files take up the most space',
      'rank files by size', 'find the largest files', 'show top 10 biggest files',
      'what file is taking up the most space', 'show file size breakdown',
    ],
  },
  'project.context.dev_server_status': {
    // Intent expansion (Phase 1, 2026-08-03): "is the server running" / "is the site live" /
    // "what's the URL" previously had no real intent — it only worked by luck when a config
    // entry or the "what is the link" pre-check in connection.js happened to catch the phrasing.
    // This is the dedicated status path: reads runningProcesses + lastDevUrls (the same data the
    // link pre-check reports) so any phrasing reaches it. Read-only, immediate. Per the intent-
    // expansion spec, "what port is the dev server on" also lives here (the dev server's port);
    // "what port is the server on" deliberately does NOT — system.chit_chat.port already owns
    // that exact phrase (an exact cross-intent dupe would fail check-intents). "what is the
    // link"-family stays owned by the connection.js pre-check (answers equivalently with the
    // same data); this intent covers the variants the pre-check never matched.
    examples: [
      'is the server running', 'is the site live', 'is the dev server running',
      'is the site running', 'is the dev server up', 'is the server up', 'is the app running',
      'is the app live', 'is the site up', 'is the server still running', 'is the website live',
      'is the dev server still up', 'is my dev server running', 'is my server still running',
      'is the local server running', 'is the backend up', 'is the frontend up',
      'is anything running right now', 'check if the server is running',
      'check if the dev server is up', 'check the server status', 'is the dev url up',
      'has the server started', 'did the server start', 'is the server ready',
      'is the site live yet', 'has the dev server booted', 'where is my server running',
      // No "what is the url" / "whats the url" / "what url is it on" / "what is the url of the
      // server" — those exact shapes are caught by connection.js's link pre-check (runs before
      // the matcher) and answer with the same data; including them here would drag the
      // dev_server_status cluster toward "what is the link" and flip that baseline control
      // input away from project.knowledge.stack (measured: "whats the url" scored 0.734 for
      // "what is the link" vs the next-best 0.550). The not-pre-checked variants below stay.
      'whats the dev server url', 'what is the dev server url', 'whats the site address',
      'whats the site url', 'show me the dev url', 'tell me the url', 'what is the server link',
      'what port is the dev server on', 'give me the link to the site',
    ],
  },
  // Intent expansion (Phase 2, 2026-08-03): "what changed recently" — on-demand file-mtime scan
  // (findRecentActivity), NOT git status: this intent answers about file modification times on
  // disk, git_status answers about staged/unstaged changes. "show recent commits" stays with
  // git_log (commit history, not file edits). Note: the bare "what changed recently" phrase is
  // deliberately NOT seeded here — it's already an exact example of system.chit_chat.git_status
  // (a cross-intent exact dupe would fail check-intents), and per the Phase-1 precedent the
  // pre-existing owner keeps it.
  'project.context.recent_activity': {
    examples: [
      'what files changed recently', 'what was modified recently',
      'show recent changes', 'what did i change recently', 'recent file activity',
      'what files were edited recently', 'show me recent file changes',
      'what has been modified lately', 'what did i work on recently',
      'recent changes in the project', 'what changed last',
      'show the latest modified files', 'what files did i touch recently',
      'what files have changed today', 'which files did i edit recently',
      'show me what was modified recently', 'whats been changed recently',
    ],
  },
  'project.context.running_processes': {
    examples: [
      'whats running', 'what is running right now', 'show running processes',
      'list running processes', 'whats still running', 'any processes running',
      'whats running in the background', 'show all running commands',
      'what commands are running', 'list active processes', 'show background processes',
      'whats currently running', 'show me running tasks',
    ],
  },
  'project.context.session_info': {
    examples: [
      'how many chats do i have', 'show my chat history count',
      'how many sessions exist', 'list my recent chats',
      'show recent sessions', 'how many conversations do i have',
      'session count', 'chat count', 'how many chat sessions',
      'show my sessions', 'list sessions', 'what chats do i have',
    ],
  },
  'project.context.scan_servers': {
    examples: [
      'scan for servers', 'scan for running servers', 'which servers are up',
      'which servers are running', 'what servers are up', 'scan the servers',
      'are any servers running', 'check which servers are up', 'scan all projects for servers',
      'what servers are live', 'are the dev servers up', 'scan for dev servers',
      'check all dev servers', 'which dev servers are running', 'are any sites live',
      'scan the projects for servers', 'check every project for a server',
    ],
  },
};
