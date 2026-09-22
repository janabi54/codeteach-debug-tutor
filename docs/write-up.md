Why my AI tutor won't fix your code

This is a copy of the write-up originally published on [dev.to](https://dev.to/janabi54/why-my-ai-tutor-wont-fix-your-code-3gb0).

---

Every AI coding assistant does the same thing: you paste broken code, it hands you the fix. ChatGPT, Copilot, Cursor, the one built into your editor — they all optimize for getting you to working code as fast as possible.

That's often the wrong goal.

I built a debugging tutor that refuses to give you the answer. Instead, it asks questions. It makes you write a hypothesis before every hint. It points at a general area and lets you figure out the rest. It's slower on purpose, and by design slightly annoying.

Here's why that's better — and, more importantly, here's what I learned building it.

The premise: refusal as a feature

The tool is called CodeTeach. A student submits broken code. The server does five things:

1. Runs the code through a classifier that identifies the class of bug (off-by-one, null dereference, mutation during iteration, etc.)
2. Checks whether the student has written a hypothesis this attempt
3. If not, refuses to give a hint until they do
4. If yes, generates a Socratic question — not an answer
5. Logs the pattern so the student can see their own tendencies later

Every hint requires a fresh hypothesis. Every pattern is stored. The weak-spots dashboard is the interesting part: it's a mirror, not a grade.

The pedagogy is not novel. Productive struggle is well-documented. The point is that you can't bolt "productive struggle" onto a tool designed to remove struggle. You have to build a tool whose entire premise is that struggle is the product.

The hint ladder

Hints escalate in four levels:

| Level | What the student gets |
|-------|----------------------|
| 1 | Vague nudge — points at a broad region |
| 2 | More specific — narrows to a line or expression |
| 3 | Near-answer — names the class of bug without stating the fix |
| 4 | Final scaffold — asks the student to state the correct edge case in their own words |

The important constraint is what unlocks the next level. It's not time. It's not "asking again." It's a genuine retry at the current level — the server only escalates after two attempts where the student changed their code.

This is the piece that turns the tool from "a hint button" into something else. A hint button gets spammed. A ladder that only responds to effort gets respected.

Implementation-wise, it's a small state machine per (student, exercise) pair, persisted in SQLite. `currentLevel`, `attemptsAtLevel`, `totalAttempts`, `resolved`. When a new attempt comes in with `passed: false`, increment `attemptsAtLevel`. At 2, escalate and reset the counter. Simple. The hard part was resisting the urge to add more states.

The hypothesis gate

This is the feature I'm most proud of, because it's the one that changes behavior.

Before any hint is served — every level, every time — the student must write one sentence: "I think the bug is because ___."

The server holds the gate. If the student requests a hint without a hypothesis, they get back:

```json
{
  "requiresHypothesis": true,
  "prompt": "Before I give you a hint, tell me in one sentence what you think the bug is.",
  "hintLevel": 1
}

No hint. No progress up the ladder. Just the prompt.

Once they write one, it's stored in a hypotheses table with the hint level it unlocked, and the hint is served. Then the gate re-arms for the next request.

Two things happen when you build this:

First, spam becomes impossible. You can't "next hint" your way through the ladder. Every step costs a thought.

Second — and this is the part I didn't anticipate — you get data nobody else has. A stream of structured statements about what students believe is wrong, at specific moments in their debugging. Not "what code did you write" — "what theory of the bug did you hold when you asked for help." That's a different kind of signal entirely. Instructors can cluster them. So can a second LLM. It's the beginning of a teaching tool that understands reasoning, not just output.

The implementation is straightforward: an extra column on hint_sessions (hypothesis_pending), a new hypotheses table, and a gate check at the top of the route handler. The interesting work is not the code — it's deciding that every hint requires one, including the first.

Custom ESLint rules
The classifier does two things: analyzes the code statically, and matches runtime errors against a regex library.

The regex side is easy — TypeError: Cannot read property 'x' of undefined is a string, and strings are matchable. But it only ever identifies symptoms. If a student has an off-by-one error, JavaScript says Cannot read properties of undefined, not "your loop condition should be <, not <=." Regexes can't tell the difference between ten different bugs that all produce the same error.

Static analysis can. So I wrote a small ESLint plugin with three rules.

loop-bound-heuristic — matches i <= arr.length, i >= arr.length at initialization, and loops that start at 1 with a strict < bound. Each of those is a common off-by-one pattern that ESLint doesn't catch out of the box.

mutation-in-iteration — matches arr.push(x) while iterating over arr, arr.splice() inside forEach, and similar. These are the bugs that skip elements or loop forever, and they're invisible to a static linter that doesn't track collection identity.

async-missing-await — matches calls to fetch, save, load, etc. whose promises are never awaited, returned, or .then()'d. The bug is subtle: the code "works" but the value is a Promise, not the resolved result.

Each rule is an AST visitor. loop-bound-heuristic is the simplest — it hooks ForStatement, checks if the test is <= against a .length member expression, and reports. About 40 lines. mutation-in-iteration is the trickiest because it has to walk the loop body and look for method calls against the same identifier the loop is iterating — no scope analysis, just pattern matching on the AST.

The rules are wrapped in a plugin object and passed to ESLint 9's flat config. That's not obvious from the docs. In flat config, you can't use the old linter.defineRule() API — you pass plugins as data in the config array. My first attempt threw This method cannot be used with flat config and it took me longer than I want to admit to find that.

The classifier merges the two sources — ESLint findings and error-regex matches — into a single list of candidates, sorted by confidence. Which brings me to the bug that took me a full day to find.

The classifier priority bug that took me a day to find
The classifier produces a list of candidates — one per pattern it detects, each with a confidence level and a source (eslint or error-output). Then a small function called pickTop decides which one to report as "the pattern" for this request.

The design goal was: prefer the ESLint signal over the error-output signal, because code analysis points at the root cause and error strings describe the symptom.

The first version looked like this:

typescript
function pickTop(candidates: PatternCandidate[]): MistakePattern | null {
  const strong = candidates.find(c => c.confidence === 'high' || c.confidence === 'medium');
  return strong?.pattern ?? null;
}
That's "highest confidence wins." Reasonable at first glance. Except: error-output heuristics are always high confidence (TypeError: Cannot read properties of undefined really did happen), and custom ESLint rules were medium. So error-output always won. The student with an off-by-one loop was told "which variable might be undefined?" instead of "look at your loop's exit condition."

The fix felt simple:

typescript
function pickTop(candidates: PatternCandidate[]): MistakePattern | null {
  const fromEslint = candidates.find(
    c => c.source === 'eslint' || c.source === 'both'
  );
  if (fromEslint) return fromEslint.pattern;

  const strong = candidates.filter(
    c => c.confidence === 'high' || c.confidence === 'medium'
  );
  return strong[0]?.pattern ?? null;
}
ESLint wins whenever it has anything to say. Error-output carries the load only when the code is clean.

This worked — for preClassify. But not for the actual HTTP endpoint.

Because there was a second place that computed the top pattern: the fallback hint generator. And it read candidates[0] directly, bypassing pickTop entirely:

typescript
export function generateFallbackHint(c: PreClassificationResult, reason): FallbackHint {
  const top = c.candidates[0];  // ← bug
  const usable = top && (top.confidence === 'high' || top.confidence === 'medium');
  return {
    message: usable ? patternNudge(top.pattern) : genericNudge(),
    detectedPattern: usable ? top.pattern : null,
    ...
  };
}
Since candidates was sorted by confidence, candidates[0] was the highest-confidence candidate, not the preferred one. So the fallback path kept returning null-undefined while the direct classifier test kept returning off-by-one.

Every component passed its own tests. The composition didn't do what any of them promised. It's the classic integration-seam bug, and I only found it because I finally ran the classifier directly and compared the output to what the server was returning over HTTP.

The fix was three lines:

typescript
export function generateFallbackHint(c: PreClassificationResult, reason): FallbackHint {
  const pattern = c.topPattern;  // use the classifier's preferred answer
  return {
    message: pattern ? patternNudge(pattern) : genericNudge(),
    detectedPattern: pattern,
    ...
  };
}
The lesson: when you have a preferred-selection function, everything that needs a selection must go through it. Any code path that re-derives the answer from raw data will eventually disagree with the primary path.

The fallback path
The classifier runs even when no LLM is available. That's on purpose.

When you enable Claude, the tutor generates a conversational Socratic question tailored to the student's code and their hypothesis. When you don't, a template-based generator picks a nudge from a bank of three per pattern. The pipeline is identical up to the point where the message is written.

Why build both?

Because LLMs fail. They rate-limit, they time out, they get expensive. If your product depends on a single external API, you don't have a product, you have a demo. The fallback is the difference between "works when everything is fine" and "works."

The fallback has its own constraints. It can't see the student's code, only the detected pattern. So the nudges have to be generic enough to apply to any instance of that pattern, but specific enough to actually help. That's a surprisingly hard writing exercise — writing Socratic questions that are pattern-generic is harder than writing them for a specific bug.

Here's the off-by-one bank:

"Take another look at how your loop decides when to stop. Is that the boundary you actually want?"

"What value does your loop variable hold on the very last iteration — and is that a valid position?"

"Trace your loop by hand for an input of size 1. How many times does the body run?"

Each is a question, not a statement. Each points at the boundary without naming the fix. Each can be applied to i <= arr.length, i >= arr.length, i = 1; i < arr.length, and any other flavor of off-by-one you happen to have written.

The fallback path also serves a useful development purpose: it lets you build and test the whole system without spending money on API calls. If I can't get a sensible hint out of the fallback path for a given pattern, the pattern is probably too vague to be useful even with an LLM.

What I'm not sure about
I'll be honest about the doubts.

Is refusal actually the right default for everyone?

There's a version of this that's just annoying. A student stuck on a typo — let i = 0; i i <= arr.length; i++ — doesn't need to write a hypothesis about their reasoning. They need to be told "there's a stray i on line 2." Right now the tutor does tell them something useful (the syntax-error pattern says "read the failing line character by character"), but it's indirect. There's a spectrum between "make them think" and "make them waste time," and I'm not sure I've got the dial in the right place for every kind of bug.

The honest answer is: it depends on the student. For someone learning to debug, refusal is the point. For someone who already knows how to debug and just needs a syntax reminder, refusal is friction.

Is the hypothesis requirement teaching anything, or is it performative?

The theory is: writing "I think the bug is because ___" forces metacognition. The evidence would be: students who use the tool end up writing better hypotheses over time, or make fewer bugs in a category once it's been flagged in their weak spots.

I don't have that evidence. The tool logs everything, but logging isn't learning. To know whether the hypothesis gate actually helps, you'd need a study — pre/post comparison, control group, the whole apparatus. That's beyond what I can build alone.

What I can say is: the hypotheses are interesting to read. They show what students actually believe about their code. That's a real artifact even if the pedagogy is unproven.

Is the classifier good enough to be worth the complexity?

Three custom ESLint rules and a regex library catch maybe a dozen patterns. There are hundreds of ways code breaks. The classifier is honest — when it doesn't know, it falls back to error-output heuristics, which are worse but usable — but "usable" isn't the same as "good."

There's also a bias problem: the patterns I happen to have rules for get more attention in the weak-spots dashboard. If a student's real struggle is something I don't detect, they won't see it there. The dashboard tells the truth about what the classifier sees, not about what the student actually struggles with.

Would anyone use this?

The tool works. The pedagogy is plausible. But "plausible pedagogy" and "students actually change their behavior" are different claims, and I only have evidence for the first.

It's a tool that would need to be tested in a real classroom. Built for a hypothetical user. That's not a flaw — it's how most tools start — but it does mean I can't claim it works, only that it should work, and here's why.

I built it because I wanted to know whether the refusal-as-feature idea would actually feel different to use than a normal hint button. It does. That's a small, real finding. Whether it changes outcomes for students is a bigger question I can't answer yet.

What's next
Three features I'd add if I keep going:

Post-mortem turns. Once a student fixes their bug, one more LLM prompt: "explain in your own words why this happened." Score it loosely, store it against the weak-spot category. That closes the loop and produces the signal the dashboard needs to be honest about whether hints actually helped.

Cross-student fingerprinting. If 40% of a class hits the same off-by-one in the same exercise, that's a teaching signal. Auto-generate a mini-lesson or flag it for a live walkthrough. This is the feature that would make an instructor actually want the tool.

Struggle timer. Lock level 1 for N minutes of independent attempts before a hint is even offered. Instructor-configurable. Framed as "productive struggle," not "we're withholding help." I suspect this one matters more than it sounds, but I haven't built it because it's the most annoying to test.

None of these are needed to make the current tool work. They're needed to make it interesting enough that a classroom would actually adopt it.

The repo is here: github.com/janabi54/codeteach-debug-tutor. If you're building something similar, or if you teach and want to try it, or if you just want to argue with the premise — I'd like to hear from you.