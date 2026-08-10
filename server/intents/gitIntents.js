// git_* intents — every git action the console supports in trigger mode, from push/commit
// through the newer diff/stash/branch-create additions. Split out of intentsData.js (2026-07-30)
// — see chitChatIntents.js's header comment for why.
export const GIT_INTENTS = {
  'git_push': {
    examples: [
      'push to origin', 'push my code', 'upload to github', 'sync my changes',
      'deploy to git', 'send to remote', 'push this branch', 'git push my commits',
      'upload my changes', 'push changes to remote', 'submit to github',
      'push to master', 'sync to remote', 'update the remote repo',
      'deploy my changes to git', 'send this upstream', 'push to main',
      'upload to git', 'sync with github', 'push commits',
      'push this to origin', 'git push origin', 'push to the remote',
      'send my code to github', 'push my branch', 'git push current branch',
      'upload code to repository', 'push to upstream',
      'sync my local changes', 'push local commits', 'remote push',
      'push the code', 'push the branch', 'push all changes',
      'push these commits', 'send changes to remote',
      'push to the server', 'push to repo', 'git push to origin',
      'upload commits to github', 'sync to the cloud',
      'push my work', 'get my code up to github', 'send my commits up',
      'push it up', 'push this up to github', 'shoot this up to github',
      'push these to origin', 'fire off a push',
    ],
  },
  'git_commit': {
    examples: [
      'commit my changes', 'commit with message', 'save my work',
      'commit everything', 'create a commit', 'save my changes',
      'make a commit', 'commit my code', 'commit the changes',
      'save and commit', 'commit this', 'commit my work',
      'commit changes with message', 'do a commit', 'git commit',
      'record my changes', 'save my progress', 'commit all files',
      'make a save point', 'commit staged changes',
      'commit with a description', 'save to git', 'commit now',
      'take a snapshot', 'git commit changes', 'save my code',
      'create a git commit', 'commit project', 'commit current state',
      'lock in these changes', 'checkpoint my work', 'save this checkpoint',
      'commit whats staged', 'finalize this commit', 'commit right now',
    ],
  },
  'git_commit_push': {
    examples: [
      'commit and push', 'save and push', 'commit and upload',
      'commit then push', 'add commit push', 'git add commit push',
      'save and upload to github', 'commit and push to origin',
      'do a commit and push', 'commit and sync', 'save commit push',
      'commit everything and push', 'check in and push',
      'git commit and push', 'stage commit push', 'save and sync',
      'commit and send to remote', 'commit all and push',
      'make a commit and push', 'do the full git flow',
      'save and get this up to github', 'commit this and send it up',
      'do the commit and push flow', 'finish and push',
    ],
  },
  'git_remote_add': {
    examples: [
      'add the github link', 'attach the github link', 'add a remote',
      'set the remote url', 'add remote origin', 'connect this to github',
      'link this to a github repo', 'add my repo url', 'set the github link',
      'attach github', 'connect to github repo', 'add the github repo url',
      'set up the remote', 'point this at my github repo', 'add remote origin url',
      'attach my repository link', 'link to github', 'set remote origin',
      'can i attach the github link', 'add the repo link',
      'hook this up to github', 'wire this up to my repo',
      'set my github repo as the remote', 'point to my github repository',
    ],
  },
  'git_add': {
    examples: [
      'stage changes', 'add files', 'git add', 'stage my changes',
      'add to staging', 'stage everything', 'add all files',
      'git add all', 'stage my files', 'add changes to git',
      'stage the changes', 'add to index', 'git add everything',
      'stage all changes', 'add files to git', 'prepare for commit',
      'stage all', 'add all changes', 'git add current directory',
      'track new files', 'add new files to git', 'stage all files',
      'get everything ready to commit', 'stage up everything',
      'add everything to staging', 'prep all changes for commit',
    ],
  },
  'git_init': {
    examples: [
      'initialize git', 'init a repo', 'start git', 'create a git repo',
      'set up git', 'git init', 'initialize repository',
      'create repository', 'start a git repository',
      'init git repo', 'create a new repo', 'set up version control',
      'initialize version control', 'start tracking with git',
      'create git repository', 'initialize a git repo',
      'set up git tracking', 'make this a git project',
      'start git tracking', 'create new git repo',
      'turn this into a git repo', 'get git set up here',
      'begin version control', 'set this folder up with git',
    ],
  },
  'git_ignore_add': {
    examples: [
      'add to gitignore', 'add to git ignore', 'ignore a file',
      'gitignore this', 'add node_modules to gitignore',
      'add file to gitignore', 'add to ignore list',
      'ignore this file', 'make git ignore this',
      'add entry to gitignore', 'put in gitignore',
      'add to the ignore file', 'ignore this folder',
      'git ignore add', 'add something to gitignore',
      'exclude from git', 'stop tracking but keep file',
      'add .env to gitignore', 'ignore this directory',
      'dont track this file', 'make git ignore this file',
      'add to git ignore list', 'ignore file in git',
      'keep this out of git', 'dont let git see this file',
      'exclude this folder from version control', 'add build folder to gitignore',
    ],
  },
  'git_rm_cached': {
    examples: [
      'remove from git', 'untrack file', 'stop tracking',
      'remove from git tracking', 'git rm cached', 'untrack this file',
      'remove from version control', 'stop tracking this file',
      'remove node_modules from git', 'untrack a file',
      'remove from git index', 'git remove tracking',
      'remove file from git', 'untrack this folder',
      'remove from source control', 'stop git tracking',
      'remove from repository', 'git stop tracking',
      'unstage a file', 'remove from staging',
      'take out of git', 'stop versioning this file',
      'remove this from git', 'untrack these files',
      'remove directory from git',
      'take this file off git tracking', 'stop git from tracking this',
      'drop this from version control', 'remove this folder from tracking',
    ],
  },
  'git_log': {
    examples: [
      'show commit history', 'git log', 'view commits',
      'show recent commits', 'list commits', 'commit log',
      'git history', 'show git history', 'view git log',
      'list recent commits', 'show me the commits',
      'commit history please', 'show git commits',
      'display commit log', 'view commit history',
      'recent git activity', 'git commits list',
      'show all commits', 'git log history',
      'show last commits', 'recent commits list',
      'whats the commit history look like', 'show me past commits',
      'log of commits', 'give me the commit log',
    ],
  },
  'git_branch': {
    examples: [
      'list branches', 'show branches', 'git branch',
      'what branch am i on', 'current branch', 'view branches',
      'show git branches', 'list all branches', 'git show branch',
      'what branch', 'check current branch', 'list git branches',
      'show all branches', 'display branches',
      'what is my current branch', 'branches list',
      'tell me the current branch', 'active branch',
      'what branch is checked out', 'show me all the branches',
      'which branch am i working on', 'name of current branch',
    ],
  },
  'git_checkout': {
    examples: [
      'switch branch', 'checkout branch', 'git checkout',
      'change branch', 'switch to another branch',
      'checkout a branch', 'switch to branch',
      'change to a different branch', 'move to branch',
      'checkout different branch', 'switch git branch',
      'change my branch', 'checkout the branch',
      'switch to a branch', 'move to another branch',
      'hop to a different branch', 'jump to branch', 'go to branch',
      'switch over to another branch',
    ],
  },
  'git_pull': {
    examples: [
      'git pull', 'pull from remote', 'pull latest',
      'fetch and merge', 'sync with remote', 'update from remote',
      'pull changes', 'fetch latest', 'get latest changes',
      'pull from origin', 'git fetch and merge',
      'pull the latest', 'update my branch', 'get updates',
      'pull remote changes', 'sync with origin',
      'fetch from remote', 'pull the changes',
      'get the latest code', 'update from git',
      'grab the newest changes', 'catch up with remote', 'bring my branch up to date',
      'sync my repo', 'get everything up to date',
    ],
  },
  'git_fetch': {
    // Intent expansion (Phase 2, 2026-08-03): read-only fetch — updates remote-tracking refs
    // without touching the working tree. Deliberately no "pull"-shaped phrases (git_pull owns
    // those, and pulling is fetch+merge — a mutation). "fetch the latest"-style phrasings sit
    // close to git_pull's "fetch latest" example; measured post-registration, see CLAUDE.md.
    examples: [
      'git fetch', 'fetch from origin', 'fetch the latest', 'fetch the remote',
      'fetch updates', 'fetch from the remote', 'download the latest refs',
      'update my remote refs', 'fetch upstream', 'fetch the latest from origin',
      'sync remote refs', 'fetch latest commits', 'run a git fetch',
      'fetch all the remote refs', 'fetch the branches from origin',
      'fetch the new commits from the remote', 'do a fetch',
    ],
  },
  'git_ahead_behind': {
    // Intent expansion (Phase 2, 2026-08-03): "am I behind origin" — git status -sb prints
    // "[origin/main: ahead 2, behind 1]" directly. Question-shaped only; "pull"-flavored
    // phrasings stay with git_pull (that's the mutation).
    examples: [
      'is my branch behind origin', 'is my branch ahead of origin',
      'am i behind the remote', 'am i ahead of the remote',
      'is my code up to date with origin', 'is my branch in sync with origin',
      'how far behind am i', 'how far ahead am i',
      'what is the state of my branch vs origin', 'is my local branch behind',
      'is my branch behind the remote', 'check if i am behind origin',
      'is my work synced with the remote', 'is my branch up to date',
      'is my code in sync with the remote', 'am i up to date with origin',
    ],
  },
  'git_tag': {
    // Intent expansion (Phase 2, 2026-08-03): list = immediate, create = confirm-gated (handler
    // mirrors git_branch_create's isSafeParamValue + pendingConfirmations flow).
    examples: [
      'list tags', 'list git tags', 'show tags', 'show git tags',
      'what tags exist', 'what tags do i have', 'git tag list', 'show all tags',
      'create a tag called v1.0', 'make a tag named v1.0', 'create tag v1.0',
      'make a tag called v1.0', 'tag this commit as v1.0',
      'tag the current commit v1.0', 'add a tag called v1.0',
      'create a git tag', 'make a git tag', 'tag this as v1.0',
      'set a tag v1.0', 'create a new tag', 'create a tag named release',
      'make a new tag', 'show me the tags', 'what tags are there',
    ],
  },
  'git_diff': {
    examples: [
      'git diff', 'show diff', 'show me the diff', 'show the full diff',
      'what exactly changed', 'show line by line changes', 'diff the changes',
      'show detailed changes', 'view the diff', 'display the diff',
      'show me line changes', 'what are the exact changes', 'full diff please',
      'show code diff', 'diff my changes', 'view code changes in detail',
      'show the actual diff', 'what lines changed', 'detailed diff',
    ],
  },
  'git_stash': {
    examples: [
      'stash changes', 'git stash', 'stash my changes', 'stash this',
      'shelve my changes', 'stash the changes', 'save changes for later',
      'stash everything', 'stash uncommitted changes', 'temporarily save my changes',
      'put my changes aside', 'stash my current work', 'shelve these changes',
      'set aside my changes', 'stash working directory', 'stash all changes',
    ],
  },
  'git_stash_pop': {
    examples: [
      'stash pop', 'git stash pop', 'restore stashed changes', 'unstash changes',
      'pop the stash', 'bring back my stashed changes', 'restore my stash',
      'apply stashed changes', 'get my stashed changes back', 'unstash my work',
      'bring back the stash', 'restore my shelved changes', 'pop stash',
      'apply the stash', 'get back my stashed work',
    ],
  },
  'git_stash_list': {
    examples: [
      'list stashes', 'list my stashes', 'show stashes',
      'what stashes exist', 'git stash list', 'show my stashed work',
      'what is in my stash', 'show stashed changes', 'list the stashes',
      'what stashes do i have', 'show the stash', 'what is stashed',
    ],
  },
  'git_branch_create': {
    examples: [
      'create a branch', 'create a new branch', 'make a new branch',
      'create a branch called feature', 'new branch called dev',
      'make a branch named test', 'create branch feature-x',
      'start a new branch', 'branch off a new branch', 'create a feature branch',
      'make a new git branch', 'create a git branch', 'new git branch',
      'checkout a new branch', 'create and switch to a new branch',
      'spin up a new branch', 'set up a new branch called hotfix',
      'create a branch for this feature', 'branch this off',
    ],
  },
  'git_remote_info': {
    examples: [
      'what is my remote', 'what is the remote url', 'show my remotes',
      'git remote info', 'what remote is this on', 'where is this pushed to',
      'show the remote url', 'whats the origin url', 'show git remotes',
      'list remotes', 'what remotes exist', 'git remote -v',
      'show remote info', 'what is the git remote', 'remote repository info',
    ],
  },
  // Phase 5 intent taxonomy expansion (audit report 2026-08-10, §4 row 1): distinct from
  // git_branch (list) and git_branch_create — this one finds branches already merged into the
  // current branch and offers to delete them, confirm-gated like every other mutating git intent.
  'git_branch_cleanup': {
    examples: [
      'clean up merged branches', 'delete merged branches', 'clean up my branches',
      'remove merged branches', 'delete branches that are merged', 'prune merged branches',
      'clean up old branches', 'delete stale branches', 'remove old branches',
      'tidy up my branches', 'get rid of merged branches', 'clean up branches',
      'delete branches already merged', 'remove branches that have been merged',
      'clean up finished branches', 'purge merged branches',
    ],
  },
  // Row 2: distinct from git_stash_list (plain `git stash list`) — this adds a stat summary of
  // the most recent stash so you can see roughly what's in it without popping it.
  'git_stash_summary': {
    examples: [
      "what's in my stash", 'summarize my stashes', 'summarize my stash',
      'give me a summary of my stashes', "what's in the stash", 'describe my stash',
      'stash summary', 'summarize what i stashed', 'tell me about my stash',
      "what's stashed and what does it change", 'stash overview',
      'give me an overview of my stashes', 'recap my stashes',
    ],
  },
  // Row 3: distinct from git_diff (raw `git diff`) — this is the `--stat` shape: file list +
  // insertion/deletion counts, for a quick "what changed" glance instead of the full patch text.
  'git_diff_summary': {
    examples: [
      'summarize my changes', 'what did i change', 'summarize my uncommitted changes',
      'give me a diff summary', 'which files changed', 'summarize the diff',
      'how many files did i change', 'quick summary of my changes',
      'what did i change today', 'recap my changes', 'diff stat',
      'show a summary of changes', 'how much did i change',
    ],
  },
  // Row 20: composite readiness check — clean tree + ahead/behind — before opening a PR.
  'git_pr_ready_check': {
    examples: [
      'am i ready to open a pr', 'is this branch ready for a pr', 'is my branch clean',
      'ready to open a pull request', 'can i open a pr yet', 'pr readiness check',
      'is this ready to merge', 'check if im ready for a pull request',
      'am i ready to merge', 'is my branch ready', 'pre-pr check',
      'is everything committed and pushed', 'ready for review',
    ],
  },
};
