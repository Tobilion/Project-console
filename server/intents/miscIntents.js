// Misc intents that don't fit the other categories cleanly: running the active project, and
// project scan/switch commands. Split out of intentsData.js (2026-07-30) — see
// chitChatIntents.js's header comment for why.
export const MISC_INTENTS = {
  'run_project': {
    examples: [
      'can you run the site', 'can you run the code',
      'launch the app', 'open the website', 'run the application',
      'start the server', 'run project', 'start the site',
      'launch project', 'open the project', 'run it', 'start it',
      'can you run it', 'run the app', 'open the site',
      'start the application', 'show me the site',
      'run this project', 'open the app', 'start the program',
      'execute the program', 'launch the program', 'run the program',
      'start the service', 'run the service', 'open the application',
      // Widened 2026-07-30 (requested directly) — the phrases above are all generic/JS-flavored;
      // these give the same imperative "just run it" intent a real chance of matching for the
      // other languages the scanner/trigger-mode now supports, and for the specific tool commands
      // a user familiar with that ecosystem might type directly.
      'run this go project', 'start the go server', 'run the go binary',
      'build and run this go project', 'go run this',
      'run this rust project', 'start the rust binary', 'cargo run this',
      'build and run the rust project', 'compile and run this rust app',
      'run this java project', 'start the java app', 'start the spring boot app',
      'run the spring boot application', 'build and run this java project',
      'run this with maven', 'run this with gradle',
      'run this ruby project', 'start the rails server', 'run the rails app',
      'start this ruby app', 'bundle exec this',
      'run this php project', 'start the php server', 'run the laravel app',
      'start the laravel server', 'serve this php project',
      'run this dotnet project', 'start the c# app', 'run the dotnet app',
      'dotnet run this', 'build and run this c# project',
      'run this flask app', 'start the flask server', 'run the django app',
      'start the django server', 'run this python web app',
      'run this rust binary', 'start this go app', 'run the java server',
      'launch the rust project', 'launch the go project', 'launch the java project',
      'fire up the server', 'spin up the server', 'spin up the app',
      'get this running', 'get this project running', 'boot up the project',
      'boot the app', 'kick off the server', 'fire this up',
    ],
  },
  'project_scan': {
    examples: [
      'rescan project', 'reindex project', 'scan again',
      'refresh project index', 'rebuild index',
      'reindex this project', 'scan the project again',
      'reindex codebase', 'rescan the directory',
      'update the index', 'refresh the codebase index',
      'reindex the codebase', 'update project index',
      'rebuild the index', 'rescan this project',
      'reindex my project', 'fresh scan', 'reindex',
      'refresh index', 'scan the codebase again',
      'take another look at the codebase', 'refresh your knowledge of this project',
      'relearn the project structure', 'update your understanding of this codebase',
    ],
  },
  // Confirmed live 2026-07-29 (CLI chat): "change project" had no real intent of its own and was
  // winning on 'project_scan' by loose semantic similarity (shares "project" + a short imperative
  // shape), returning reindex advice that told CLI users to "restart the console" — misleading,
  // since switching projects has nothing to do with restarting. Real intent, separate from scan.
  'project_list': {
    examples: [
      'change project', 'switch project', 'switch projects',
      'switch to another project', 'change to a different project',
      'different project', 'select another project', 'select a different project',
      'choose a different project', 'list projects', 'show projects',
      'show me the projects', 'what projects are available',
      'what projects do you have', 'list all projects', 'available projects',
      'take me to a different project', 'go to another project',
      'i want to work on a different project', 'swap projects',
      'jump to another project', 'show my other projects',
    ],
  },
// Intent expansion (Phase 2, 2026-08-03, requested directly): an explicit user-asked
// checkpoint commit via createCheckpoint — same flow as the auto-checkpoint before risky
// commands. "checkpoint my work" / "make a save point" deliberately NOT seeded here: those
// exact phrases are already git_commit examples (cross-intent exact dupes would fail
// check-intents) and git_commit answers them equivalently.
'project.workflow.checkpoint': {
  examples: [
    'make a checkpoint', 'create a checkpoint', 'save a checkpoint',
    'make a checkpoint commit', 'checkpoint the project',
    'create a checkpoint commit', 'save my work as a checkpoint',
    'checkpoint', 'create a save point', 'commit a checkpoint',
    'save a checkpoint commit', 'checkpoint my project',
    'make me a checkpoint', 'take a checkpoint', 'checkpoint my progress',
    'save my progress as a checkpoint', 'create a checkpoint now',
  ],
},
// Intent expansion (Phase 3, 2026-08-03): trigger-mode basic calls — deterministic,
// immediate, non-destructive project actions.
'project.action.open_in_vscode': {
  examples: [
    'open in vs code', 'open this in vs code', 'open the project in vs code',
    'open in an editor', 'open in my editor', 'open in vscode',
    'edit this in vs code', 'open project in vs code',
    'open with vs code', 'launch vs code on this', 'start vs code here',
    'open the folder in vs code', 'vs code open', 'open in code editor',
  ],
},
'project.action.open_in_explorer': {
  examples: [
    'open the folder', 'open the project folder', 'show me the folder',
    'show the folder in explorer', 'open the folder in explorer',
    'open file explorer', 'where is the project folder',
    'open folder in file explorer', 'show project in explorer',
    'open this folder', 'browse the project folder',
    'open directory', 'show me the directory', 'open in explorer',
    'open the project directory', 'reveal in explorer',
  ],
},
'project.action.open_site': {
    examples: [
      'open the dev site', 'open the site in the browser',
      'open the link', 'open the url', 'take me to the site',
      'launch the site in a browser', 'open site in browser',
      'open the dev url', 'open the running site',
      'open the web app', 'go to the site',
      'visit the site', 'open the running url',
    ],
  },
'project.action.copy_path': {
  examples: [
    'copy the project path', 'copy the path', 'copy project path',
    'copy the folder path', 'copy path to clipboard', 'copy the file path',
    'copy project directory path', 'put the path in clipboard',
    'copy full project path', 'copy the working directory path',
  ],
},
// Phase 16 (2026-08-05): four more "open in..." actions. Phrasing deliberately avoids the
// pre-existing owners' territory: "open file"/"open this file" are file_read seeds (exact
// dupes would fail check-intents), "open the folder"/"open the project folder" are
// open_in_explorer, "open the link"/"open the dev url" are open_site. Name-bearing open
// inputs ("open main.py", "open the config file") are handled by the PRE_SEMANTIC_OVERRIDE
// in preSemanticOverrides.js — see that file's Phase 16 entry.
'project.action.open_in_terminal': {
  examples: [
    'open a terminal here', 'open a terminal in the project',
    'open a terminal in the project folder', 'open the terminal here',
    'start a terminal here', 'launch a terminal here',
    'open the command prompt here', 'open a command prompt here',
    'open cmd here', 'open a terminal for this project',
    'open a terminal in the project directory',
  ],
},
'project.action.open_github_page': {
  examples: [
    'open the github page', 'open the github repo', 'open the github repository',
    'open the repo on github', 'open the repository on github',
    'open the project on github', 'open the project github page',
    'take me to the github page', 'show me the github page',
    'open my github for this project',
  ],
},
'project.action.open_in_cursor': {
  examples: [
    'open in cursor', 'open this in cursor', 'open the project in cursor',
    'open the folder in cursor', 'open in cursor editor',
    'open the project in cursor editor', 'open with cursor',
    'launch cursor on this', 'start cursor here',
    'open the project with cursor',
  ],
},
'project.action.open_file': {
  examples: [
    'open a file', 'open a specific file', 'open some file',
    'open a particular file', 'open up a file', 'open me a file',
    'open the file called', 'open a file for me',
    'open a file from the project', 'open the readme file',
  ],
},
};
