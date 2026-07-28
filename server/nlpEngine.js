import { NlpManager } from 'node-nlp';

class IntentClassifier {
  constructor() {
    this.manager = new NlpManager({
      languages: ['en'],
      forceNER: true,
      nlu: { log: false }
    });
    this.isTrained = false;
    this.initializeDefaultIntents();
  }

  initializeDefaultIntents() {
    // Greetings
    this.manager.addDocument('en', 'hi', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'hello', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'hey', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'yo', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'good morning', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'good evening', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'good afternoon', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'greetings', 'system.chit_chat.greeting');
    this.manager.addDocument('en', 'hey there', 'system.chit_chat.greeting');

    // Status / how are you
    this.manager.addDocument('en', 'how are you', 'system.chit_chat.status');
    this.manager.addDocument('en', 'how are you doing', 'system.chit_chat.status');
    this.manager.addDocument('en', "how's it going", 'system.chit_chat.status');
    this.manager.addDocument('en', "what's up", 'system.chit_chat.status');
    this.manager.addDocument('en', 'how is everything', 'system.chit_chat.status');
    this.manager.addDocument('en', 'sup', 'system.chit_chat.status');
    this.manager.addDocument('en', "what's happening", 'system.chit_chat.status');
    this.manager.addDocument('en', 'how are things', 'system.chit_chat.status');

    // Gratitude
    this.manager.addDocument('en', 'thanks', 'system.chit_chat.gratitude');
    this.manager.addDocument('en', 'thank you', 'system.chit_chat.gratitude');
    this.manager.addDocument('en', 'thank you very much', 'system.chit_chat.gratitude');
    this.manager.addDocument('en', 'awesome', 'system.chit_chat.gratitude');
    this.manager.addDocument('en', 'great thanks', 'system.chit_chat.gratitude');
    this.manager.addDocument('en', 'appreciate it', 'system.chit_chat.gratitude');

    // Clear console
    this.manager.addDocument('en', 'clear', 'system.chit_chat.clear');
    this.manager.addDocument('en', 'clear console', 'system.chit_chat.clear');
    this.manager.addDocument('en', 'clear chat', 'system.chit_chat.clear');
    this.manager.addDocument('en', 'cls', 'system.chit_chat.clear');

    // Help
    this.manager.addDocument('en', 'help', 'system.chit_chat.help');
    this.manager.addDocument('en', 'what can you do', 'system.chit_chat.help');
    this.manager.addDocument('en', 'list commands', 'system.chit_chat.help');
    this.manager.addDocument('en', 'show me what you can do', 'system.chit_chat.help');

    // Git
    this.manager.addDocument('en', 'git status', 'system.chit_chat.git_status');
    this.manager.addDocument('en', 'show changes', 'system.chit_chat.git_status');

    // Deploy (commit + push — Vercel-connected projects deploy on push)
    this.manager.addDocument('en', 'deploy', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'deploy the site', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'deploy this', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'push live', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'push my changes', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'commit and push', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'push to git', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'publish the site', 'system.chit_chat.deploy');
    this.manager.addDocument('en', 'go live', 'system.chit_chat.deploy');

    // Follow-up
    this.manager.addDocument('en', 'explain more', 'system.chit_chat.explain_followup');
    this.manager.addDocument('en', 'tell me more', 'system.chit_chat.explain_followup');
    this.manager.addDocument('en', 'elaborate', 'system.chit_chat.explain_followup');
    this.manager.addDocument('en', 'deep dive', 'system.chit_chat.explain_followup');
    this.manager.addDocument('en', 'give me more details', 'system.chit_chat.explain_followup');

    // Knowledge / Overview
    this.manager.addDocument('en', 'describe', 'project.knowledge.overview');
    this.manager.addDocument('en', 'info', 'project.knowledge.overview');
    this.manager.addDocument('en', 'what is this project', 'project.knowledge.overview');
    this.manager.addDocument('en', 'overview', 'project.knowledge.overview');
    this.manager.addDocument('en', 'project overview', 'project.knowledge.overview');

    this.manager.addDocument('en', 'what is the stack', 'project.knowledge.stack');
    this.manager.addDocument('en', 'tech stack', 'project.knowledge.stack');
    this.manager.addDocument('en', 'what tech does it use', 'project.knowledge.stack');

    this.manager.addDocument('en', 'what are the commands', 'project.knowledge.commands');
    this.manager.addDocument('en', 'how do i run this', 'project.knowledge.commands');
    this.manager.addDocument('en', 'show me the commands', 'project.knowledge.commands');

    this.manager.addDocument('en', 'known issues', 'project.knowledge.gotchas');
    this.manager.addDocument('en', 'what are the gotchas', 'project.knowledge.gotchas');

    this.manager.addDocument('en', 'architecture', 'project.knowledge.architecture');
    this.manager.addDocument('en', 'how is the project built', 'project.knowledge.architecture');
    this.manager.addDocument('en', 'project structure', 'project.knowledge.architecture');

    // Context-aware intents (Phase 4)
    this.manager.addDocument('en', 'show me the project structure', 'project.context.structure');
    this.manager.addDocument('en', 'what are the directories', 'project.context.structure');
    this.manager.addDocument('en', 'list the folders', 'project.context.structure');
    this.manager.addDocument('en', 'folder structure', 'project.context.structure');
    this.manager.addDocument('en', 'directory tree', 'project.context.structure');

    this.manager.addDocument('en', 'what languages', 'project.context.languages');
    this.manager.addDocument('en', 'what programming languages', 'project.context.languages');
    this.manager.addDocument('en', 'what language is this', 'project.context.languages');
    this.manager.addDocument('en', 'which languages are used', 'project.context.languages');

    this.manager.addDocument('en', 'how many files', 'project.context.file_count');
    this.manager.addDocument('en', 'project size', 'project.context.file_count');
    this.manager.addDocument('en', 'how big is this project', 'project.context.file_count');
    this.manager.addDocument('en', 'file count', 'project.context.file_count');
    this.manager.addDocument('en', 'total files', 'project.context.file_count');

    this.manager.addDocument('en', 'what is the entry point', 'project.context.entry_point');
    this.manager.addDocument('en', 'where does the app start', 'project.context.entry_point');
    this.manager.addDocument('en', 'main file', 'project.context.entry_point');
    this.manager.addDocument('en', 'entry point', 'project.context.entry_point');

    this.manager.addDocument('en', 'give me a summary', 'project.context.tech_preview');
    this.manager.addDocument('en', 'project summary', 'project.context.tech_preview');
    this.manager.addDocument('en', 'tl dr', 'project.context.tech_preview');
    this.manager.addDocument('en', 'summary', 'project.context.tech_preview');
    this.manager.addDocument('en', 'what do i need to know', 'project.context.tech_preview');
  }

  clearProjectDocs(projects) {
    if (!projects) return;
    projects.forEach((project, projectIndex) => {
      if (project.config && project.config.entries) {
        project.config.entries.forEach((entry, entryIndex) => {
          if (Array.isArray(entry.triggers)) {
            entry.triggers.forEach(trigger => {
              const intentName = entry.type === 'command'
                ? `project.action.${projectIndex}.${entryIndex}`
                : `project.knowledge.${projectIndex}.${entryIndex}`;
              this.manager.removeDocument('en', trigger, intentName);
            });
          }
        });
      }
    });
  }

  async train(projects) {
    this.clearProjectDocs(projects);
    if (projects) {
      projects.forEach((project, projectIndex) => {
        if (project.config && project.config.entries) {
          project.config.entries.forEach((entry, entryIndex) => {
            if (Array.isArray(entry.triggers)) {
              entry.triggers.forEach(trigger => {
                const intentName = entry.type === 'command'
                  ? `project.action.${projectIndex}.${entryIndex}`
                  : `project.knowledge.${projectIndex}.${entryIndex}`;
                this.manager.addDocument('en', trigger, intentName);
              });
            }
          });
        }
      });
    }

    await this.manager.train();
    this.manager.save();
    this.isTrained = true;
  }

  async classify(input) {
    if (!this.isTrained) {
      await this.train();
    }
    const response = await this.manager.process('en', input);
    
    if (response.intent !== 'None' && response.score > 0.45) {
      return {
        intent: response.intent,
        score: response.score,
        answer: response.answer
      };
    }
    return null;
  }
}

export const nlpEngine = new IntentClassifier();
