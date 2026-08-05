/**
 * Builds the "help" response: a categorized prompt library. Ground truth was scattered across
 * NLP training phrases, semantic-matcher examples, and per-project config before this — this is
 * the single place a real, copy-pasteable example lives for every capability the console has,
 * so "help" is actually useful instead of just listing raw trigger strings.
 */
export function buildHelpMessage(project, sessionContext) {
  const lines = [`### What you can ask in [${project.name}]`];

  lines.push(
    `\n**Trigger mode (works with AI off — instant, no model needed):**`,
    `  - "overview" / "describe" — what this project is`,
    `  - "tech stack" — languages & frameworks in use`,
    `  - "project structure" / "show me the folders" — directory tree`,
    `  - "what are the commands" — how to run this project`,
    `  - "known issues" / "gotchas" — parsed from your CLAUDE.md`,
    `  - "architecture" — how it's built`,
    `  - "entry point" — where the app starts`,
    `  - "how many files" — project size stats`,
    `  - "run tests" — test file detection`,
    `  - "show dependencies" / "show config" — package.json, .env, etc.`,
    `  - "git status" — uncommitted changes`,
    `  - "deploy" / "push live" — commits everything and pushes (asks to confirm first)`,
    `  - "attach the github link <url>" — sets/updates the git remote origin`,
    `  - "create a file called X with the text '...'" — creates a file (asks to confirm first)`,
    `  - "append to X the text '...'" — adds to the end of a file (asks to confirm first)`,
    `  - "read file X" / "what's in X" — shows a file's contents`,
    `  - "run the site" / "run the project" — detects project type, shows runnable suggestions`,
    `  - "where is the link" / "link?" / "url?" — shows dev server URL if running`,
    `  - "stop server" / "kill server" — stops a running dev server`,
    `  - "npx serve ." / "python -m http.server" — direct shell commands (skips matching)`,
    `  - "explain more" — deeper detail on whatever you just asked about`,
    `  - "undo" — reverts the last risky command via git`,
    `  - "clear" — wipes this chat window`,
  );

  const commands = [];
  const answers = [];
  (project.config?.entries || []).forEach((e) => {
    const primaryTrigger = e.triggers?.[0] || 'unknown';
    if (e.type === 'command') {
      commands.push(`  - "${primaryTrigger}" -> \`${e.action}\`${e.risky ? ' (Risky)' : ''}${e.auto ? ' (auto: package.json)' : ''}`);
    } else if (e.type === 'answer') {
      answers.push(`  - "${primaryTrigger}"`);
    }
  });
  if (commands.length > 0) lines.push(`\n**This project's configured commands:**`, ...commands);
  if (answers.length > 0) lines.push(`\n**This project's configured Q&A topics:**`, ...answers);

  // System commands — always shown
  lines.push(
    `\n**Monitoring & metrics:**`,
    `  - "monitoring" / "show metrics" / "health check" — latency, counters, recent events`,
    `\n**Learning & telemetry commands:**`,
    `  - "review learning" / "check learning" — see near-miss suggestions for new trigger phrases`,
    `  - "approve suggestions" — add suggested phrases to intent matching`,
    `  - "telemetry review" / "telemetry stats" — intent match statistics`,
    `  - "telemetry suggest" — get threshold tuning recommendations`,
    `  - "threshold set <intent> <floor>" — override confidence floor for an intent`,
    `  - "threshold reset <intent>" — restore default threshold`,
    `  - "telemetry auto-apply" — auto-apply threshold suggestions for this project`,
    `  - "check collisions" — check which intents overlap in embedding space`,
    `  - "review distillations" — see AI-derived trigger suggestions from past AI sessions`,
    `  - "apply distillation <n>" — add a suggested command/answer to console.config.json`,
    `  - "review memory" / "project memory" — usage patterns (frequent commands, files, questions)`,
    `  - "telemetry clear" — reset telemetry data for this project`,
  );

  if (sessionContext?.aiEnabled) {
    lines.push(
      `\n**AI is ON — natural language works too, e.g.:**`,
      `  - "Write a file CHANGELOG.md and add a line about the new deploy feature"`,
      `  - "Add a line to CLAUDE.md under Known gotchas about X"`,
      `  - "Find where the login handler is defined"`,
      `  - "Read package.json and tell me what scripts are available"`,
      `  - "Fix the bug where X happens when Y"`,
      `  - "Remove node_modules from git tracking"`,
      `  - Writes/edits and risky commands still ask you to approve before running.`,
    );
  } else {
    lines.push(
      `\n**Want free-form requests (file edits, "fix this bug", multi-step tasks)?**`,
      `  Turn AI ON (top-right toggle) — it hands the request to your local Ollama model with`,
      `  read/write/search tools scoped to this project's folder. Trigger mode above only`,
      `  matches the exact phrasings listed — it can't improvise.`,
    );
  }

  return lines.join('\n');
}
