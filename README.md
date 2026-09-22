# CodeTeach — AI Debug Tutor

A Socratic debugging tutor that refuses to give students the answer.

Students submit broken code. Instead of returning a fix, the tutor asks
questions — and requires a written hypothesis before every hint. The goal
is to build debugging reasoning, not to ship working code faster.

---

## Why this exists

ChatGPT and Copilot will happily hand a student a working solution. That
feels productive for five minutes and teaches nothing. The research on
productive struggle is clear: students who sit with a hard problem and
articulate what they *think* is wrong learn the material. Students who
copy the fix don't.

This tutor is built around that principle. Every hint requires a hypothesis.
Every pattern is logged. The weak-spots dashboard shows students their own
debugging habits, not their grade.

## What it does

- **Hypothesis-gated hints.** Before a hint is served, the student writes
  one sentence: *"I think the bug is because ___."* No hypothesis, no hint.
- **Hint escalation ladder.** Four levels, from vague nudge to final
  scaffold. Level 2 doesn't unlock until the student has actually tried
  twice at level 1.
- **Custom ESLint rules for beginner mistakes.** Off-by-one loops, mutation
  during iteration, and missing `await` are common enough to have dedicated
  detection — and specific enough that ESLint doesn't catch them out of the
  box.
- **Weak-spots dashboard.** Per-student pattern history with trends, so
  students see their own habits and instructors see class-wide signals.
- **Fallback-only mode.** Works without an LLM. Templated Socratic nudges
  run the same pipeline. When the LLM is enabled, hints become tailored
  to the student's specific code and hypothesis.
- **Persistent history.** SQLite. Survives restarts. Every request is
  logged.
