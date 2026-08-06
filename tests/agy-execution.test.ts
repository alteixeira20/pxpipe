import { describe, expect, it } from 'vitest';

import {
  estimateAgyInputTokens,
  parseAgyBatchArgs,
  shouldStopForFailure,
} from '../src/agy-execution.js';

describe('AGY batch option parsing', () => {
  it('parses every execution guard and preserves AGY arguments', () => {
    const parsed = parseAgyBatchArgs([
      '--max-calls', '12',
      '--max-duration', '5m',
      '--max-input-tokens', '42000',
      '--concurrency', '3',
      '--timeout', '45s',
      '--max-output-bytes', '8192',
      '--stop-on', 'quota,auth,systemic',
      '--input', 'prompts.txt',
      '--',
      '--print',
      '--output-format',
      'json',
      '--model',
      'gemini-test',
    ]);

    expect(parsed.inputFile).toBe('prompts.txt');
    expect(parsed.agyArgs).toEqual([
      '--print',
      '--output-format',
      'json',
      '--model',
      'gemini-test',
    ]);
    expect(parsed.limits).toMatchObject({
      maxCalls: 12,
      maxDurationMs: 300_000,
      maxEstimatedInputTokens: 42_000,
      concurrency: 3,
      perCallTimeoutMs: 45_000,
      maxOutputBytes: 8_192,
    });
    expect([...parsed.limits.stopOn]).toEqual(['quota', 'auth', 'systemic']);
  });

  it('caps concurrency at maximum calls', () => {
    const parsed = parseAgyBatchArgs(['--max-calls', '2', '--concurrency', '20', '--']);
    expect(parsed.limits.concurrency).toBe(2);
  });

  it.each([
    ['--max-calls', '0'],
    ['--concurrency', '-1'],
    ['--timeout', 'later'],
    ['--stop-on', 'quota,anything'],
  ])('rejects invalid %s value %s', (option, value) => {
    expect(() => parseAgyBatchArgs([option, value, '--'])).toThrow();
  });
});

describe('AGY protective input accounting', () => {
  it('labels input accounting as a conservative estimate', () => {
    expect(estimateAgyInputTokens('12345678', ['--print'])).toBe(4);
    expect(estimateAgyInputTokens('', [])).toBe(1);
  });
});

describe('AGY systemic failure stop policy', () => {
  const failure = (kind: Parameters<typeof shouldStopForFailure>[0] extends infer T
    ? T extends { kind: infer K } ? K : never
    : never) => ({ kind, safeMessage: String(kind) } as NonNullable<Parameters<typeof shouldStopForFailure>[0]>);

  it('always stops on quota when quota is selected', () => {
    expect(shouldStopForFailure(failure('quota_exhausted'), new Set(['quota']))).toBe(true);
  });

  it('stops on authentication when auth is selected', () => {
    expect(shouldStopForFailure(failure('not_authenticated'), new Set(['auth']))).toBe(true);
  });

  it.each(['rate_limited', 'model_unavailable', 'transport_failure'] as const)(
    'treats %s as systemic',
    (kind) => expect(shouldStopForFailure(failure(kind), new Set(['systemic']))).toBe(true),
  );

  it('does not stop for a per-task permission failure under systemic-only policy', () => {
    expect(shouldStopForFailure(failure('permission_denied'), new Set(['systemic']))).toBe(false);
  });
});
