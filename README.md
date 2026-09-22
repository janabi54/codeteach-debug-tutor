CodeTeach — AI Debug Tutor

A Socratic debugging tutor that refuses to give students the answer.

Students submit broken code. Instead of returning a fix, the tutor asks
questions — and requires a written hypothesis before every hint. The goal
is to build debugging reasoning, not to ship working code faster.

Read the full write-up: [Why my AI tutor won't fix your code](https://dev.to/janabi54/why-my-ai-tutor-wont-fix-your-code-3gb0)

Why this exists

ChatGPT and Copilot will happily hand a student a working solution. That
feels productive for five minutes and teaches nothing. The research on
productive struggle is clear: students who sit with a hard problem and
articulate what they *think* is wrong learn the material. Students who
copy the fix don't.

This tutor is built around that principle. Every hint requires a hypothesis.
Every pattern is logged. The weak-spots dashboard shows students their own
debugging habits, not their grade.

What it does

- Hypothesis-gated hints. Before a hint is served, the student writes
  one sentence: *"I think the bug is because ___." No hypothesis, no hint.
- Hint escalation ladder.** Four levels, from vague nudge to final
  scaffold. Level 2 doesn't unlock until the student has actually tried
  twice at level 1.
- Custom ESLint rules for beginner mistakes.** Off-by-one loops, mutation
  during iteration, and missing `await` are common enough to have dedicated
  detection — and specific enough that ESLint doesn't catch them out of the
  box.
- Weak-spots dashboard. Per-student pattern history with trends, so
  students see their own habits and instructors see class-wide signals.
- Fallback-only mode. Works without an LLM. Templated Socratic nudges
  run the same pipeline. When the LLM is enabled, hints become tailored
  to the student's specific code and hypothesis.
- Persistent history. SQLite. Survives restarts. Every request is
  logged.

Architecture

    student code + error + hypothesis
            ↓
      [pre-classifier]
        ├── ESLint (custom + built-in rules)
        └── error-output regex heuristics
            ↓
      merged candidates (confidence-ranked)
            ↓
      [pickTop]  — prefers ESLint signal over error text
            ↓
      [tutor service]
        ├── LLM path (Claude, Socratic system prompt)
        └── fallback path (templated nudges)
            ↓
      response: hint + detectedPattern + hintLevel
            ↓
      [persistence]
        ├── hypotheses (student reasoning)
        ├── hint_sessions (ladder state)
        ├── mistake_patterns (per-student history)
        └── telemetry (latency, fallback rate, circuit breaker)

The hint ladder

| Level | What the student gets | Unlocks when |
|-------|----------------------|--------------|
| 1 | Vague nudge — points at a broad region | First request (after hypothesis) |
| 2 | More specific — line or expression | 2 attempts at level 1 |
| 3 | Near-answer — names the class of bug | 2 attempts at level 2 |
| 4 | Final scaffold — asks for the edge case in the student's own words | 2 attempts at level 3 |

Every level requires a fresh hypothesis. The gate re-arms after each hint.

Custom ESLint rules

Three rules the default ESLint config doesn't catch:

- `codeteach/loop-bound-heuristic` — flags `i <= arr.length` and similar
  off-by-one patterns that are invisible to most linters.
- `codeteach/mutation-in-iteration` — flags `arr.push(x)` while iterating
  over `arr`, `arr.splice()` inside `forEach`, and similar.
- `codeteach/async-missing-await` — flags calls to `fetch`, `save`,
  `load`, etc. whose promises are never awaited.

Each rule has its own `RuleTester` suite (`npm run test:rules`).

Running it

    npm install
    cp .env.example .env
    npm run dev

Open `http://localhost:3001/`.

To run without an LLM (fallback mode), leave `DEBUG_TUTOR_LLM_DISABLED=true`
in `.env`. To use Claude, add your `ANTHROPIC_API_KEY` and set
`DEBUG_TUTOR_LLM_DISABLED=false`.

Endpoints

Method  Path  Purpose 

POST    `/api/debug-tutor/hint` | Submit code + hypothesis, get a hint 
GET     `/api/debug-tutor/weak-spots/:studentId` | Pattern history for a student 
GET      `/api/admin/health/debug-tutor` | Operator metrics (requires `x-admin-key`) 

Design decisions

Why hypothesis gating?  Without it, "ask for a hint" is a button students
spam. With it, every hint costs a thought. The by-product — a stream of
structured "what I think is wrong" statements — is data no other tool has.

Why a custom ESLint plugin instead of more heuristics? Regexes on error
strings catch symptoms. AST analysis catches causes. Off-by-one loops don't
throw until they run; the error text tells you `undefined`, not why.

Why a fallback path? LLMs go down, rate-limit, or get expensive. The
fallback serves the same pipeline with templated nudges so the product works
regardless. When the LLM is up, hints get sharper. When it's down, students
still get help.

Why SQLite? For a single-instructor class or a demo, a file-based DB is
enough. The public interface is async and swappable — moving to Postgres is
a `db.ts` rewrite and nothing else.

Status

Working, tested, and running on the author's machine. 23/23 tests green.
Not deployed yet.

License

MIT
