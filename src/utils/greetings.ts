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
