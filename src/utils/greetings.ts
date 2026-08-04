/**
 * Random personalized greeting + chat-prompt templates for the console UI.
 * Client-side display text only — the server's trigger-mode greeting pools
 * (builtinIntents.js) are intentionally profile-unaware.
 */

const GREETINGS = [
  (name: string) => `Welcome back, ${name}.`,
  (name: string) => `Good to see you, ${name}.`,
  (name: string) => `Hello, ${name} — let's build.`,
  (name: string) => `Ready when you are, ${name}.`,
  (name: string) => `Your console, your rules, ${name}.`,
  (name: string) => `Back at it, ${name}.`,
  (name: string) => `Hey ${name}, what are we shipping today?`,
  (name: string) => `Welcome, ${name}. The projects are waiting.`,
  (name: string) => `Nice to have you here, ${name}.`,
  (name: string) => `Let's make something good, ${name}.`,
  (name: string) => `${name} is in the building.`,
  (name: string) => `All systems ready for you, ${name}.`,
  (name: string) => `What's the plan today, ${name}?`,
  (name: string) => `Hello ${name} — take a seat, we've got work to do.`,
  (name: string) => `There you are, ${name}.`,
  (name: string) => `${name} at the wheel. Where to?`,
  (name: string) => `Good day, ${name}.`,
  (name: string) => `Welcome ${name} — your projects missed you.`,
  (name: string) => `Let's get to it, ${name}.`,
  (name: string) => `Glad you're here, ${name}.`,
];

const CHAT_PROMPTS = [
  (name: string) => `Ask me anything, ${name}...`,
  (name: string) => `Type a command or question, ${name}.`,
  (name: string) => `What do you need, ${name}?`,
  (name: string) => `Fire away, ${name}.`,
  (name: string) => `Your move, ${name}.`,
  (name: string) => `Say the word, ${name}.`,
  (name: string) => `Command or question, ${name}?`,
  (name: string) => `I'm listening, ${name}.`,
  (name: string) => `What's next, ${name}?`,
  (name: string) => `How can I help, ${name}?`,
];

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getRandomGreeting(formattedName: string): string {
  return pick(GREETINGS)(formattedName || 'there');
}

export function getRandomChatPrompt(name: string): string {
  return pick(CHAT_PROMPTS)(name || 'there');
}

/** Centered prompts for the empty chat thread — at least 20 variants per request. */
const EMPTY_STATE_PROMPTS = [
  (name: string) => `What ideas do you have, ${name}?`,
  (name: string) => `What do you want to do, ${name}?`,
  (name: string) => `What are we building today, ${name}?`,
  (name: string) => `Got an idea? Let's hear it.`,
  (name: string) => `Where should we take this, ${name}?`,
  (name: string) => `What should we tackle next?`,
  (name: string) => `Any features you want to try?`,
  (name: string) => `What's on your mind?`,
  (name: string) => `Let's make something happen.`,
  (name: string) => `What's the plan, ${name}?`,
  (name: string) => `Give me a task and I'll get moving.`,
  (name: string) => `Anything new since last time?`,
  (name: string) => `Let's dig into something.`,
  (name: string) => `What do you want to explore?`,
  (name: string) => `Got something in mind?`,
  (name: string) => `Let's hear that idea.`,
  (name: string) => `What's next on the list?`,
  (name: string) => `Tell me what you're thinking.`,
  (name: string) => `What can we improve today?`,
  (name: string) => `Idea time — what's yours?`,
  (name: string) => `What would you like to try out?`,
  (name: string) => `Where to next, ${name}?`,
];

export function getRandomEmptyStatePrompt(name: string): string {
  return pick(EMPTY_STATE_PROMPTS)(name || 'there');
}

const EMPTY_STATE_ACTIONS_WITH_PROJECT = [
  'check git status',
  'what is this project',
  'run the site',
  'show running processes',
];

const EMPTY_STATE_ACTIONS_NO_PROJECT = ['help', 'what can you do', 'list projects'];

/** Quick action chips under the empty-state greeting — plain chat messages, so every
 *  existing confirm gate still applies. */
export function getEmptyStateActions(activeProject: { id: string } | null): string[] {
  return activeProject ? EMPTY_STATE_ACTIONS_WITH_PROJECT : EMPTY_STATE_ACTIONS_NO_PROJECT;
}
