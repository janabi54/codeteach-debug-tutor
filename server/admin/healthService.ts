import { db } from '../db.js';
const HINT_SERVED = 'hint-served';
const FALLBACK_SERVED = 'fallback-hint-served';

export interface DebugTutorHealth {
  generatedAt: string;
  window: { hours: number; since: string };
  hints: { total: number; fromLLM: number; fromFallback: number; fallbackRate: number; avgLatencyMs: number | null };
  fallbackBreakdown: Record<string, number>;
  patterns: { top: Array<{ pattern: string; count: number; pct: number }>; byConfidence: { high: number; medium: number; low: number }; classifierOnly: number };
  circuitBreaker: { state: 'closed' | 'open'; recentFailures: number; openedAt: string | null };
  anomalies: string[];
}

export async function getDebugTutorHealth(windowHours = 24): Promise<DebugTutorHealth> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const [total, fallbackEvents, llmEvents, patternEvents] = await Promise.all([
    db.telemetry.count({ type: HINT_SERVED, since }),
    db.telemetry.find({ type: FALLBACK_SERVED, since }),
    db.telemetry.find({ type: HINT_SERVED, since }),
    db.mistakePatterns.findSince(since),
  ]);
  const fromFallback = fallbackEvents.length;
  const fromLLM = Math.max(0, total - fromFallback);
  const fb = fallbackEvents.reduce<Record<string, number>>((a, e) => { const k = e.reason ?? 'unknown'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const counts = patternEvents.reduce<Record<string, number>>((a, p) => { a[p.pattern] = (a[p.pattern] ?? 0) + 1; return a; }, {});
  const totalP = patternEvents.length;
  const top = Object.entries(counts).map(([pattern, count]) => ({ pattern, count, pct: totalP ? count / totalP : 0 }))
    .sort((a, b) => b.count - a.count).slice(0, 10);
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let classifierOnly = 0;
  for (const p of patternEvents) {
    if (p.source === 'classifier') classifierOnly++;
    if (p.confidence && p.confidence in byConfidence) byConfidence[p.confidence]++;
  }
  const lat = llmEvents.map(e => e.latencyMs).filter((n): n is number => typeof n === 'number');
  const avgLatencyMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const breaker = await db.telemetry.findLatest({ type: 'circuit-breaker-state' });
  const health: DebugTutorHealth = {
    generatedAt: new Date().toISOString(),
    window: { hours: windowHours, since: since.toISOString() },
    hints: { total, fromLLM, fromFallback, fallbackRate: total ? fromFallback / total : 0, avgLatencyMs },
    fallbackBreakdown: fb,
    patterns: { top, byConfidence, classifierOnly },
    circuitBreaker: { state: breaker?.state === 'open' ? 'open' : 'closed', recentFailures: breaker?.failures ?? 0, openedAt: breaker?.openedAt ?? null },
    anomalies: [],
  };
  health.anomalies = detect(health);
  return health;
}

function detect(h: DebugTutorHealth): string[] {
  const f: string[] = [];
  if (h.hints.fallbackRate > 0.10) f.push(`Fallback rate is ${(h.hints.fallbackRate * 100).toFixed(1)}% (> 10%)`);
  if (h.hints.avgLatencyMs && h.hints.avgLatencyMs > 5000) f.push(`Avg LLM latency is ${h.hints.avgLatencyMs}ms`);
  if (h.circuitBreaker.state === 'open') f.push(`Circuit breaker OPEN since ${h.circuitBreaker.openedAt}`);
  const d = h.patterns.top[0];
  if (d && d.pct > 0.60 && h.patterns.top.length > 3) f.push(`"${d.pattern}" is ${(d.pct * 100).toFixed(0)}% of mistakes`);
  return f;
}
