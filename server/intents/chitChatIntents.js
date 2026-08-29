// System/chit-chat intents — greetings, status checks, gratitude, farewell, identity questions,
// and a handful of system-level one-word commands (clear, help, monitoring). Split out of the
// single ~970-line intentsData.js (2026-07-30, requested directly — "make it easier to manage")
// into category files merged back together in intentsData.js; no behavior change from this split,
// same INTENTS keys/examples as before.
export const CHIT_CHAT_INTENTS = {
  'system.chit_chat.greeting': {
    examples: [
      'hi', 'hello', 'hey', 'yo', 'good morning', 'good evening',
      'good afternoon', 'greetings', 'hey there', 'hi there', 'howdy',
      'whats up', 'howdy partner', 'ello', 'hiya', 'hey hey', 'morning',
      'evening', 'how are you today', 'hello there',
      'ey up', 'wassup', 'whats good', 'yo yo', 'greetings and salutations',
      'hey what is up', 'hello friend', 'hi there buddy', 'hello world',
      'helloo', 'hellooo', 'heyy', 'hiiii', 'hi how are you', 'afternoon',
      'good day', 'howdy do', 'whats crackin', 'whats happening', 'ayy',
      'hey there friend', 'hi again', 'hello again',
      'yo whats good', 'hi im back', 'hey im back', 'hello again friend',
      'oi', 'alright then', 'top of the morning', 'evenin', 'mornin',
      // 2026-08-26 live crosscheck: the apostrophe forms missed — 'whats up' was in the set
      // but "what's up" and "how's it going" fell to the fallback; the embedding treats the
      // contraction as a different token.
      "what's up", "whats going on", "how's it going", 'how is it going', 'sup',
      'hows things', 'hiya there', 'well hello', 'hello hello',
      'greetings friend', 'good to see you', 'nice to see you',
      'howdy doody', 'what is up', 'what is good', 'hello everyone',
      'hey everybody', 'hi all', 'good to be here', 'back again',
      'returning', 'just got here', 'arrived',
    ],
  },
  'system.chit_chat.status': {
    examples: [
      'how are you', 'how are you doing', "how's it going", "what's up",
      'how is everything', 'sup', "what's happening", 'how are things',
      'are you there', 'you awake', 'how is it going', "how's life",
      "how's your day", 'you good', 'everything okay', 'what are you doing',
      'how do you feel', 'how is your day going', "how's tricks",
      "how's it hanging", 'you alive', 'still there', 'status report',
      'are you listening', 'how goes it', "how's everything going",
      'whats new', 'whats going on', 'how have you been',
      'how are you feeling today', 'you doing okay', 'all good',
      'how are you doing today', 'what are you up to',
      'you still with me', 'everything running fine', 'is everything working',
      'you doing alright', 'all systems go', 'you functioning okay',
      'how are things going', 'is it all good', 'is everything fine',
      'you working properly', 'checking in', 'just checking in',
      'you there', 'you still there',
      'are you awake', 'still alive', 'ping', 'pong',
      'everything running', 'all good still', 'how is the project',
      'console status', 'are you up', 'system status',
    ],
  },
  'system.chit_chat.gratitude': {
    examples: [
      'thanks', 'thank you', 'thank you very much', 'awesome', 'great thanks',
      'appreciate it', 'much appreciated', 'thanks a lot', 'thanks so much',
      'cheers', 'thank you kindly', 'thanks a bunch', 'many thanks',
      'thanks a ton', 'that is great thanks', 'thanks friend',
      'thank you so much', 'much obliged', 'i appreciate that',
      'that is very helpful thanks', 'kudos', 'props to you',
      'you are the best', 'thank you very helpful', 'great job thanks',
      'nice one thanks', 'perfect thank you', 'good stuff thanks',
      'thanks for the help', 'appreciate the help', 'thank you so kindly',
      'ty', 'tysm', 'thx', 'thnx', 'much love for the help',
      // 2026-08-26 live crosscheck: the contraction form "you're the best" missed while
      // 'you are the best' was in the set — a real compliment dead-ended on the fallback.
      "you're the best", 'i like this app', 'this app is great', 'i love this',
      'that helped a lot thanks', 'nice work thanks', 'solid thanks',
      'good looking out thanks', 'you rock', 'legend thanks',
      'this was helpful thanks', 'great stuff', 'perfect thanks a lot',
      'good job', 'nice work', 'great job', 'well done',
    ],
  },
  'system.chit_chat.farewell': {
    examples: [
      'bye', 'goodbye', 'see you later', 'see ya', 'catch you later',
      'talk to you later', 'later', 'im done', 'im done for now',
      'that is all for now', 'thats all for now', 'im heading out',
      'gotta go', 'i have to go', 'see you soon', 'until next time',
      'im leaving now', 'signing off', 'logging off', 'im out',
      'peace out', 'take care', 'have a good one', 'good night',
      'night night', 'im done for the day', 'closing this up',
      'thats it for today', 'ill be back later', 'ttyl',
      'farewell', 'im finished for now', 'wrapping up',
      'see you next time', 'bye bye', 'so long', 'adios',
      'cheerio', 'until later', 'im off', 'heading out now',
      'thats it', 'all done', 'finish', 'done for now',
    ],
  },
  'system.chit_chat.identity': {
    examples: [
      'who are you', 'what are you', 'what are you exactly',
      'tell me about yourself', 'introduce yourself', 'what is the local console',
      'what is project console', 'are you an ai', 'are you chatgpt',
      'are you a chatbot', 'what model are you', 'are you using ai',
      'do you use ai', 'are you ollama', 'what powers you',
      'how do you work', 'what is this tool', 'what kind of assistant are you',
      'explain what you are', 'what exactly are you', 'what is this program',
      'what is this application', 'describe yourself', 'who am i talking to',
      'is this ai or scripted', 'do you run locally', 'are you local',
      'is my data private', 'does this send data anywhere',
      // 2026-08-26 live crosscheck: "what's your name" fell to the fallback — the name
      // questions were never in the set.
      "what's your name", 'what is your name', 'your name', 'do you have a name',
      'what makes you different from chatgpt', 'are you an llm',
    ],
  },
  'system.chit_chat.clear': {
    examples: [
      'clear', 'clear console', 'clear chat', 'cls', 'clean screen', 'reset',
      'clear the screen', 'wipe the console', 'clear the chat',
      'clear everything', 'reset the console', 'clean up',
      'clear messages', 'wipe chat', 'clean the screen',
      'start fresh', 'clear this', 'reset chat', 'clear all',
      'clear window', 'wipe this clean', 'new screen',
      'blank the screen', 'flush the console', 'reset terminal',
      'wipe terminal', 'empty the chat', 'clear out the chat',
      'get rid of all this text', 'start over', 'restart the chat view',
    ],
  },
  'system.chit_chat.help': {
    examples: [
      'help', 'what can you do', 'show me what you can do',
      'how do i use this', 'commands list', 'available commands',
      'what commands', 'show commands', 'how does this work',
      'show available commands', 'help me',
      'i need help', 'what can i do', 'give me help',
      'help please', 'what are my options', 'show help',
      'what functionality do you have', 'what can you do for me',
      'how do i use you', 'what is available', 'list all commands',
      'show all commands', 'what features are there',
      'what are the available actions', 'commands help',
      'tutorial', 'how to use', 'guide me',
      'what can this console do', 'show me your capabilities', 'capabilities',
      'what is possible here', 'menu', 'show menu', 'options',
      'what can i say to you', 'list everything you can do',
      'im lost help', 'i dont know what to do', 'confused, help',
      'need assistance', 'assist me', 'point me in the right direction',
    ],
  },
  // Phase 10 (2026-08-12): the full catalog printed as plain text — "list commands" /
  // "help all" render EVERY consoleCommandDocs.js entry (grouped by category), the CLI's
  // equivalent of the web Command Reference tab. Kept separate from 'help' so the one-word
  // help keeps its compact buildHelpMessage summary. Deliberately NO "show ..." shapes
  // ("show everything you can do" is status-shaped and drifted off the status intent —
  // same corpus-collision lesson as Phase 1.5's openers).
  'system.chit_chat.list_commands': {
    examples: [
      'list commands', 'help all', 'list all commands', 'show all commands',
      'full command list',
    ],
  },
  'system.chit_chat.git_status': {
    examples: [
      'git status', 'show changes', 'check git', 'what changed',
      'show me the git status', 'any changes', 'latest changes',
      'what changes have been made', 'what changed recently',
      'show git log', 'recent commits', 'commit history',
      'show me what changed', 'what is new', 'any uncommitted changes',
      'show git status', 'what files changed', 'git changes',
      'check git status', 'display git log',
      'uncommitted changes', 'unstaged changes',
      'what have i changed', 'git diff summary', 'modified files',
      'show modified files', 'git changes today',
      'what is the git status', 'show changes since last commit',
      'are there any changes', 'pending changes', 'git check',
      'whats the status', 'repo status', 'is anything modified',
      'have i changed anything', 'anything to commit', 'is the working tree clean',
      'is my working directory clean', 'do i have unsaved changes',
      'is there anything uncommitted', 'show working tree status',
      // 2026-08-26 live crosscheck: yes/no state questions about pushing/committing — the
      // pre-semantic pin routes them here; the examples keep the embedding/fuzzy tiers
      // aligned with the pin so a marginal phrasing doesn't drift back to the action intents.
      'did i push yet', 'have i pushed', 'have i pushed recently', 'is it pushed',
      'did my push go through', 'are my changes pushed', 'is my work committed',
      'did i commit', 'is everything pushed', 'is everything committed',
      // 2026-08-26: "check the repo state" dead-ended on the fallback (DYM pointed at
      // git_status) — the repo-state phrasing now belongs to the example set.
      'check the repo state', 'repo state',
    ],
  },
  'system.chit_chat.deploy': {
    examples: [
      'deploy', 'deploy the site', 'deploy this', 'deploy to production',
      'push live', 'ship it', 'push to git', 'push my changes',
      'deploy to vercel', 'publish the site', 'go live',
      'push this live', 'deploy my changes', 'send it live', 'get this pushed',
      'push this to github', 'deploy the project',
      'deploy to server', 'push to github', 'ship this',
      'release the project', 'deploy everything', 'make it live',
      'publish to production', 'push to production', 'deploy my project',
      'send to production', 'upload to production', 'release this',
      'go to production', 'deploy to the server', 'ship to production',
      'push it', 'push these changes', 'deploy this to vercel',
      'deploy to hosting', 'launch the site', 'put this live',
      'time to deploy', 'lets deploy this', 'get this out the door',
      'ship the code', 'let the world see this', 'send this out',
      'roll this out', 'roll out to production', 'kick off a deploy',
      'trigger a deploy', 'ready for deployment', 'deploy now',
    ],
  },
  'system.chit_chat.where_are_logs': {
    examples: [
      'where are my logs', 'where is the log file', 'log file location',
      'diagnostic logs', 'crash log', 'show me the logs', 'where are the logs',
    ],
  },
  'system.chit_chat.export_logs': {
    examples: [
      'export logs', 'bundle logs', 'collect logs', 'share logs',
      'attach logs', 'bundle the logs', 'collect diagnostics', 'export diagnostics',
    ],
  },
  'system.chit_chat.explain_followup': {
    examples: [
      'explain more', 'tell me more', 'elaborate', 'deep dive',
      'give me more details', 'go deeper', 'expand on that',
      'more info please', 'details please', 'explain further',
      'break it down further', 'give me the details', 'elaborate on that',
      'can you elaborate', 'tell me in detail', 'go into more detail',
      'explain in detail', 'i need more information', 'details',
      'more details', 'tell me everything', 'expand on this',
      'give me the full picture', 'break it down', 'explain thoroughly',
      'what else can you tell me', 'tell me more about that',
      'go into detail', 'expand', 'more information',
      'keep going', 'continue', 'say more', 'unpack that',
      'dig deeper', 'get more specific', 'be more specific',
      'give me more context', 'flesh that out', 'add more detail',
    ],
  },
  'system.chit_chat.undo': {
    examples: [
      'undo', 'undo last command', 'undo that', 'revert', 'go back',
      'rollback', 'undo the last change', 'revert last action',
      'undo my last action', 'cancel last change', 'take that back',
      'undo previous command', 'revert the last command',
      'undo this', 'undo what i just did', 'go back to before',
      'revert changes', 'undo the change', 'reverse last action',
      'cancel that', 'never mind undo', 'roll back the last change',
      'revert the last change', 'put it back', 'restore',
      'undo that last thing', 'that was a mistake undo it', 'oops undo',
      'scratch that', 'unwind the last change', 'undo my last edit',
      'i made a mistake revert it', 'revert to before', 'go back one step',
    ],
  },
  'system.chit_chat.yes_no': {
    examples: [
      'yes', 'yeah', 'yep', 'sure', 'do it', 'go ahead', 'confirm',
      'approve', 'yes please', 'yeah do it', 'sure go ahead',
      'okay', 'ok', 'fine', 'alright', 'yes go ahead',
      'please proceed', 'do it please', 'yep do it', 'affirmative',
      'thats right', 'correct', 'no', 'nope', 'nah', 'cancel',
      'do not do it', 'stop', 'abort', 'never mind', 'dont',
      'no thanks', 'not now', 'skip', 'decline', 'reject',
      'please no', 'no do not', 'negative', 'nope cancel',
      'yup', 'yeaa', 'ye', 'sounds good', 'go for it', 'lets do it',
      'proceed', 'i confirm', 'confirmed', 'no way', 'absolutely not',
      'nah dont', 'hold off', 'not yet', 'hold on',
      'y', 'n', 'y please', 'n thanks',
    ],
  },
  // Confirmed live 2026-07-30 (CLI chat): "what port are you running on" had no real intent and
  // fell through to a generic chit-chat status reply ("I'm running and ready on [X]. What do you
  // need?") — technically not wrong, but it never actually answered the question, even though
  // `state.serverPort` (added earlier for the port-collision warning) already has the real value.
  'system.chit_chat.port': {
    examples: [
      'what port are you running on', 'what port is this running on',
      'what port is the server on', 'which port are you on',
      'what port is this on', 'what port', 'which port is the console using',
      'what port is the console on', 'what url are you running on',
      'tell me the port number', 'whats the local port', 'give me the port',
    ],
  },
  // Phase 0 (2026-08-10): utility intents — plain server-computed facts that need no project
  // context and no model call. Time and date deliberately split into two intents so answers can
  // be precise instead of one intent deciding whether the user asked for a clock or a calendar.
  'system.chit_chat.time': {
    examples: [
      'what time is it', 'what time is it right now', 'whats the time',
      'what is the current time', 'current time', 'tell me the time',
      'whats the current time', 'what time is it now', 'give me the time',
      'do you know what time it is', 'what is the time right now',
    ],
  },
  'system.chit_chat.date': {
    examples: [
      'whats the date', 'what is the date', 'what is todays date',
      'whats todays date', 'what date is it', 'what day is it',
      'what day is today', 'what is today', 'current date', 'todays date',
      'whats today', 'what day of the week is it', 'which day is it',
      'give me the date', 'whats the date today', 'what is the date today',
    ],
  },
  'system.chit_chat.calculate': {
    opensPanel: 'calculator',
    examples: [
      'what is 12 times 7', 'whats 340 divided by 4', 'what is 5 plus 3',
      'whats 10 minus 4', 'calculate 2 plus 2', 'what is 8 times 6',
      'whats 100 divided by 5', 'what is 2 plus 2', 'whats 9 times 9',
      'calculate 144 divided by 12', 'what is 25 minus 13', 'whats 7 times 8',
      'calculate 50 plus 25', 'what is 100 minus 37', 'whats 11 times 11',
      // Phase 6 (2026-08-12): unit conversions + percentage/tax/tip shapes.
      'convert 5 km to miles', 'convert 2 liters to cups', 'convert 100 fahrenheit to celsius',
      'how many cups in 2 liters', 'what is 15% of 80', 'whats 18% tip on 64.50',
      'add 8.25% tax to 120', 'calculate 20% tip on 45',
    ],
  },
  // Phase 1 (2026-08-10): "how do I ..." guidance intent. Questions about console features
  // (scheduling, exports, theme, models, packs, learning/telemetry commands) previously had no
  // route and fell to the generic fallback; the handler answers from the consoleCommandDocs.js
  // catalog. Examples deliberately exclude run/open/push/stop-shaped phrasings — those belong to
  // run_project/how_to_run/deploy/stop-server and must not be stolen.
  // Phase 9 (2026-08-11): "how do you / how to / command to / what is the command to" shapes
  // added per request — the consoleCommandDocs.js catalog now carries shell commands + example
  // phrases, so "what is the command to push" answers with the command AND the phrases. Still
  // no run/open/push/stop-ONLY shapes: those keep routing to the project-specific handlers.
  'system.chit_chat.how_do_i': {
    examples: [
      'how do i export this chat', 'how can i export this chat',
      'how do i export the chat log', 'how do i download this conversation',
      'how can i save this conversation', 'how do i export to pdf',
      'how do i schedule a command', 'how can i schedule a command',
      'how do i create a schedule', 'how do i set up a timer',
      'how do i change the theme', 'how can i change the theme',
      'how do i switch themes', 'how do i turn on dark mode',
      'how do i add an ai model', 'how can i add a model',
      'how do i install a model', 'how do i use a cloud model',
      'how do i install a pack', 'how can i install custom tools',
      'how do i add tools', 'how do i review my learning',
      'how can i check telemetry', 'how do i check collisions',
      'how do i use the commands', 'how can i use the console commands',
      'how do i use a command', 'how do i configure this console',
      'how can i customize the console', 'how do i switch projects',
      'how can i change projects', 'how do i see the dashboard',
      'how can i see the dashboard', 'how do i view running processes',
      'how can i check running processes',
      // Phase 9 question shapes (catalog answers carry command + phrases + run chip):
      'how do you push to github', 'how to push to github',
      'what is the command to push', 'command to push to github',
      'how do you commit changes', 'how to commit changes',
      'what is the command to commit', 'command to commit my changes',
      'how do you check git status', 'how to check git status',
      'what is the command to check git status',
      'how do you open this in vs code', 'how to open this in vs code',
      'what is the command to open in vs code',
      'how do you run the tests', 'how to run the tests',
      'what is the command to run the tests',
      'how do you check the console health', 'how to check the console health',
      'what is the command to check the console health',
      'how do you export this chat', 'how to export this chat',
      'what is the command to export this chat',
      'how do you schedule a command', 'how to schedule a command',
      'what is the command to schedule a command',
      'how do you see the dashboard', 'what is the command to see the dashboard',
    ],
  },
  'system.chit_chat.needs_ai_mode': {
    examples: [
      'turn on ai mode', 'enable ai mode', 'use ai mode',
      'use the ai assistant', 'ask the ai', 'let the ai handle it',
      'activate ai mode', 'can the ai do this', 'use ai for this',
      'do it with ai', 'ask the ai model', 'use ai',
    ],
  },
  'system.chit_chat.ack': {
    examples: [
      'nice', 'cool', 'great', 'perfect', 'nice one',
      'good stuff', 'sweet', 'thats great',
      'awesome work', 'cool cool',
      // 2026-08-26 live crosscheck: "ok"/"okay"/"lol"/"haha" fell to yes_no ("No pending
      // confirmation") or the project-size intent — common acknowledgments now ack.
      'ok', 'okay', 'k', 'kk', 'lol', 'haha', 'hehe', 'got it', 'gotcha', 'i see',
      'understood', 'alright', 'fine', 'sounds good', 'noice',
      'hmm', 'uh huh', 'just chatting', 'again', 'do it again', 'one more time',
      'try again', 'once more',
    ],
  },
  'system.chit_chat.joke': {
    examples: [
      'tell me a joke', 'make me laugh', 'give me a joke',
      'got any jokes', 'tell a joke', 'say something funny',
      'joke for me', 'tell me something funny',
    ],
  },
  'system.monitoring.metrics': {
    examples: [
      'show metrics', 'view metrics', 'monitoring', 'monitor',
      'show stats', 'view stats', 'performance stats',
      'latency metrics', 'pipeline metrics', 'show monitoring',
      'system metrics', 'console stats', 'metrics dashboard',
      'show performance', 'how is the console performing',
      'response times', 'show response times', 'metrics report',
      'display metrics', 'check performance', 'health check',
      'is everything healthy', 'system health', 'how fast is this running',
      'show me latency numbers', 'give me a health report',
    ],
  },
};
