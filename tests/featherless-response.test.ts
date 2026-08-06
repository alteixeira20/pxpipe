import { describe, expect, it } from 'vitest';

import {
  classifyFeatherlessFailure,
  parseRetryAfter,
  shouldAutomaticallyRetryFeatherless,
} from '../src/core/featherless-response.js';

describe('Featherless Retry-After parsing', () => {
  it('parses delta seconds', () => {
    expect(parseRetryAfter('2.5')).toBe(2_500);
  });

  it('parses HTTP dates without returning a negative duration', () => {
    const now = Date.parse('2026-08-06T18:00:00Z');
    expect(parseRetryAfter('Thu, 06 Aug 2026 18:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Thu, 06 Aug 2026 17:59:00 GMT', now)).toBe(0);
  });

  it('rejects malformed values', () => {
    expect(parseRetryAfter('later')).toBeUndefined();
  });
});

describe('Featherless failure classification', () => {
  it.each([
    [401, 'authentication', true],
    [403, 'permission', true],
    [404, 'model_unavailable', true],
    [413, 'payload_rejected', true],
    [415, 'payload_rejected', true],
    [422, 'payload_rejected', true],
    [500, 'transient_upstream', false],
    [503, 'transient_upstream', false],
    [504, 'timeout', false],
  ] as const)('classifies HTTP %s as %s', (status, kind, hard) => {
    expect(classifyFeatherlessFailure(status)).toMatchObject({ kind, hard });
  });

  it('retains rate-limit delay without treating it as image incapability', () => {
    const failure = classifyFeatherlessFailure(429, 'too many requests', '17');
    expect(failure).toEqual({
      kind: 'rate_limit',
      hard: false,
      retryAfterMs: 17_000,
    });
    expect(shouldAutomaticallyRetryFeatherless(failure)).toBe(true);
  });

  it('does not permit a hot-loop retry without Retry-After', () => {
    const failure = classifyFeatherlessFailure(429, 'too many requests');
    expect(shouldAutomaticallyRetryFeatherless(failure)).toBe(false);
  });

  it('recognizes provider error envelopes returned with HTTP 200', () => {
    expect(classifyFeatherlessFailure(200, JSON.stringify({
      code: 'completion_error',
      message: 'This model is busy.',
    }))).toEqual({ kind: 'provider_error', hard: false });
  });

  it('does not classify a successful normal response', () => {
    expect(classifyFeatherlessFailure(200, '{"choices":[]}')).toBeNull();
  });
});
