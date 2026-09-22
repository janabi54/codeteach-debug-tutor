import { db } from '../db.js';
import { preClassify, type PreClassificationResult } from './preClassifier/index.js';
import { generateFallbackHint, type FallbackHint } from './fallback/fallbackHint.js';
import { callLLM, LLMUnavailableError } from './fallback/llmWrapper.js';

export type MistakePattern =
  | 'off-by-one' | 'type-mismatch' | 'scope-issue' | 'infinite-loop'
  | 'null-undefined' | 'mutation-side-effect' | 'wrong-operator'
  | 'missing-return' | 'async-await' | 'index-out-of-bounds'
  | 'logic-inversion' | 'uninitialized-variable' | 'syntax-error';

export type HintLevel = 1 | 2 | 3 | 4;

export interface TutorRequest {
  studentId: string; exerciseId: string; code: string; language: string;
  errorOutput: string;
  exerciseContext: { title: string; description: string;
    learningObjectives: string[]; expectedConcepts: string[]; };
  attemptNumber: number; passed?: boolean;
}
export interface TutorResponse {
  message: string; hintLevel: HintLevel;
  detectedPattern: MistakePattern | null;
  canEscalate: boolean; nextEscalationRequires: string;
}
export type TutorHint = TutorResponse | FallbackHint;

export const SYSTEM_PROMPT = `You are the AI Debug Tutor for CodeTeach — a Socratic debugging coach.

ABSOLUTE RULES:
1. NEVER write the corrected code, the exact fix, or a full solution.
2. NEVER say "the problem is X, change it to Y."
3. Ask ONE focused guiding question per response, or point at a general area.
4. Use the student's own variable/function names when referring to their code.
5. Match the hint level you are given — do not skip ahead.

HINT LADDER:
- Level 1 (Vague nudge): Point at a broad region.
- Level 2 (More specific): Narrow to the line/expression.
- Level 3 (Near-answer): Name the class of bug without stating the fix.
- Level 4 (Final scaffold): Ask the student to state the correct edge-case behavior themselves.

TONE: Encouraging, curious, never condescending. One question at a time.

Respond with a JSON object only:
{ "message": "<your Socratic response>", "detectedPattern": "<pattern or null>" }`;

async function buildStudentContext(studentId: string): Promise<string> {
  const recent = await db.mistakePatterns.findRecent(studentId, 10);
  if (!recent.length) return 'No prior mistake history.';
  const counts = recent.reduce<Record<string, number>>((a, m) => {
    a[m.pattern] = (a[m.pattern] || 0) + 1; return a;
  }, {});
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([p, c]) => `${p} (${c}x)`).join(', ');
  return `Student's recurring weak spots: ${top}. If relevant, gently draw attention without shaming.`;
}

export async function getTutorHint(req: TutorRequest): Promise<TutorHint> {
  const session = await db.hintSessions.getOrCreate(req.studentId, req.exerciseId);
  const hintLevel = session.currentLevel as HintLevel;
  const studentContext = await buildStudentContext(req.studentId);

  let classification: PreClassificationResult;
  try { classification = await preClassify(req.code, req.language, req.errorOutput); }
  catch { classification = { candidates: [], topPattern: null, summaryForLLM: '' }; }

  try {
    const message = await callLLM({
      system: SYSTEM_PROMPT,
      user: buildUserMessage(req, classification, hintLevel, studentContext),
    });
    const parsed = safeParse(message);
    if (!parsed.message || typeof parsed.message !== 'string')
      throw new LLMUnavailableError('llm-invalid-response', 'Malformed response');

    const finalPattern = (parsed.detectedPattern as MistakePattern | null)
      ?? classification.topPattern ?? null;
    if (finalPattern) {
      await db.mistakePatterns.record({
        studentId: req.studentId, exerciseId: req.exerciseId, pattern: finalPattern,
        source: parsed.detectedPattern ? 'llm' : 'classifier', timestamp: new Date(),
      });
    }
    return {
      message: parsed.message, hintLevel, detectedPattern: finalPattern,
      canEscalate: hintLevel < 4 && req.attemptNumber >= session.attemptsAtLevel,
      nextEscalationRequires: `Attempt the fix and resubmit to unlock level ${hintLevel + 1}.`,
    };
  } catch (err) {
    const reason = err instanceof LLMUnavailableError ? err.reason : 'llm-error';
    await db.telemetry.record({
      type: 'fallback-hint-served', studentId: req.studentId,
      exerciseId: req.exerciseId, reason, timestamp: new Date(),
    });
    const fallback = generateFallbackHint(classification, reason);
    if (fallback.detectedPattern) {
      await db.mistakePatterns.record({
        studentId: req.studentId, exerciseId: req.exerciseId,
        pattern: fallback.detectedPattern, source: 'classifier', timestamp: new Date(),
      });
    }
    return fallback;
  }
}

function buildUserMessage(req: TutorRequest, classification: PreClassificationResult,
  hintLevel: HintLevel, studentContext: string): string {
  return `EXERCISE: ${req.exerciseContext.title}
DESCRIPTION: ${req.exerciseContext.description}
LEARNING OBJECTIVES: ${req.exerciseContext.learningObjectives.join('; ')}
EXPECTED CONCEPTS: ${req.exerciseContext.expectedConcepts.join('; ')}

STUDENT'S CODE (${req.language}):
\`\`\`${req.language}
${req.code}
\`\`\`

ERROR OUTPUT:
\`\`\`
${req.errorOutput || '(no runtime error — likely logic bug)'}
\`\`\`

${classification.summaryForLLM}

ATTEMPT NUMBER: ${req.attemptNumber}
HINT LEVEL TO GIVE: ${hintLevel}

${studentContext}

Respond with a JSON object only:
{ "message": "<your Socratic response>", "detectedPattern": "<pattern or null>" }`;
}

function safeParse(text: string): any {
  try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; }
  catch { return {}; }
}
