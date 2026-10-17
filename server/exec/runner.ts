import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult, TraceStep } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TRACER_PATH = resolve(__dirname, 'tracer.py');

const DOCKER_IMAGE = 'codeteach-runner:latest';
const TIMEOUT_MS = 5_000;
const HARD_TIMEOUT_MS = 6_500;

const TRACE_OPEN = '__CT_TRACE__';
const TRACE_CLOSE = '__CT_TRACE_END__';
const SYNTAX_ERROR_PREFIX = '__CT_SYNTAX_ERROR__';

/**
 * Run Python source in the Docker sandbox.
 *
 * Steps:
 *  1. Instrument source via tracer.py (AST rewriting)
 *  2. If syntax error → return immediately, no Docker run
 *  3. Write instrumented source to a temp file
 *  4. Mount into container, run with --rm + named container
 *  5. Capture stdout/stderr, kill on timeout
 *  6. Parse trace markers from stderr
 */
export async function runPython(sourceCode: string): Promise<RunResult> {
  const startedAt = Date.now();

  // ── 1. Instrument ─────────────────────────────────────────
  const tracerResult = await runTracer(sourceCode);
  if (tracerResult.syntaxError) {
    return {
      stdout: '',
      stderr: '',
      trace: [],
      exitCode: 1,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      syntaxError: tracerResult.syntaxError,
    };
  }

  // ── 2. Write temp file ────────────────────────────────────
  const id = randomUUID().slice(0, 12);
  const tmpFile = join(tmpdir(), `ct-${id}-instrumented.py`);
  writeFileSync(tmpFile, tracerResult.instrumented, 'utf8');

  const containerName = `ct-${id}`;

  // ── 3. Run in Docker ──────────────────────────────────────
  const rawResult = await runInDocker(tmpFile, containerName);

  // ── 4. Cleanup temp file ──────────────────────────────────
  try {
    unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }

  // ── 5. Parse trace from stderr ────────────────────────────
  const { trace, cleanStderr } = extractTrace(rawResult.stderr);

  return {
    stdout: rawResult.stdout,
    stderr: cleanStderr,
    trace,
    exitCode: rawResult.exitCode,
    timedOut: rawResult.timedOut,
    durationMs: Date.now() - startedAt,
    syntaxError: null,
  };
}

// ─────────────────────────────────────────────────────────────

interface TracerOutput {
  instrumented: string;
  syntaxError: string | null;
}

function runTracer(sourceCode: string): Promise<TracerOutput> {
  return new Promise((resolveResult) => {
    const child = spawn('python3', [TRACER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    child.on('close', (code) => {
      if (code !== 0) {
        const trimmed = stderr.trim();
        if (trimmed.startsWith(SYNTAX_ERROR_PREFIX)) {
          const detail = trimmed.slice(SYNTAX_ERROR_PREFIX.length);
          resolveResult({ instrumented: '', syntaxError: detail });
        } else {
          resolveResult({
            instrumented: '',
            syntaxError: 'internal tracer error: ' + (trimmed || `exit ${code}`),
          });
        }
        return;
      }
      resolveResult({ instrumented: stdout, syntaxError: null });
    });

    child.stdin.write(sourceCode);
    child.stdin.end();
  });
}

interface DockerRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function runInDocker(tmpFile: string, containerName: string): Promise<DockerRunResult> {
  return new Promise((resolveResult) => {
    let timedOut = false;
    let hardKilled = false;

    const args = [
      'run',
      '--rm',
      '--name', containerName,
      '--network=none',
      '--memory=128m',
      '--cpus=0.5',
      '-v', `${tmpFile}:/home/runner/main.py:ro`,
      DOCKER_IMAGE,
    ];

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    // Soft timeout: docker kill the container
    const softTimer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', containerName]).on('error', () => {});
    }, TIMEOUT_MS);

    // Hard timeout: give up and kill the CLI process
    const hardTimer = setTimeout(() => {
      hardKilled = true;
      child.kill('SIGKILL');
    }, HARD_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolveResult({
        stdout,
        stderr,
        exitCode: hardKilled ? 124 : (code ?? 1),
        timedOut: timedOut || hardKilled,
      });
    });

    child.on('error', (err) => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolveResult({
        stdout,
        stderr: stderr + '\ndocker spawn error: ' + err.message,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

function extractTrace(stderrRaw: string): { trace: TraceStep[]; cleanStderr: string } {
  const openIdx = stderrRaw.indexOf(TRACE_OPEN);
  if (openIdx === -1) {
    return { trace: [], cleanStderr: stderrRaw };
  }
  const closeIdx = stderrRaw.indexOf(TRACE_CLOSE, openIdx + TRACE_OPEN.length);
  if (closeIdx === -1) {
    return { trace: [], cleanStderr: stderrRaw };
  }

  const jsonStr = stderrRaw.slice(openIdx + TRACE_OPEN.length, closeIdx);
  let parsed: Array<{ line: number; loopVar: string; value: string }> = [];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { trace: [], cleanStderr: stderrRaw };
  }

  const trace: TraceStep[] = parsed.map((p, i) => ({
    step: i + 1,
    line: p.line,
    loopVar: p.loopVar,
    value: p.value,
  }));

  // Strip the marker (and its trailing newline) from stderr
  const before = stderrRaw.slice(0, openIdx);
  const after = stderrRaw.slice(closeIdx + TRACE_CLOSE.length).replace(/^\r?\n/, '');
  return { trace, cleanStderr: before + after };
}
