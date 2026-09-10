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
      'run the app on port 3010',
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
    
      'Project reindex this hey,!',
      'thanks project my reindex',
      'the rebuild now index',
      'rebuild index now :p',
      'reinndex codebase now :p'
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
  
      'asap commit checkpoint a make yo',
      'commit checkpoint please a make',
      'Project hey, checkpoint thanks the :)',
      'a checkpoint proggress hi, save my for me as',
      'create a checkpoint asap :p',
      'COMMIT CHHECKPOINT A CREATE',
      'AS CHECKPOINT HEY SAVE MY PROGRESS A',
      'Commit checkpoint a create yo!',
      'create a checkpoint now htanks :p',
      'save a oint new um',
      'checkpoint a create so',
      'um new a save point',
      'me save a checkpoint for',
      'project the checkpoint',
      'CHECKPOINT A ASAP COMMIT SO 🙏',
      'for me a checkpoint ave',
      'CHECKPOINT A CREATE',
      'create a checkpoint asap 🙏'
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
  
      'Launch project in vs code',
      'editor my in open...',
      'show in vs code',
      'in code hey open vs project :)',
      'the in vs open folder code',
      'DISPLAY FOR ME EDITOR IN AN',
      'in for open vscode me',
      'Please view in vs code quickly :)',
      'open vs in project code',
      'hey, display edtior in code',
      'Can you vs code view :)',
      'Show in vs code',
      'code project in open um vs the',
      'display in vs code now 🙏',
      'code vs in display',
      'open can the you project vs in code!',
      'please in open an editor!!'
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
  
      'Asap folder project the browse so',
      'OPEN FLIE EXPLORER THANKS :P',
      'hi, open foledr in document explorer',
      'in please open the explorer folder',
      'open file explorer for me 🙏',
      'expolrer folder in the open',
      'open quickly um directoy',
      'open the project directory thanks :p',
      'YO OPEN FILE EXPLORER',
      'Could you open file explorer',
      'BROWSE THE PROECT FOLDER NOW',
      'display the project directory',
      'the browse please folder hey, project',
      'FOLDER COULD THIS OPEN YOU',
      'open file explorer thanks',
      'explorer file start',
      'project open the hey me directory for',
      'the open hey folder',
      'the view for folder please me',
      'folder project the browse',
      'open the project directory thanks 🙏',
      'UM START IN EXPLORER PLEASE 🙏',
      'browse the project foldeq',
      'please list me the folder',
      'the browse floder project',
      'um open file explorer',
      'project the browse folder hey,',
      'in ogen explorer :p',
      'open folder explorer in doc',
      'opne this folder'
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
    
      'the poen running site',
      'please open the launchning site thanks',
      'can you launch the site in a browser for me :p',
      'Open site can you in asap broser',
      'The iste take asap me to',
      'OPEEN THE STARTNING URL NOW',
      'display the dev site now',
      'take me to the ste 🙏',
      'Display please url the'
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
  
      'termiinal here a launch',
      'Here prompt launch a command',
      'directory a in project the open terminnal',
      'open me terminal you for can a here',
      'open a terminal here thanks :p',
      'here terminal a start please',
      'could you display the terminal here',
      'Termnal project a open for now this',
      'the open here terminal pleaase',
      'Open prompt please the command here',
      'hey open the terminkl here',
      'OPEN A TERMIINAL IN THE PROJECT FOR ME',
      'show a command promppt here',
      'open the command prompt here now 🙏',
      'me for here terminal a open you can 🙏',
      'start a here command prompt!',
      'COULD YOU DISPLAY A COMMAND PROMPT HERE FOR ME',
      'please view the command prompt here :p',
      'here a terminal open',
      'display a command prompt here quickly',
      'CAN YOU OPEN A TERMINAL IN THE PROJECT FOLDER PLEASE :P',
      'dispay folder a project the terminal in'
      ],
},
'project.action.open_github_page': {
  examples: [
    'open the github page', 'open the github repo', 'open the github repository',
    'open the repo on github', 'open the repository on github',
    'open the project on github', 'open the project github page',
    'take me to the github page', 'show me the github page',
    'open my github for this project',
  
      'on please show repository the github!',
      'open on projetc the github',
      'VIEW THE GITHUB REPOSITORY :P',
      'so start the github reppo',
      'repo open the github',
      'YO SHOW THE REPO ON GITHUB ASAP',
      'hey, what are me the github page',
      'github the open please please repository',
      'display my github for this project',
      'please repo open the github',
      'REPO GITHUB OEN THE',
      'repository the open gxthub',
      'REPO THE GITHUB VIEW',
      'can you open the repo on github for me 🙏',
      'repository the oppen now github',
      'the launch now githhub repository',
      'Page take me github the to',
      'start the project github page please :p',
      'OPEN THE GITHUB PAGE NOW :)',
      'can you start the github repo now'
      ],
},
'project.action.open_in_cursor': {
  examples: [
    'open in cursor', 'open this in cursor', 'open the project in cursor',
    'open the folder in cursor', 'open in cursor editor',
    'open the project in cursor editor', 'open with cursor',
    'launch cursor on this', 'start cursor here',
    'open the project with cursor',
  
      'can you start this in cursor please :)',
      'in cursor show the project!',
      'project the with cursor open',
      'With cuursor open',
      'display the project with cursor',
      'hi, display in cursor editor 🙏',
      'folder the open in hey, cursor',
      'so start the project in cursor',
      'display the project in cursor quickly',
      'in open cursor',
      'CURSOR YOU COULD IN OPEN',
      'PROJECT ASAP CURSOR IN THE OPEN',
      'CURSOR OPEN WITH YO :P',
      'this open in cursor please',
      'project the fpen cursor in',
      'could you open the project in cusor editor'
      ],
},
'project.action.open_file': {
  examples: [
    'open a file', 'open a specific file', 'open some file',
    'open a particular file', 'open up a file', 'open me a file',
    'open the file called', 'open a file for me',
    'open a file from the project', 'open the readme file',
  
      'UP A DOC OPEN PLEASE HEY,',
      'um file a open 🙏',
      'please display a file from the project',
      'hi, open a particular document',
      'opn up a file',
      'hi, launch a file for me',
      'open a doc from the project quickly',
      'OPEN A DOC FOR ME',
      'show a specific file quickly',
      'display me a file now',
      'the called open file',
      'Show me a file 🙏',
      'open a doc from the project',
      'COULD A PARTICULAR FILE YOU OPEN',
      'hi, view the file called!!',
      'can you open a doc from the project 🙏',
      'LAUNCH THE FILE CALLED',
      'file start called the',
      'display a file',
      'um display some file!!',
      'Yo view a file',
      'hi, a launch up file',
      'open the doc called',
      'um start some file',
      'LAUNCH ME A FILE',
      'CALLED DOCUMENT THE OPEN',
      'please lanuch some file...',
      'show me a file quickly',
      'FILE OPEN A PARTICULAR',
      'Hey open a document'
      ],
},
// Phase T (2026-08-14): open a plain .html file in the DEFAULT BROWSER (not the editor) —
// the .html-bearing shapes are pinned by a pre-semantic override (an "open X.html" ask means
// render, never edit; the open_file override would otherwise send it to VS Code). Examples
// deliberately avoid open_site's "open the site/url/link" territory and open_github_page's
// "open the github page" — a browser-mention here means a local file, never a running server.
'project.action.open_html': {
  examples: [
    'open index.html in the browser', 'open the html file in the browser',
    'preview the page', 'preview index.html', 'open the page in the browser',
    'show the html file in the browser', 'view the html file',
    'open the html page in a browser',
  ],
},
// Phase T2 (2026-08-14): open a file in a chosen IDE — the editor registry lives in
// Settings → Editors & IDEs (data/editors.json); "in the editor" uses the per-extension
// default. Examples deliberately avoid open_file's name-bearing seeds ("open a file") and
// the open_in_* editor verbs (vs code/cursor are separate intents with their own pins).
'project.action.open_with': {
  examples: [
    'open main.py with pycharm',
    'open app.ts in intellij', 'open report.pdf in webstorm',
    'open the config file in the editor', 'open file.py with the editor',
    'open main.py in the default editor',
  ],
},
// Phase T2: reveal a FILE in the OS file explorer (folder opens with the file selected).
'project.action.reveal_file': {
  examples: [
    'open main.py in the folder', 'show file.py in explorer',
    'open the config file in the folder', 'reveal main.py in file explorer',
    'show index.html in the folder', 'open notes.txt in explorer',
  ],
},
};
