Session B Backlog
Here's the consolidated backlog. Save this as docs/session-b-backlog.md so it lives with the code.

How to use this doc
Each item has a rough effort estimate and a priority tier. Tier 1 items are the ones most likely to change how the product feels. Tier 3 is nice-to-have. Pick from the top down, and don't feel obligated to build everything — some of this may not matter once you see real usage.

Time estimates assume familiarity with the codebase. If you're picking this up cold in a month, double them.

Tier 1 — Highest value, ready to build
1.1 Tutor notes (private, timestamped)
Where: Student detail page — a side panel next to the metrics
Effort: 2-3 hours
Why: Tutors need to record observations that don't fit in the metrics. "Struggles with off-by-one errors — talked about it Tuesday." Without this, the detail page is data-only and forgettable.

Schema:

sql
CREATE TABLE tutor_notes (
  id TEXT PRIMARY KEY,
  instructor_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
Keyed by cohort_id so notes are scoped — if a student leaves and rejoins a different cohort, the notes don't follow. Per the "cohort removal deletes data" rule.

Endpoints:

POST /api/admin/students/:studentId/notes — add a note

GET /api/admin/students/:studentId/notes — list notes (scoped to instructor's cohort)

DELETE /api/admin/notes/:noteId — delete own note

UI: A collapsible side panel on the student detail page. Each note shows timestamp + text + delete button. Compose box at the top.

1.2 Status / at-risk flag refinement
Where: Roster view — already partially built
Effort: 1-2 hours
Why: Currently status is only derived from lastActiveAt (14d = inactive, 7d = needs-attention). Adding "stuck on one exercise for a long time" and "hint dependency trending up" makes it more useful.

Rules to add:

Stuck: session on one exercise in open state for > 3 days with > 5 attempts

Hint trend worsening: last 5 sessions averaged > 20% more hints than the prior 5

Completed nothing: enrolled for > 7 days with 0 completions

Where: Extend deriveStatus() in server/routes/students.ts. Add a statusReason field so the tooltip can explain.

1.3 Cohort removal — data cleanup
Where: The leave-cohort endpoint
Effort: 3-4 hours
Why: You specified that when a student leaves a cohort, their data for that cohort is removed. This is a privacy and correctness requirement.

What to delete when a student leaves cohort C:

Their cohort_members row (already happens)

Their hint_sessions for exercises in C

Their hypotheses for exercises in C

Their post_mortems for exercises in C

Their mistake_patterns for exercises in C

Their tutor_notes for cohort C

Crucially: only that cohort's data. If they're in two cohorts, the other tutor's data survives.

Where: Update DELETE /api/cohorts/:cohortId/leave in server/routes/cohorts.ts. Add a transaction that walks each table.

Warning: destructive. Show a confirmation to the student ("This will remove your work for this class. Are you sure?").

1.4 Trends on the metric cards (sparklines)
Where: Student detail view — reasoning quality and hint dependency cards
Effort: 3-4 hours
Why: A snapshot is less useful than a trend. "60% reasoning quality" doesn't tell you much. "60%, up from 40% over the last month" tells you the student is improving.

Data needed: per-week aggregates for the student. Add windowed variants of qualityStatsForStudent and hintDependency.forStudent that return a series instead of a single number.

UI: Tiny inline SVG sparkline. ~30 lines of JS to render. No library needed.

Tier 2 — Meaningful but not urgent
2.1 Strengths list
Where: Student detail — next to weak spots
Effort: 2-3 hours
Why: Only showing weaknesses is demotivating and incomplete. "Strong at: tracing loops, reading stack traces" gives a balanced view.

How to compute: The inverse of weak spots. Patterns the student hasn't hit in a while, or has hit rarely compared to peers. Or post-mortems scored correct on a pattern.

Simplest v1: patterns where the student has 0 or 1 occurrences but the class average is 3+. Show those as "not yet a weakness."

Where: Extend db.students.detailFor to compute a strengths array, similar to weakSpots.

2.2 Tutor feedback on specific work items
Where: Student detail — on each hypothesis and post-mortem
Effort: 3-4 hours
Why: Turns the page from monitoring into teaching. A tutor can leave a comment on a hypothesis: "Good instinct — what would change if the array were empty?"

Schema: Add feedback and feedback_by columns to hypotheses and post_mortems. Or a separate tutor_feedback table with polymorphic refs.

UI: A small "Add feedback" link under each item. Click → inline textarea → save.

2.3 Recommended next action
Where: Student detail — a card near the top
Effort: 4-6 hours
Why: "Based on your weak spots, assign an off-by-one exercise." This is the feature that makes tutors come back.

How: Simple rules engine. Given a student's top weak pattern, find exercises in the cohort that target that pattern (using expectedConcepts or a new targetsPatterns field on exercises). Show "Assign this exercise" with a button.

Assigning: Adds the exercise to a per-student "assigned" list. Needs a new student_assignments table.

This is the largest item in the backlog. Defer until you've used the tool enough to know what assignments actually mean in your workflow.

2.4 Cohort comparison (student vs median)
Where: Metric cards
Effort: 2-3 hours
Why: A student at 60% is different if the class median is 40% vs 80%.

UI: Small text under each metric: "Class median: 45%". Keep it subtle — not "you're below average," just "here's the context."

Risk: This can become a shaming tool. Frame it neutrally or leave it out. Worth discussing with an actual instructor before building.

2.5 Progress bar (completed vs assigned)
Where: Student detail — replaces or augments the Progress card
Effort: 1 hour
Why: "3 / 7 exercises complete" is more informative than "43% complete" when the denominator matters.

Currently: the Progress card shows completed / attempted. That's session-level.

Change to: completed / (exercises in the student's cohorts). The denominator is the total exercise count, not what they've touched.

Tier 3 — Nice to have
3.1 Activity heatmap / streaks
Effort: 4-5 hours
Why: Shows when a student works and whether they're consistent. GitHub-style calendar view of activity.

Data: Already in telemetry and hint_sessions. Just needs a daily-aggregate query.

Risk: Can feel like surveillance. Frame carefully.

3.2 Time metrics
Effort: 2 hours
Why: Time per exercise, time to first hypothesis, number of attempts.

Data: Add computed fields to the exercise detail view:

timeToFirstHint = first telemetry row minus session created_at

timeToFirstHypothesis = first hypothesis recorded_at minus session created_at

sessionDuration = updated_at minus created_at

Caveat: "time spent" is really "time since session started." We don't know if the student walked away. Use with caution.

3.3 Hypothesis outcomes (confirmed vs refuted)
Effort: 3-4 hours
Why: A hypothesis is confirmed if the fix that follows matches it. Hard to measure precisely. A proxy: did the student's session progress after the hypothesis, or did they need another hint?

Approach: For each hypothesis, look at the next session state change. If the student's code changed and the session advanced, the hypothesis "helped." If they needed another hint, it "didn't help."

Coarse but interesting. Worth building if the hypothesis data is rich enough.

3.4 Export / print progress report
Effort: 3-4 hours
Why: For parent meetings, reviews, or just to bring to class. A clean PDF with the student's progress over a period.

Approach: Server-side render to HTML, then either print from the browser or use a library like Puppeteer. Puppeteer is heavy — consider a "print view" that just gives a nicely formatted HTML page the browser can print to PDF.

3.5 Message / nudge student
Effort: 3-4 hours
Why: "Hey — you haven't touched the off-by-one exercise in 3 days. Anything blocking you?"

Requires: A notification channel — email, in-app, or both. Email needs SMTP. In-app is easier (a notification icon in the student's top bar).

Recommended v1: In-app only. No email infrastructure needed.

Tier 4 — Larger or deferred
4.1 Raw timeline view with session replay
Effort: 2-3 days
Why: A chronological log of every event in a student's session, with the ability to "replay" their code changes.

Data challenge: We don't currently log every code submission — only the last state per request. To support replay, we'd need a new session_events table that captures every code state with a timestamp.

UI challenge: A timeline view with scrubber. Replaying code state at time T.

Reconsider: Is this actually useful? A tutor watching a replay learns less than reading the hypotheses and post-mortems. Might be overkill.

4.2 Student privacy notice + consent
Effort: 1-2 days
Why: Legal and ethical. If students are minors or in a school context, Kenya's Data Protection Act (2019) applies.

Requirements:

A visible notice in the student's settings: "Your instructor can see your session history, hypotheses, and post-mortems."

A "download my data" action

A "delete my account" action

Consent flow at registration (check box, log the consent)

Get legal input if this goes to real students. The implementation is easy; the policy is the hard part.

4.3 Analytics dashboard beyond Class
Effort: 3-5 days
Why: Retention curves, cohort comparison over time, longitudinal tracking.

Not needed for v1. Would matter at 10+ instructors and hundreds of students.

What I'd actually build next
If you come back with energy and want one thing:

Build 1.1 (tutor notes) first. It's small, it's high-value, and it changes the detail page from "here's data" to "here's my working file on this student." Everything else builds on top of that.

If you want two things:

Then build 1.4 (trends/sparklines). It makes the metrics actually meaningful. A snapshot says "what is." A trend says "where is this going." For a tutor who sees a student weekly, the second matters more.

If you have a full weekend:

Add 2.2 (tutor feedback on work items) and 2.3 (recommended next action). Those two together turn the feature into a real teaching tool. But they're each substantial.

Skip 4.1 (session replay). It sounds cool and takes days. The pedagogical value is low compared to reading a student's hypotheses in sequence.

Engineering notes for whoever picks this up
The slug vs UUID confusion is a recurring trap. Every "session-like" table uses the exercise slug (ex-1, find-the-maximum) as exercise_id. The exercises table's primary key is a UUID. Whenever you query a session-like table, use the slug. When you need to look up an exercise, use findBySlug.

Authorization always goes through server/auth/authorization.ts. Never trust client-supplied IDs. The helper functions enforce the "instructor sees only their cohort's work" rule. Bypassing them is a privacy incident.

The exercise picker is the front door. Students can only work on exercises in their cohorts because the picker only offers those. But the server-side POST /api/debug-tutor/hint still accepts any exercise ID — a determined student could craft a request. If this matters for your threat model, add server-side validation to reject exercises outside the student's cohorts.

Cohorts belong to instructors, exercises belong to cohorts. A student joins a cohort via enrollment code. Every query in the instructor view filters by "instructor teaches this cohort AND student is a member." Keep that invariant.

The Tutor tab's exercise picker caches selection in localStorage. If a student joins a new cohort, the picker reloads (via the join handler), but the cached selection might become invalid. The loadExercisePicker function handles this by checking whether the cached value is still in the list.

State of the codebase
Working end to end:

Socratic hint engine with hypothesis gate, hint ladder, post-mortem loop, struggle timer

Custom ESLint plugin with three rules

Weak-spots dashboard with post-mortem accuracy

Class dashboard with anomaly detection

Full auth (bcrypt, sessions, roles, invite codes, rate limiting)

Exercise authoring with a full editor (Prism + Tagify)

Multi-cohort support with enrollment codes

Instructor "view student" with authorization enforcement

Test coverage: 23 regression tests for the classifier. No tests for auth, students, or cohorts. Worth adding before this ships to real users.

Deployment: Still localhost:3001. Not deployed.

LLM: Still in fallback mode (no API key). The heuristic scorers work; the LLM paths are tested and ready.