import { describe, expect, it } from 'vitest';

import {
  buildCodexEconomicsReport,
  CODEX_AB_MIN_PER_ARM,
} from '../src/core/codex-economics.js';
import type { TrackEvent } from '../src/core/tracker.js';

function event(overrides: Partial<TrackEvent> = {}): TrackEvent {
  return {
    ts: '2026-08-10T20:00:00.000Z',
    method: 'POST',
    path: '/responses',
    provider: 'codex',
    accounting_provider: 'openai',
    model: 'gpt-5.6-sol',
    status: 200,
    duration_ms: 1000,
    stream_termination: 'response_terminal',
    ...overrides,
  };
}

const compressed = (): TrackEvent => event({
  compressed: true,
  input_tokens: 1000,
  output_tokens: 50,
  cached_tokens: 900,
  baseline_imaged_tokens: 500,
  image_tokens: 100,
  native_injected_tokens: 20,
});

const passthrough = (): TrackEvent => event({
  provider: 'codex-passthrough',
  compressed: false,
  reason: 'compress=false',
  input_tokens: 1000,
  output_tokens: 50,
  cached_tokens: 900,
});

describe('Codex economics report', () => {
  it('separates raw context shrink from cache-weighted effective savings', () => {
    const report = buildCodexEconomicsReport([compressed(), passthrough()], 'gpt-5.6-sol');

    expect(report.providerInputTokens).toBe(2000);
    expect(report.cachedTokens).toBe(1800);
    expect(report.cacheSharePct).toBe(90);
    expect(report.grossRawSavedTokens).toBe(400);
    expect(report.netRawSavedTokens).toBe(380);
    expect(report.rawBaselineProviderInput).toBe(2380);
    expect(report.rawSavedPct).toBeCloseTo(15.966, 3);

    // Per event: actual = 100 uncached + 900*0.1 = 190.
    // Compressed counterfactual adds (500 - 100 - 20)*0.1 = 38.
    // Passthrough contributes zero counterfactual saving.
    expect(report.effectiveActualInput).toBe(380);
    expect(report.effectiveBaselineInput).toBe(418);
    expect(report.effectiveSavedInput).toBe(38);
    expect(report.effectiveSavedPct).toBeCloseTo(9.091, 3);
    expect(report.transformedEffectiveSavedPct).toBeCloseTo(16.667, 3);
  });

  it('requires routed passthrough observations before calling the A/B sample ready', () => {
    const report = buildCodexEconomicsReport(
      Array.from({ length: CODEX_AB_MIN_PER_ARM }, compressed),
      'gpt-5.6-sol',
    );
    expect(report.abReady).toBe(false);
    expect(report.passthroughBaselineRequests).toBe(0);
    expect(report.note).toContain('pxpipe codex --passthrough');
  });

  it('does not treat fail-open or globally disabled Codex rows as controlled A/B samples', () => {
    const report = buildCodexEconomicsReport([
      compressed(),
      event({
        compressed: false,
        reason: 'compress=false',
        input_tokens: 1000,
        cached_tokens: 900,
        output_tokens: 10,
      }),
    ]);
    expect(report.requests).toBe(2);
    expect(report.passthroughBaselineRequests).toBe(0);
    expect(report.passthrough.requests).toBe(0);
  });

  it('marks a balanced routed sample as ready without pretending selection bias disappeared', () => {
    const report = buildCodexEconomicsReport([
      ...Array.from({ length: CODEX_AB_MIN_PER_ARM }, compressed),
      ...Array.from({ length: CODEX_AB_MIN_PER_ARM }, passthrough),
    ]);
    expect(report.abReady).toBe(true);
    expect(report.observedCohortDeltaPct).toBe(0);
    expect(report.note).toMatch(/selection bias/i);
  });

  it('fails the verdict when native framing makes a transform net-negative', () => {
    const report = buildCodexEconomicsReport([event({
      compressed: true,
      input_tokens: 1000,
      cached_tokens: 900,
      output_tokens: 1,
      baseline_imaged_tokens: 100,
      image_tokens: 90,
      native_injected_tokens: 20,
    })]);
    expect(report.netRawSavedTokens).toBe(-10);
    expect(report.rawBaselineProviderInput).toBe(990);
    expect(report.rawSavedPct).toBeLessThan(0);
    expect(report.netNegativeTransforms).toBe(1);
    expect(report.effectiveSavedInput).toBeLessThan(0);
    expect(report.verdict).toBe('regression');
  });

  it('ignores unrelated OpenAI traffic when explicit provider identity exists', () => {
    const report = buildCodexEconomicsReport([
      compressed(),
      event({ provider: 'openai', path: '/responses', input_tokens: 999_999 }),
      event({ provider: 'codex', path: '/models', input_tokens: 999_999 }),
    ]);
    expect(report.requests).toBe(1);
    expect(report.providerInputTokens).toBe(1000);
  });
});
