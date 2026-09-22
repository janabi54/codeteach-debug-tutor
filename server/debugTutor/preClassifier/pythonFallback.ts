import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PatternCandidate } from './index.js';

const exec = promisify(execFile);
export async function runPythonFallback(code: string, language: string): Promise<PatternCandidate[]> {
  if (language !== 'python') return [];
  try {
    const { stdout } = await exec('python3', ['-m', 'pyflakes', '-'], { timeout: 800 } as any);
    return parse(stdout.toString());
  } catch (err: any) {
    return err.stdout ? parse(err.stdout.toString()) : [];
  }
}
function parse(output: string): PatternCandidate[] {
  const out: PatternCandidate[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/<stdin>:(\d+):(\d+)\s+(.+)/);
    if (!m) continue;
    const [, ln, col, msg] = m;
    out.push({
      pattern: /undefined name/.test(msg) ? 'scope-issue' : 'logic-inversion',
      confidence: 'high', source: 'eslint', evidence: msg.trim(),
      location: { line: parseInt(ln), column: parseInt(col) }, ruleId: 'pyflakes',
    });
  }
  return out;
}
