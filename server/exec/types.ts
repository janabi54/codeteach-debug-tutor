export interface TraceStep {
  step: number;
  line: number;
  loopVar: string;
  value: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  trace: TraceStep[];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  syntaxError: string | null;
}
