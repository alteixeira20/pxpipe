import { describe, expect, it } from 'vitest';
import { computeProviderEconomics } from '../src/core/economics.js';

 describe('canonical provider economics', () => {
  it('keeps OpenAI cached_tokens as a subset of input and credits only a measured transform delta', () => {
    const row = computeProviderEconomics({
      provider: 'openai', model: 'gpt-5.6-sol', compressed: true,
      inputTokens: 10_000, outputTokens: 100, cachedTokens: 8_000,
      imageTokens: 200, baselineImagedTokens: 2_000, nativeInjectedTokens: 100,
    });
    expect(row.haveBaseline).toBe(true);
    expect(row.creditSaving).toBe(true);
    expect(row.rawActualInput).toBe(10_000);
    expect(row.rawBaselineInput).toBe(11_700);
    expect(row.baselineInputEff).toBeGreaterThan(row.actualInputEff);
  });

  it('never fabricates OpenAI savings without the transformed-region counterfactual', () => {
    const row = computeProviderEconomics({
      provider: 'openai', model: 'gpt-5.6-sol', compressed: false,
      inputTokens: 10_000, outputTokens: 100, cachedTokens: 9_000,
    });
    expect(row.creditSaving).toBe(false);
    expect(row.baselineInputEff).toBe(row.actualInputEff);
    expect(row.rawBaselineInput).toBe(row.rawActualInput);
  });

  it('uses a successful Google provider probe before a local estimate', () => {
    const row = computeProviderEconomics({
      provider: 'google', compressed: true, inputTokens: 900, outputTokens: 20,
      baselineTokens: 1_500, baselineProbeStatus: 'ok',
      imageTokens: 100, baselineImagedTokens: 500,
    });
    expect(row.counterfactualKind).toBe('provider-probe');
    expect(row.baselineInputEff).toBe(1_500);
  });

  it('requires an authoritative Anthropic probe before crediting savings', () => {
    const partial = computeProviderEconomics({
      provider: 'anthropic', compressed: true,
      inputTokens: 100, outputTokens: 20, cacheCreateTokens: 900,
      baselineTokens: 2_000, baselineCacheableTokens: 1_800,
      baselineProbeStatus: 'partial',
    });
    expect(partial.creditSaving).toBe(false);
    expect(partial.baselineInputEff).toBe(partial.actualInputEff);
  });

  it('prices a warm Anthropic counterfactual with the same observed cache state', () => {
    const row = computeProviderEconomics({
      provider: 'anthropic', compressed: true,
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 900,
      baselineTokens: 2_000, baselineCacheableTokens: 1_800,
      baselineProbeStatus: 'ok', anthropicWarm: true, anthropicPrevCacheable: 1_700,
    });
    expect(row.creditSaving).toBe(true);
    expect(row.counterfactualKind).toBe('provider-probe');
    expect(row.baselineInputEff).toBeGreaterThan(0);
  });
});
