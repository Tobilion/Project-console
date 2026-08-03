// npm_* and file_* intents — package management/build commands, plus non-AI file operations
// (create/read/append/delete, parsed with regex and gated behind the confirm-before-write flow).
// Split out of intentsData.js (2026-07-30) — see chitChatIntents.js's header comment for why.
export const NPM_AND_FILE_INTENTS = {
  'npm_install': {
    examples: [
      'install dependencies', 'npm install', 'install packages',
      'install node modules', 'install all deps', 'npm i',
      'install project dependencies', 'get the packages',
      'download dependencies', 'install required packages',
      'fetch dependencies', 'install node packages',
      'set up dependencies', 'install npm packages',
      'run npm install', 'install all packages',
      'install the dependencies', 'get node modules',
      'install everything', 'do npm install',
      'install the packages', 'npm install project',
      'install modules', 'install a package',
      'add a package', 'add dependency',
      'pull in the dependencies', 'grab the packages', 'get all packages installed',
      'set up node modules', 'install everything from package.json',
    ],
  },
  'npm_build': {
    examples: [
      'build the project', 'npm run build', 'build it',
      'compile the code', 'build the app', 'npm build',
      'create a build', 'build for production', 'compile',
      'run build', 'build the application', 'do the build',
      'build the site', 'compile project', 'build everything',
      'generate build', 'npm run build for this project',
      'build production', 'build the bundle', 'compile the app',
      'do a build', 'run the project build', 'build project',
      'make a production build', 'build process',
      'package this up', 'bundle the project', 'produce a build',
      'get this ready for production', 'compile for release',
    ],
  },
  'npm_run': {
    examples: [
      'run a script', 'npm run', 'execute a script',
      'run the dev script', 'run the build script',
      'run npm script', 'execute npm script',
      'run a npm script', 'run the test script',
      'run start script', 'npm run start', 'npm run a command',
      'execute a npm command', 'run script from package',
      'run package script', 'trigger npm script',
      'npm run something', 'run a command from package.json',
      'run script', 'execute npm command', 'run npm command',
      'run dev', 'npm run dev', 'start the dev server',
      'launch the dev server', 'run the dev server', 'start developing',
      'run dev server', 'open dev server', 'start the live server',
      'start a live server', 'run the live site', 'launch the live site',
      'start dev mode', 'run in dev mode', 'start development server',
      'start the development server', 'start dev server',
      'fire up the dev environment', 'get the dev server going',
      'boot the dev server', 'spin up dev mode', 'run npm start',
    ],
  },
  'file_create': {
    examples: [
      'create a file', 'make a new file', 'create file',
      'new file', 'create a file called', 'generate a file',
      'make file', 'add a new file', 'create new file',
      'write a new file', 'create a document',
      'make a new document', 'generate new file',
      'create a file named', 'make a file with name',
      'add a file to the project', 'create a text file',
      'new document', 'create a markdown file',
      'create a config file', 'make a new file called',
      'generate a file named', 'write a file',
      'create a source file', 'add a new document',
      'make me a new file', 'i need a new file', 'spin up a new file',
      'set up a new file', 'start a new file',
    ],
  },
  'file_read': {
    examples: [
      'read file', 'read this file', 'show me the file', 'open file',
      'show me the contents of', 'what is in this file', "what's in the file",
      'display the file', 'view the file', 'cat this file', 'print the file',
      'show the contents of', 'read the contents of', 'open this file',
      'what does the file say', 'show me what is in', 'read me the file',
      'can you read this file', 'can you show me this file',
      'let me see this file', 'pull up this file', 'show me whats inside',
      'peek at this file', 'take a look at this file',
    ],
  },
  'file_append': {
    examples: [
      'append to file', 'add a line to the file', 'add this to the file',
      'add a line to', 'append this to the file', 'add to the end of the file',
      'append text to the file', 'add a note to the file',
      'add this line to', 'append a line to', 'add to the bottom of the file',
      'tack this onto the file', 'add this to the end of',
      'append content to', 'add another line to the file',
      'stick this at the end of the file', 'add on to the file',
      'tack on to the end', 'append another entry to',
    ],
  },
  'file_delete': {
    examples: [
      'delete a file', 'remove a file', 'delete file',
      'delete this file', 'remove file', 'delete the file',
      'get rid of this file', 'remove this file',
      'trash this file', 'delete a file from the project',
      'remove a file from the project', 'erase this file',
      'delete that file', 'remove the file',
      'delete the file named', 'remove a file called',
      'get rid of file', 'wipe this file',
      'nuke this file', 'destroy this file', 'kill this file',
      'toss this file', 'clear out this file',
    ],
  },
  'file_find': {
    // Intent expansion (Phase 1, 2026-08-03): "where is the file X" / "find the config file" had
    // no real intent — file_read only showed contents of an exact path, and its "did you mean"
    // fallback only fired after an exact-read failure. This is the dedicated locate/search path:
    // parse the name loosely (same parseFileNameOnly as file_read), then findFiles() across the
    // project. Read-only, immediate. Deliberately no "gitignore" phrasings — the
    // PRE_SEMANTIC_OVERRIDES literal override routes any input containing "gitignore" to
    // git_ignore_add before the matcher ever sees it, so such examples would be unreachable.
    examples: [
      'where is main.py', 'where is the config file', 'find the config file',
      'where is the readme file', 'find the file called', 'locate the file',
      'where is the claude file', 'where does this file live', 'find files like this',
      'where is the env file', 'find the package file', 'where is app.js',
      'find the file named', 'which folder is this file in', 'where is the setup file',
      'search for the file', 'locate a file', 'find a file called',
      'find the entry file', 'where does the file live', 'find me the file',
      'where is the doc file', 'search for files named', 'what folder contains this file',
      'find the styles file', 'where is the data file', 'locate the config file',
      'where can i find this file', 'find the test file', 'find the utility file',
    ],
  },
  'run_tests': {
    // Intent expansion (Phase 1, 2026-08-03): "run the tests" previously only answered ABOUT
    // tests (project.context.tests — informational) or, on NetPulse, matched its `run tests`
    // config entry. This executes the project's real test command by marker detection instead.
    // Kept action-imperative ("run ...") while project.context.tests stays question-shaped
    // ("how do i test", "what tests are there") so the embeddings stay apart. Per the intent-
    // expansion spec, the "execute ..."/"kick off ..." flavored phrases stay in
    // project.context.tests (the spec's forbidden list — they never moved here).
    examples: [
      'run the tests', 'run the test suite', 'run all tests', 'run the unit tests',
      'run the tests now', 'run pytest', 'run the pytest suite', 'run my tests',
      'run the tests please', 'run tests for this project', 'run the test files',
      'lets run the tests', 'run the full test suite', 'run the tests again',
      'run the failing tests', 'run the backend tests', 'run the frontend tests',
      'run the test suite now', 'run my tests please', 'run all the tests', 'run pytest now',
      'can you run the tests', 'please run the tests', 'run the tests for me',
      'run the whole test suite', 'run the tests will you', 'run my tests again',
    ],
  },
};
