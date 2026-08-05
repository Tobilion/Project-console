# Context: Tobiloba Jagun (Tobi)

Drop this file into any AI chat. It describes who I am, what I've built, and how to work with me. Use it to personalize every answer — no generic advice.

## Who I am

Tobi, entering third year of a 4-year Computer Science degree at Covenant University (started 2024, expected 2028). I'm building a portfolio of standout projects to be more than the average CS graduate — my long-term aim is to become a serious name in tech (Iron Man got me into this). I can be lazy until I lock in; what I need from an AI is a push, structure, and someone who makes sense of the rough ideas I throw out. No audience yet — the work has to speak.

I interned at VDT Communications (Aug–Sep 2025, one of Nigeria's leading broadband providers) rotating across IT, Network Servicing, Customer Service, and Field Engineering — ERDs, IP diagnostics (latency/packet-loss analysis), supporting infrastructure engineers. Returning for a second stint July–August 2026.

Hobbies: tech videos, comedies, light fiction, anime/manga, and building websites.

Languages I work in day to day: JavaScript/TypeScript and Python (most projects below), plus Java and C++ from coursework. Systems interests: computer architecture, digital logic, CPU pipelining.

## What I've built (all on GitHub: github.com/Tobilion)

- **Portfolio** — tobiloba-jagun-portfolio.vercel.app (React 19 + TS + Vite + Tailwind v4, Framer Motion, Spline/Three.js). Bento-grid stack overview, a filterable projects hub with language tag pills, a bilingual English/Arabic toggle that flips the whole layout to RTL, a vertical academic timeline, and a live pulsing availability indicator.
- **Matchday Exchange** — football simulation + prediction market: live odds, same-game multi builder, cash out, club ownership, 14-game casino — football-bet-simulator.vercel.app (my most feature-rich project)
- **SportSim Pro** — football management sim — sport-sim-three.vercel.app
- **Dream Kick** — browser 3D football game, vanilla JS + Three.js, zero external assets, offline PWA — dream-kick.vercel.app
- **Habitline** — habit tracker with streaks + heatmap — habitline-chi.vercel.app
- **StudyFlash** — full-stack spaced-repetition flashcards (React + Node + SQLite, offline sync)
- **NetPulse** — Python/Flask ISP performance tracker (local tool)
- **Log Analyzer** — Python security-log CLI + React web companion — log-analyzer-blue-gamma.vercel.app
- **InsightFlow** — desktop stock-analysis tool, Python + PySide6 (Qt) + Pandas + pyqtgraph. A guided three-step wizard pulls daily price history from Alpha Vantage and runs it through a strictly layered pipeline (network → SQLite cache → cleaning → analysis → charts), computing daily/log returns, 20-day rolling mean & volatility, max drawdown, and ±2σ anomaly flags — all pure, independently unit-tested Pandas/NumPy functions. Ships a bundled offline demo dataset so the full pipeline runs with no API key, signup, or network at all, and every Alpha Vantage failure mode (rate limits, unknown tickers, malformed payloads) gets a typed exception with a user-facing hint instead of a traceback. 87 unit tests, none of which need a network connection or a display server.
- **footysim** — headless, tick-driven 11v11 football match engine: 22 player agents + ball resolved from real pitch geometry and player attributes at the point of contact, not top-level probability rolls. Deterministic (seeded matches are byte-identical) and calibrated against real-world match statistics.
- **Local Project Console** — offline command dispatcher + optional local AI coding assistant for managing multiple projects from one web UI: semantic intent matching (embeddings + fuzzy + NLP), a sandboxed tool-calling loop for AI mode, git safety checkpoints, and a self-tuning telemetry layer. Zero external API calls.
- **Joke Kick** — earlier, simpler 2D prototype of Dream Kick (canvas-based, before the 3D rebuild).
- Plus: Duplicate File Analyzer (Python desktop tool)

## My environment

Windows PC, PowerShell terminal. Projects live in `C:\Users\tobil\Desktop\Projects\<name>`. I deploy on Vercel via GitHub pushes. I'm still learning deployment/servers — when telling me to run something, give exact PowerShell commands with full absolute paths, from a fresh terminal.

## My code standards (non-negotiable)

- **Modular architecture** — no single-file apps, no file over ~400 lines, logic separated from UI
- Functional code with deep logic — handle the edge cases, think through situations that could occur
- Verify before done: type-check/tests must pass; never declare something finished unverified
- UI must be engaging, not basic: heroes, animated components, empty states, micro-interactions (reference bar: my portfolio and 21st.dev)
- **Professional code, not vibe-coded** — comments explain *why* (not what), plain professional language, no emoji in code; no dead code; no scratch files/leftover artifacts left in the repo; consistent formatting; any hack is justified in a comment

## Working preferences

- Structured, modular output — easy to scan and tell sections apart
- Ready-to-use deliverables: no placeholders like "add your info here" — use what this file tells you; ask only where my input is truly needed
- If something's unclear: make a reasonable assumption and continue — but never do a severe overhaul based on assumption alone
- Examples and explanations where they help; no generic advice
- Detailed, prescriptive specs over vague ones — leave no room for a lazy interpretation

## Voice (for anything written as me)

Clear and understandable, knowledgeable yet real and friendly, serious logic behind every claim. Short sentences. Simple words where possible. No exaggeration without backing — I'd rather show real, mind-blowing functionality than hype it.
