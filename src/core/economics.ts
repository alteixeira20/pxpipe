/**
 * Canonical per-request economics for every provider family PXPipe accounts.
 *
 * This module is pure and runtime-neutral. Dashboard, offline reports and
 * provider-specific CLIs should consume this result rather than re-implementing
 * cache/counterfactual math independently.
 */
import {
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
} from './baseline.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAIBaselineInputEff,
  computeOpenAIBaselineRawTokens,
  openAIOutputRate,
} from './openai-savings.js';

export type AccountingProvider = 'anthropic' | 'openai' | 'google';

export interface ProviderEconomicsInput {
  provider: AccountingProvider;
  model?: string;
  compressed: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
  cacheCreate5mTokens?: number;
  cacheCreate1hTokens?: number;
  baselineTokens?: number;
  baselineCacheableTokens?: number;
  baselineProbeStatus?: 'ok' | 'partial' | 'failed';
  imageTokens?: number;
  baselineImagedTokens?: number;
  nativeInjectedTokens?: number;
  /** Anthropic-only: server-observed warm state and prior prefix size. */
  anthropicWarm?: boolean;
  anthropicPrevCacheable?: number;
  /** Back-compat for old events that predate baseline_probe_status. */
  allowLegacyAnthropicBaseline?: boolean;
}

export interface ProviderEconomics {
  haveUsage: boolean;
  haveBaseline: boolean;
  creditSaving: boolean;
  actualInputEff: number;
  baselineInputEff: number;
  effectiveSavedInput: number;
  outputEquiv: number;
  rawActualInput: number;
  rawBaselineInput: number;
  cacheReadForDisplay: number;
  /** Whether the displayed baseline has an authoritative counterfactual. */
  counterfactualKind: 'none' | 'provider-probe' | 'local-exact' | 'local-estimate';
}

const nonneg = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;

export function computeProviderEconomics(input: ProviderEconomicsInput): ProviderEconomics {
  const inp = nonneg(input.inputTokens);
  const out = nonneg(input.outputTokens);
  const cached = Math.min(inp, nonneg(input.cachedTokens));
  const image = nonneg(input.imageTokens);
  const baselineImaged = nonneg(input.baselineImagedTokens);
  const injected = nonneg(input.nativeInjectedTokens);

  if (input.provider === 'openai') {
    // OpenAI `input_tokens` includes the cached subset. PXPipe measures the
    // replaced text with the same tokenizer used by its gate, so this is a
    // local exact counterfactual for the transformed region rather than a
    // chars/token estimate.
    const haveUsage = inp > 0;
    const haveBaseline = baselineImaged > 0 && image > 0;
    const creditSaving = input.compressed && haveUsage && haveBaseline;
    const actualInputEff = haveUsage
      ? computeOpenAIActualInputEff(inp, cached, input.model)
      : 0;
    const baselineInputEff = creditSaving
      ? computeOpenAIBaselineInputEff(
          inp,
          cached,
          image,
          baselineImaged,
          input.model,
          injected,
        )
      : actualInputEff;
    const rawActualInput = inp;
    const rawBaselineInput = creditSaving
      ? computeOpenAIBaselineRawTokens(inp, image, baselineImaged, injected)
      : inp;
    return {
      haveUsage,
      haveBaseline,
      creditSaving,
      actualInputEff,
      baselineInputEff,
      effectiveSavedInput: baselineInputEff - actualInputEff,
      outputEquiv: haveUsage ? out * openAIOutputRate(input.model) : 0,
      rawActualInput,
      rawBaselineInput,
      cacheReadForDisplay: cached,
      counterfactualKind: haveBaseline ? 'local-exact' : 'none',
    };
  }

  if (input.provider === 'google') {
    const haveUsage = inp > 0 || out > 0;
    const measured = input.baselineProbeStatus === 'ok' ? nonneg(input.baselineTokens) : 0;
    const estimated = input.compressed && image > 0 && baselineImaged > 0
      ? Math.max(0, inp - image - injected + baselineImaged)
      : 0;
    const baseline = measured || estimated;
    const haveBaseline = baseline > 0;
    const creditSaving = input.compressed && haveUsage && haveBaseline;
    const actualInputEff = inp;
    const baselineInputEff = creditSaving ? baseline : inp;
    return {
      haveUsage,
      haveBaseline,
      creditSaving,
      actualInputEff,
      baselineInputEff,
      effectiveSavedInput: baselineInputEff - actualInputEff,
      outputEquiv: out,
      rawActualInput: inp,
      rawBaselineInput: creditSaving ? baseline : inp,
      cacheReadForDisplay: cached,
      counterfactualKind: measured > 0 ? 'provider-probe' : estimated > 0 ? 'local-estimate' : 'none',
    };
  }

  // Anthropic usage splits uncached input, cache-create and cache-read into
  // additive buckets. The original-body /count_tokens probes supply the text
  // counterfactual. Warmth itself comes only from observed cache-read usage;
  // callers may use prior state solely to estimate the reused/grown split.
  const cc = nonneg(input.cacheCreateTokens);
  const cr = nonneg(input.cacheReadTokens);
  const cc5m = nonneg(input.cacheCreate5mTokens);
  const cc1h = nonneg(input.cacheCreate1hTokens);
  const haveUsage = inp > 0 || out > 0 || cc > 0 || cr > 0;
  const baseline = nonneg(input.baselineTokens);
  const cacheable = nonneg(input.baselineCacheableTokens);
  const statusOk = input.baselineProbeStatus === 'ok'
    || (input.baselineProbeStatus === undefined
      && input.allowLegacyAnthropicBaseline === true
      && baseline > 0);
  const haveBaseline = baseline > 0 && statusOk;
  const creditSaving = input.compressed && haveUsage && haveBaseline;
  const actualInputEff = haveUsage
    ? computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m)
    : 0;
  const baselineInputEff = creditSaving
    ? computeBaselineInputEffWithCacheTier(
        baseline,
        cacheable,
        inp,
        cc,
        cr,
        input.anthropicWarm === true,
        nonneg(input.anthropicPrevCacheable),
        cc1h,
        cc5m,
      )
    : actualInputEff;
  return {
    haveUsage,
    haveBaseline,
    creditSaving,
    actualInputEff,
    baselineInputEff,
    effectiveSavedInput: baselineInputEff - actualInputEff,
    outputEquiv: haveUsage ? out * 5 : 0,
    rawActualInput: inp + cc + cr,
    rawBaselineInput: creditSaving ? baseline : inp + cc + cr,
    cacheReadForDisplay: cr,
    counterfactualKind: haveBaseline ? 'provider-probe' : 'none',
  };
}
