import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCircuitBreakers,
  isCircuitBreakerOpen,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
  shouldFallbackFeatherlessResponse,
} from '../src/core/featherless.js';

const provider = 'featherless';
const upstream = 'https://api.featherless.ai';
const model = 'moonshotai/Kimi-K3';

describe('Featherless fallback policy', () => {
  it.each([408, 425, 429, 500, 502, 503, 504])('does not amplify transient HTTP %s failures', (status) => {
    expect(shouldFallbackFeatherlessResponse(status, 'busy')).toBe(false);
  });

  it.each([401, 403, 404, 409])('does not retry auth or routing HTTP %s failures', (status) => {
    expect(shouldFallbackFeatherlessResponse(status, 'bad request')).toBe(false);
  });

  it.each([400, 413, 415, 422])('allows a text fallback for transform-shaped HTTP %s failures', (status) => {
    expect(shouldFallbackFeatherlessResponse(status)).toBe(true);
  });

  it('allows a 200 error envelope only when it indicates image incompatibility', () => {
    expect(shouldFallbackFeatherlessResponse(200, 'image input is unsupported')).toBe(true);
    expect(shouldFallbackFeatherlessResponse(200, 'model is busy, try again later')).toBe(false);
  });
});

describe('Featherless image circuit breaker', () => {
  beforeEach(() => clearCircuitBreakers());

  it('opens after three confirmed transform failures and resets on success', () => {
    recordCircuitBreakerFailure(provider, upstream, model);
    recordCircuitBreakerFailure(provider, upstream, model);
    expect(isCircuitBreakerOpen(provider, upstream, model)).toBe(false);

    recordCircuitBreakerFailure(provider, upstream, model);
    expect(isCircuitBreakerOpen(provider, upstream, model)).toBe(true);

    recordCircuitBreakerSuccess(provider, upstream, model);
    expect(isCircuitBreakerOpen(provider, upstream, model)).toBe(false);
  });
});
