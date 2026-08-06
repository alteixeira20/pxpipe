export type AccountingProvider = 'anthropic' | 'openai' | 'google' | 'featherless' | 'unknown';
export type SavingsEvidence = 'provider-reported' | 'estimated' | 'bytes-only' | 'unavailable';

export interface AccountingInput {
  provider: AccountingProvider;
  model?: string;
  originalBytes?: number;
  transformedBytes?: number;
  estimatedOriginalInputTokens?: number;
  estimatedTransformedInputTokens?: number;
  providerBaselineInputTokens?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  imageTokens?: number;
  proxyAddedLatencyMs?: number;
  modelLatencyMs?: number;
  fallbackCount?: number;
  bypassReason?: string;
}

export interface NormalizedAccounting {
  provider: AccountingProvider;
  model?: string;
  bytes: {
    original?: number;
    transformed?: number;
    reduced?: number;
    compressionRatio?: number;
  };
  tokens: {
    providerReportedOriginalInput?: number;
    providerReportedActualInput?: number;
    providerReportedReduced?: number;
    estimatedOriginalInput?: number;
    estimatedActualInput?: number;
    estimatedReduced?: number;
    cacheRead?: number;
    cacheWrite?: number;
    image?: number;
    output?: number;
    total?: number;
  };
  savings: {
    evidence: SavingsEvidence;
    inputTokensReduced?: number;
    inputReductionRatio?: number;
  };
  latency: {
    proxyAddedMs?: number;
    modelMs?: number;
  };
  fallbackCount: number;
  bypassReason?: string;
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function difference(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  return before - after;
}

function ratio(reduced: number | undefined, baseline: number | undefined): number | undefined {
  if (reduced === undefined || baseline === undefined || baseline <= 0) return undefined;
  return reduced / baseline;
}

/**
 * Provider usage buckets are not shaped identically:
 *
 * - Anthropic reports uncached input, cache creation and cache reads as
 *   disjoint buckets. Total physical input is their sum.
 * - OpenAI-compatible and Google usage report cached tokens as a subset of the
 *   input count. Adding the cache bucket would double-count it.
 * - Featherless is OpenAI-compatible, so it follows OpenAI semantics.
 */
export function providerActualInputTokens(input: AccountingInput): number | undefined {
  const reported = nonNegative(input.providerInputTokens);
  if (reported === undefined) return undefined;
  if (input.provider !== 'anthropic') return reported;
  return reported
    + (nonNegative(input.cacheReadTokens) ?? 0)
    + (nonNegative(input.cacheWriteTokens) ?? 0);
}

export function normalizeAccounting(input: AccountingInput): NormalizedAccounting {
  const originalBytes = nonNegative(input.originalBytes);
  const transformedBytes = nonNegative(input.transformedBytes);
  const bytesReduced = difference(originalBytes, transformedBytes);

  const providerOriginal = nonNegative(input.providerBaselineInputTokens);
  const providerActual = providerActualInputTokens(input);
  const providerReduced = difference(providerOriginal, providerActual);

  const estimatedOriginal = nonNegative(input.estimatedOriginalInputTokens);
  const estimatedActual = nonNegative(input.estimatedTransformedInputTokens);
  const estimatedReduced = difference(estimatedOriginal, estimatedActual);

  let evidence: SavingsEvidence = 'unavailable';
  let inputTokensReduced: number | undefined;
  let inputReductionRatio: number | undefined;
  if (providerReduced !== undefined) {
    evidence = 'provider-reported';
    inputTokensReduced = providerReduced;
    inputReductionRatio = ratio(providerReduced, providerOriginal);
  } else if (estimatedReduced !== undefined) {
    evidence = 'estimated';
    inputTokensReduced = estimatedReduced;
    inputReductionRatio = ratio(estimatedReduced, estimatedOriginal);
  } else if (bytesReduced !== undefined) {
    evidence = 'bytes-only';
  }

  const output = nonNegative(input.providerOutputTokens);
  const total = providerActual !== undefined && output !== undefined
    ? providerActual + output
    : undefined;

  return {
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    bytes: {
      ...(originalBytes !== undefined ? { original: originalBytes } : {}),
      ...(transformedBytes !== undefined ? { transformed: transformedBytes } : {}),
      ...(bytesReduced !== undefined ? { reduced: bytesReduced } : {}),
      ...(originalBytes !== undefined && originalBytes > 0 && transformedBytes !== undefined
        ? { compressionRatio: transformedBytes / originalBytes }
        : {}),
    },
    tokens: {
      ...(providerOriginal !== undefined ? { providerReportedOriginalInput: providerOriginal } : {}),
      ...(providerActual !== undefined ? { providerReportedActualInput: providerActual } : {}),
      ...(providerReduced !== undefined ? { providerReportedReduced: providerReduced } : {}),
      ...(estimatedOriginal !== undefined ? { estimatedOriginalInput: estimatedOriginal } : {}),
      ...(estimatedActual !== undefined ? { estimatedActualInput: estimatedActual } : {}),
      ...(estimatedReduced !== undefined ? { estimatedReduced } : {}),
      ...(nonNegative(input.cacheReadTokens) !== undefined ? { cacheRead: input.cacheReadTokens } : {}),
      ...(nonNegative(input.cacheWriteTokens) !== undefined ? { cacheWrite: input.cacheWriteTokens } : {}),
      ...(nonNegative(input.imageTokens) !== undefined ? { image: input.imageTokens } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(total !== undefined ? { total } : {}),
    },
    savings: {
      evidence,
      ...(inputTokensReduced !== undefined ? { inputTokensReduced } : {}),
      ...(inputReductionRatio !== undefined ? { inputReductionRatio } : {}),
    },
    latency: {
      ...(nonNegative(input.proxyAddedLatencyMs) !== undefined ? { proxyAddedMs: input.proxyAddedLatencyMs } : {}),
      ...(nonNegative(input.modelLatencyMs) !== undefined ? { modelMs: input.modelLatencyMs } : {}),
    },
    fallbackCount: nonNegative(input.fallbackCount) ?? 0,
    ...(input.bypassReason ? { bypassReason: input.bypassReason } : {}),
  };
}
