import { describe, expect, it } from 'vitest';

import {
  normalizeAccounting,
  providerActualInputTokens,
} from '../src/core/accounting.js';

describe('provider input normalization', () => {
  it('sums Anthropic disjoint cache buckets', () => {
    expect(providerActualInputTokens({
      provider: 'anthropic',
      providerInputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 200,
    })).toBe(1_000);
  });

  it.each(['openai', 'google', 'featherless'] as const)(
    'does not double-count cached input for %s',
    (provider) => {
      expect(providerActualInputTokens({
        provider,
        providerInputTokens: 1_000,
        cacheReadTokens: 700,
      })).toBe(1_000);
    },
  );
});

describe('normalized accounting evidence', () => {
  it('prefers provider-reported token reduction over estimates', () => {
    const result = normalizeAccounting({
      provider: 'anthropic',
      model: 'claude-opus-5',
      originalBytes: 100_000,
      transformedBytes: 25_000,
      providerBaselineInputTokens: 20_000,
      providerInputTokens: 1_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 500,
      providerOutputTokens: 300,
      estimatedOriginalInputTokens: 25_000,
      estimatedTransformedInputTokens: 4_000,
      imageTokens: 1_200,
      proxyAddedLatencyMs: 85,
      modelLatencyMs: 2_400,
      fallbackCount: 1,
    });

    expect(result.savings).toEqual({
      evidence: 'provider-reported',
      inputTokensReduced: 16_500,
      inputReductionRatio: 0.825,
    });
    expect(result.tokens.providerReportedActualInput).toBe(3_500);
    expect(result.tokens.total).toBe(3_800);
    expect(result.tokens.estimatedReduced).toBe(21_000);
    expect(result.bytes).toEqual({
      original: 100_000,
      transformed: 25_000,
      reduced: 75_000,
      compressionRatio: 0.25,
    });
  });

  it('labels token savings estimated when no provider baseline exists', () => {
    const result = normalizeAccounting({
      provider: 'openai',
      estimatedOriginalInputTokens: 10_000,
      estimatedTransformedInputTokens: 4_000,
    });
    expect(result.savings).toEqual({
      evidence: 'estimated',
      inputTokensReduced: 6_000,
      inputReductionRatio: 0.6,
    });
  });

  it('reports bytes-only evidence without inventing token savings', () => {
    const result = normalizeAccounting({
      provider: 'unknown',
      originalBytes: 1_000,
      transformedBytes: 400,
      bypassReason: 'provider_usage_unavailable',
    });
    expect(result.savings.evidence).toBe('bytes-only');
    expect(result.savings.inputTokensReduced).toBeUndefined();
    expect(result.tokens.providerReportedReduced).toBeUndefined();
    expect(result.bypassReason).toBe('provider_usage_unavailable');
  });

  it('never converts invalid negative counters into savings', () => {
    const result = normalizeAccounting({
      provider: 'openai',
      providerBaselineInputTokens: -1,
      providerInputTokens: -10,
      originalBytes: -100,
      transformedBytes: 20,
      fallbackCount: -3,
    });
    expect(result.savings.evidence).toBe('unavailable');
    expect(result.bytes.original).toBeUndefined();
    expect(result.tokens.providerReportedActualInput).toBeUndefined();
    expect(result.fallbackCount).toBe(0);
  });
});
