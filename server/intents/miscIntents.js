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
};
