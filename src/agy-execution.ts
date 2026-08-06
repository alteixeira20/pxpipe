import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
  buildAgyEnvironment,
  classifyAgyFailure,
  findExecutable,
  writeAgyCooldown,
  type AgyFailure,
  type AgyFailureKind,
} from './agy.js';

export interface AgyExecutionLimits {
  maxCalls: number;
  maxDurationMs: number;
  maxEstimatedInputTokens: number;
  concurrency: number;
  perCallTimeoutMs: number;
  maxOutputBytes: number;
  stopOn: ReadonlySet<'quota' | 'auth' | 'systemic'>;
}

export interface AgyBatchOptions {
  limits: AgyExecutionLimits;
  agyArgs: string[];
  prompts: string[];
}

export interface AgyCallResult {
  index: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimited: boolean;
  estimatedInputTokens: number;
  failure: AgyFailure | null;
}

export interface AgyBatchSummary {
  started: number;
  completed: number;
  succeeded: number;
  failed: number;
  stoppedBy?: AgyFailureKind | 'duration' | 'input_budget' | 'cancelled';
  results: AgyCallResult[];
}

const DEFAULTS: AgyExecutionLimits = {
  maxCalls: 100,
  maxDurationMs: 30 * 60_000,
  maxEstimatedInputTokens: 1_000_000,
  concurrency: 1,
  perCallTimeoutMs: 10 * 60_000,
  maxOutputBytes: 16 * 1024 * 1024,
  stopOn: new Set(['quota', 'auth', 'systemic']),
};

const SYSTEMIC = new Set<AgyFailureKind>([
  'not_authenticated',
  'quota_exhausted',
  'rate_limited',
  'model_unavailable',
  'transport_failure',
]);

function positiveInteger(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function durationMs(raw: string | undefined, name: string): number {
  if (!raw) throw new Error(`${name} requires a duration`);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) throw new Error(`${name} requires a duration such as 500ms, 30s, 10m or 1h`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multiplier = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const result = Math.ceil(value * multiplier);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} duration is out of range`);
  return result;
}

function stopSet(raw: string | undefined): ReadonlySet<'quota' | 'auth' | 'systemic'> {
  if (!raw) throw new Error('--stop-on requires quota,auth,systemic or a comma-separated set');
  const allowed = new Set(['quota', 'auth', 'systemic']);
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !allowed.has(value))) {
    throw new Error('--stop-on accepts only quota,auth,systemic');
  }
  return new Set(values as Array<'quota' | 'auth' | 'systemic'>);
}

export function parseAgyBatchArgs(argv: readonly string[]): Omit<AgyBatchOptions, 'prompts'> & { inputFile?: string } {
  const limits: AgyExecutionLimits = { ...DEFAULTS, stopOn: new Set(DEFAULTS.stopOn) };
  let inputFile: string | undefined;
  let separator = argv.indexOf('--');
  if (separator < 0) separator = argv.length;

  for (let index = 0; index < separator; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === '--max-calls') limits.maxCalls = positiveInteger(next(), arg);
    else if (arg === '--max-duration') limits.maxDurationMs = durationMs(next(), arg);
    else if (arg === '--max-input-tokens') limits.maxEstimatedInputTokens = positiveInteger(next(), arg);
    else if (arg === '--concurrency') limits.concurrency = positiveInteger(next(), arg);
    else if (arg === '--timeout') limits.perCallTimeoutMs = durationMs(next(), arg);
    else if (arg === '--max-output-bytes') limits.maxOutputBytes = positiveInteger(next(), arg);
    else if (arg === '--stop-on') limits.stopOn = stopSet(next());
    else if (arg === '--input') inputFile = next();
    else if (arg === '-h' || arg === '--help') throw new Error('help');
    else throw new Error(`unknown option: ${arg}`);
  }

  if (limits.concurrency > limits.maxCalls) limits.concurrency = limits.maxCalls;
  return {
    limits,
    agyArgs: separator < argv.length ? [...argv.slice(separator + 1)] : [],
    ...(inputFile ? { inputFile } : {}),
  };
}

export function estimateAgyInputTokens(prompt: string, args: readonly string[]): number {
  // Explicitly an estimate: it is used only as a protective batch budget, not
  // reported as provider usage or savings.
  const characters = prompt.length + args.reduce((sum, arg) => sum + arg.length + 1, 0);
  return Math.max(1, Math.ceil(characters / 4));
}

export function shouldStopForFailure(
  failure: AgyFailure | null,
  stopOn: ReadonlySet<'quota' | 'auth' | 'systemic'>,
): boolean {
  if (!failure) return false;
  if (failure.kind === 'quota_exhausted' && stopOn.has('quota')) return true;
  if (failure.kind === 'not_authenticated' && stopOn.has('auth')) return true;
  return SYSTEMIC.has(failure.kind) && stopOn.has('systemic');
}

class BoundedCapture {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maximum: number) {}

  push(chunk: Buffer): void {
    if (this.maximum <= 0) return;
    if (chunk.length >= this.maximum) {
      this.chunks = [chunk.subarray(chunk.length - this.maximum)];
      this.size = this.maximum;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maximum && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.size - this.maximum;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct process below.
    }
  }
  child.kill(signal);
}

async function executeCall(input: {
  binary: string;
  args: string[];
  prompt: string;
  index: number;
  limits: AgyExecutionLimits;
  signal: AbortSignal;
}): Promise<AgyCallResult> {
  const estimatedInputTokens = estimateAgyInputTokens(input.prompt, input.args);
  const stdout = new BoundedCapture(input.limits.maxOutputBytes);
  const stderr = new BoundedCapture(input.limits.maxOutputBytes);
  let observedOutputBytes = 0;
  let outputLimited = false;
  let timedOut = false;

  const child = spawn(input.binary, [...input.args, input.prompt], {
    cwd: process.cwd(),
    env: buildAgyEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const forward = (target: NodeJS.WriteStream, capture: BoundedCapture) => (chunk: Buffer): void => {
    observedOutputBytes += chunk.length;
    target.write(chunk);
    capture.push(chunk);
    if (!outputLimited && observedOutputBytes > input.limits.maxOutputBytes) {
      outputLimited = true;
      killProcessTree(child, 'SIGTERM');
    }
  };
  child.stdout?.on('data', forward(process.stdout, stdout));
  child.stderr?.on('data', forward(process.stderr, stderr));

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, 'SIGTERM');
  }, input.limits.perCallTimeoutMs);
  timeout.unref();

  const onAbort = (): void => killProcessTree(child, 'SIGTERM');
  input.signal.addEventListener('abort', onAbort, { once: true });

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', () => resolve({ code: 127, signal: null }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  input.signal.removeEventListener('abort', onAbort);

  const failure = outputLimited
    ? { kind: 'transport_failure' as const, safeMessage: 'AGY exceeded the configured output limit.' }
    : classifyAgyFailure({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode: code,
        timedOut,
        structuredExpected: input.args.some((arg) => arg === 'json' || arg === 'stream-json'),
      });
  if (failure) writeAgyCooldown(failure);

  return {
    index: input.index,
    exitCode: code,
    signal,
    timedOut,
    outputLimited,
    estimatedInputTokens,
    failure,
  };
}

export async function runAgyBatch(options: AgyBatchOptions, signal = new AbortController().signal): Promise<AgyBatchSummary> {
  const binary = findExecutable('agy');
  if (!binary) throw new Error('AGY executable not found on PATH');

  const prompts = options.prompts.slice(0, options.limits.maxCalls);
  const startedAt = Date.now();
  const results: AgyCallResult[] = [];
  let cursor = 0;
  let estimatedTokensCommitted = 0;
  let stoppedBy: AgyBatchSummary['stoppedBy'];
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  const claim = (): { prompt: string; index: number } | null => {
    if (controller.signal.aborted || stoppedBy) return null;
    if (Date.now() - startedAt >= options.limits.maxDurationMs) {
      stoppedBy = 'duration';
      controller.abort(new Error('AGY batch duration exceeded'));
      return null;
    }
    const prompt = prompts[cursor];
    if (prompt === undefined) return null;
    const estimate = estimateAgyInputTokens(prompt, options.agyArgs);
    if (estimatedTokensCommitted + estimate > options.limits.maxEstimatedInputTokens) {
      stoppedBy = 'input_budget';
      controller.abort(new Error('AGY estimated input-token budget exceeded'));
      return null;
    }
    const index = cursor;
    cursor += 1;
    estimatedTokensCommitted += estimate;
    return { prompt, index };
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const next = claim();
      if (!next) return;
      const result = await executeCall({
        binary,
        args: options.agyArgs,
        prompt: next.prompt,
        index: next.index,
        limits: options.limits,
        signal: controller.signal,
      });
      results.push(result);
      if (shouldStopForFailure(result.failure, options.limits.stopOn)) {
        stoppedBy = result.failure!.kind;
        controller.abort(new Error(`AGY systemic failure: ${result.failure!.kind}`));
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: options.limits.concurrency }, () => worker()));
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted && !stoppedBy) stoppedBy = 'cancelled';
  results.sort((left, right) => left.index - right.index);

  return {
    started: cursor,
    completed: results.length,
    succeeded: results.filter((result) => result.exitCode === 0 && !result.failure).length,
    failed: results.filter((result) => result.exitCode !== 0 || result.failure).length,
    ...(stoppedBy ? { stoppedBy } : {}),
    results,
  };
}

function printHelp(): void {
  console.log(`pxpipe agy-batch — bounded AGY JSONL executor

Usage:
  pxpipe agy-batch [LIMITS] [--input FILE] -- [AGY_ARGS...]

Prompts are read one per non-empty line from FILE or stdin and appended to the
AGY arguments. Output bytes are forwarded unchanged. Summary diagnostics are
written to stderr.

Limits:
  --max-calls N
  --max-duration 30s|10m|1h
  --max-input-tokens N       estimated protective budget, never provider usage
  --concurrency N
  --timeout 30s|10m
  --max-output-bytes N
  --stop-on quota,auth,systemic
`);
}

async function readPrompts(inputFile?: string): Promise<string[]> {
  const text = inputFile
    ? await readFile(inputFile, 'utf8')
    : await new Response(process.stdin as unknown as BodyInit).text();
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function runAgyBatchEntry(argv: readonly string[]): Promise<void> {
  try {
    const parsed = parseAgyBatchArgs(argv);
    const prompts = await readPrompts(parsed.inputFile);
    const controller = new AbortController();
    const cancel = (): void => controller.abort(new Error('cancelled'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const summary = await runAgyBatch({
      limits: parsed.limits,
      agyArgs: parsed.agyArgs,
      prompts,
    }, controller.signal);
    console.error(`[pxpipe] agy-batch: ${JSON.stringify(summary)}`);
    process.exitCode = summary.failed === 0 && !summary.stoppedBy ? 0 : 1;
  } catch (error) {
    if ((error as Error).message === 'help') {
      printHelp();
      return;
    }
    console.error(`[pxpipe] agy-batch: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
