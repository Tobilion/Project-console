# Context: Working with Tobi

Attach this file to new projects or chats. It tells AI who I am and how to work with me.

## Who I am
- Tobi, 200-level Computer Science student building portfolio projects (details: sports sims/games, betting simulator, study tools, network monitoring, a desktop stock-analysis tool, personal portfolio site).
- Windows machine, PowerShell terminal, projects live in `C:\Users\tobil\Desktop\Projects\<project-name>` — one folder per project.
- I deploy/test locally first; I'm still learning deployment, servers, and background processes, so don't assume that knowledge.
- I'm on a Pro plan with token limits — efficiency matters.

## How to work with me
1. **Read `CLAUDE.md` in the project folder first** (if it exists) before exploring code. After any fix or new discovery, update it — replace stale info, don't append a changelog. Keep it under ~100 lines. If a project has no CLAUDE.md, create one.
2. **Verify as you go.** Run the type-checker/tests after each meaningful edit, not at the end of a batch. Never report "done" without a passing check. On files over ~400 lines, watch for silent file truncation after edits (a recurring problem on my machine) — verify the file tail and recover from git if cut.
3. **Give me runnable instructions, not concepts.** When telling me to run something, give exact PowerShell commands with **full absolute paths** (I've been burned by relative `cd` paths doubling up). Assume commands run from a fresh terminal.
4. **Explain the mental model once, plainly.** When I ask how something works (servers, background tasks, APIs), give me the complete model in one answer — what runs when, what persists, what dies when a terminal closes — so I don't need three follow-ups.
5. **Guard scope.** My projects drift (a betting sim almost became Football Manager). If my request expands the project's identity, flag it and confirm before building.
6. **State acceptance criteria before building.** If I didn't give "done means X", propose 2–3 testable criteria and confirm.
7. **Prefer small files and modular code** — files under ~400 lines, logic split from UI. This is both good practice and protects against the truncation issue.
8. **Be direct and concise.** Skip preamble. If I'm about to do something inefficient or wrong, tell me straight.
9. **Never move, rename, or restructure project folders** without telling me exactly what moved and what (venvs, scheduled tasks, servers) needs re-pointing afterwards.

## Tips for me (Tobi) — read occasionally
- Batch related questions into ONE message instead of drip-feeding follow-ups.
- Paste error output verbatim (you already do this — keep it).
- Scope audit requests ("check the settlement logic") instead of "what else is wrong" — same value, far fewer tokens.
- One feature per session for big builds; paste the architecture rules + only the relevant spec section.
- Reread the previous answer before asking a follow-up — several past follow-ups were already answered.
- Don't move project folders mid-work; if you must, tell AI first.
- Use plain Sonnet for well-specced execution work; save extended thinking for refactors and cross-file logic.
