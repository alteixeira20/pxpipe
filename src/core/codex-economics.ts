import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { computeProviderEconomics } from './economics.js';
import type { TrackEvent } from './tracker.js';

export const CODEX_AB_MIN_PER_ARM = 10;
export const DEFAULT_CODEX_REPORT_BYTES = 16 * 1024 * 1024;

export type CodexEconomicsVerdict =
  | 'insufficient-data'
  | 'regression'
  | 'marginal'
  | 'modest'
  | 'material';

export interface CodexEconomicsCohort {
  requests: number;
  usageRequests: number;
  avgEffectiveInput: number | null;
  p50DurationMs: number | null;
}

export interface CodexEconomicsReport {
  model: string | null;
  requests: number;
  /** Provider-less historical rows admitted only by an explicit model filter. */
  legacyIdentityRequests: number;
  usageRequests: number;
  transformedRequests: number;
  transformsWithoutUsage: number;
  transformsWithoutCounterfactual: number;
  passthroughBaselineRequests: number;
  /** Provider-reported actual input/output usage. */
  providerInputTokens: number;
  providerOutputTokens: number;
  cachedTokens: number;
  cacheSharePct: number;
  /** Reconstructed all-request raw text counterfactual: actual provider input
   * plus the exact text→image/native delta on usage-complete transformed rows. */
  rawBaselineProviderInput: number;
  rawSavedPct: number;
  /** Transform counters below deliberately include only rows with authoritative
   * provider usage so they share the same population as providerInputTokens. */
  baselineImagedTokens: number;
  imageTokens: number;
  nativeInjectedTokens: number;
  grossRawSavedTokens: number;
  netRawSavedTokens: number;
  effectiveActualInput: number;
  effectiveBaselineInput: number;
  effectiveSavedInput: number;
  effectiveSavedPct: number;
  transformedEffectiveSavedInput: number;
  transformedEffectiveSavedPct: number;
  /** Safety/profitability diagnostics can be evaluated without usage and thus
   * cover every transformed request. */
  netNegativeTransforms: number;
  lowMarginTransforms: number;
  safetyFlagged: number;
  /** Backwards-compatible aggregate; prefer streamTerminations for diagnosis. */
  abnormalStreamTerminations: number;
  decisionReasons: Record<string, number>;
  historyReasons: Record<string, number>;
  streamTerminations: Record<string, number>;
  transformed: CodexEconomicsCohort;
  passthrough: CodexEconomicsCohort;
  abReady: boolean;
  abMinPerArm: number;
  observedCohortDeltaPct: number | null;
  verdict: CodexEconomicsVerdict;
  note: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCodexResponseEvent(event: TrackEvent, model?: string): boolean {
  if (model && event.model !== model) return false;
  if (event.method.toUpperCase() !== 'POST') return false;
  const responses = /\/responses$/.test(event.path);
  // New logs are provider-explicit. Once an event has an identity, never fold a
  // generic OpenAI row into Codex merely because it shares the Responses wire.
  if (event.provider) {
    return event.accounting_provider === 'openai'
      && responses
      && (event.provider === 'codex' || event.provider === 'codex-passthrough');
  }
  // Backward-compatible fallback only for old rows written before provider ids
  // were persisted. A model filter is required to avoid swallowing unrelated
  // OpenAI-compatible Responses traffic from the historical log.
  return Boolean(model)
    && event.accounting_provider === 'openai'
    && responses
    && event.model === model;
}

function eventUsage(event: TrackEvent): {
  input: number;
  output: number;
  cached: number;
  haveUsage: boolean;
} {
  const input = isFiniteNumber(event.input_tokens) ? Math.max(0, event.input_tokens) : 0;
  const output = isFiniteNumber(event.output_tokens) ? Math.max(0, event.output_tokens) : 0;
  const cached = isFiniteNumber(event.cached_tokens)
    ? Math.max(0, Math.min(event.cached_tokens, input))
    : 0;
  // This is an input-economics report. Output-only or partial stream telemetry
  // is still reported as output, but cannot ground an input counterfactual or
  // make an A/B row usage-complete.
  return { input, output, cached, haveUsage: input > 0 };
}

function eventEffective(event: TrackEvent): {
  actual: number;
  baseline: number;
  saved: number;
  haveUsage: boolean;
  haveCounterfactual: boolean;
} {
  const { input, output, cached, haveUsage } = eventUsage(event);
  const row = computeProviderEconomics({
    provider: 'openai',
    model: event.model,
    compressed: event.compressed === true,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    imageTokens: isFiniteNumber(event.image_tokens) ? event.image_tokens : 0,
    baselineImagedTokens: isFiniteNumber(event.baseline_imaged_tokens)
      ? event.baseline_imaged_tokens
      : 0,
    nativeInjectedTokens: isFiniteNumber(event.native_injected_tokens)
      ? event.native_injected_tokens
      : 0,
  });
  return {
    actual: row.actualInputEff,
    baseline: row.baselineInputEff,
    saved: row.effectiveSavedInput,
    haveUsage: haveUsage && row.haveUsage,
    haveCounterfactual: row.creditSaving,
  };
}

function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function cohort(events: TrackEvent[]): CodexEconomicsCohort {
  let usageRequests = 0;
  let inputEff = 0;
  const durations: number[] = [];
  for (const event of events) {
    const eff = eventEffective(event);
    if (eff.haveUsage) {
      usageRequests += 1;
      inputEff += eff.actual;
    }
    if (isFiniteNumber(event.duration_ms) && event.duration_ms >= 0) durations.push(event.duration_ms);
  }
  return {
    requests: events.length,
    usageRequests,
    avgEffectiveInput: usageRequests > 0 ? round(inputEff / usageRequests, 1) : null,
    p50DurationMs: p50(durations),
  };
}

export function buildCodexEconomicsReport(
  source: readonly TrackEvent[],
  model?: string,
): CodexEconomicsReport {
  const events = source.filter((event) => isCodexResponseEvent(event, model));
  const legacyIdentityRequests = events.filter((event) => !event.provider).length;
  const transformedEvents = events.filter((event) => event.compressed === true);
  // Only the explicit routed experiment arm is an A/B baseline. A generic
  // `compress=false` Codex row can come from fail-open recovery, a dashboard
  // kill switch, or another operational condition and must not contaminate the
  // comparison cohort.
  const passthroughEvents = events.filter(
    (event) => event.provider === 'codex-passthrough' && event.compressed === false,
  );

  let usageRequests = 0;
  let transformsWithoutUsage = 0;
  let transformsWithoutCounterfactual = 0;
  let providerInputTokens = 0;
  let providerOutputTokens = 0;
  let cachedTokens = 0;
  let baselineImagedTokens = 0;
  let imageTokens = 0;
  let nativeInjectedTokens = 0;
  let effectiveActualInput = 0;
  let effectiveBaselineInput = 0;
  let transformedActual = 0;
  let transformedBaseline = 0;
  let counterfactualUsageRequests = 0;
  let netNegativeTransforms = 0;
  let lowMarginTransforms = 0;
  let safetyFlagged = 0;
  let abnormalStreamTerminations = 0;
  const decisionReasons: Record<string, number> = {};
  const historyReasons: Record<string, number> = {};
  const streamTerminations: Record<string, number> = {};
  const bump = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1;
  };

  for (const event of events) {
    const usage = eventUsage(event);
    const eff = eventEffective(event);
    // Output usage remains provider-reported even when a partial event lacks
    // the input counter needed by every input-economics denominator below.
    providerOutputTokens += usage.output;
    if (usage.haveUsage) {
      usageRequests += 1;
      providerInputTokens += usage.input;
      cachedTokens += usage.cached;
      effectiveActualInput += eff.actual;
      effectiveBaselineInput += eff.baseline;
    }
    if (event.safety_flagged) safetyFlagged += 1;
    bump(decisionReasons, event.compressed === true ? 'transformed' : (event.reason ?? 'native_unspecified'));
    if (event.history_reason) bump(historyReasons, event.history_reason);
    if (event.stream_termination) {
      bump(streamTerminations, event.stream_termination);
      if (event.stream_termination !== 'response_terminal') abnormalStreamTerminations += 1;
    }

    if (event.compressed !== true) continue;
    const baseline = isFiniteNumber(event.baseline_imaged_tokens)
      ? Math.max(0, event.baseline_imaged_tokens)
      : 0;
    const image = isFiniteNumber(event.image_tokens) ? Math.max(0, event.image_tokens) : 0;
    const injected = isFiniteNumber(event.native_injected_tokens)
      ? Math.max(0, event.native_injected_tokens)
      : 0;
    if (eff.haveCounterfactual) {
      const net = baseline - image - injected;
      if (net <= 0) netNegativeTransforms += 1;
      if (net > 0 && net / baseline < 0.05) lowMarginTransforms += 1;
    } else {
      transformsWithoutCounterfactual += 1;
    }

    // A transform delta is known locally even when a stream ended before the
    // terminal usage block, but combining that delta with a provider-input sum
    // that excludes the request would fabricate a percentage. Keep the row in
    // reliability diagnostics while excluding it from provider-grounded totals.
    if (!usage.haveUsage) {
      transformsWithoutUsage += 1;
      continue;
    }
    // Both local sides of the replacement must be present before their delta
    // can be combined with provider input. Treating an absent image estimate as
    // zero would manufacture raw savings from incomplete telemetry.
    if (!eff.haveCounterfactual) continue;
    baselineImagedTokens += baseline;
    imageTokens += image;
    nativeInjectedTokens += injected;
    counterfactualUsageRequests += 1;
    transformedActual += eff.actual;
    transformedBaseline += eff.baseline;
  }

  const grossRawSavedTokens = baselineImagedTokens - imageTokens;
  const netRawSavedTokens = grossRawSavedTokens - nativeInjectedTokens;
  // Unlike the cache-weighted effective view, this raw provider-token view says
  // how much usage-complete provider input the request population shrank on the
  // wire. That distinction is essential for ChatGPT subscriptions: PXPipe can
  // measure both quantities but must not claim which one an opaque subscription
  // quota meter uses.
  const rawBaselineProviderInput = Math.max(0, providerInputTokens + netRawSavedTokens);
  const rawSavedPct = rawBaselineProviderInput > 0
    ? (netRawSavedTokens / rawBaselineProviderInput) * 100
    : 0;
  const effectiveSavedInput = effectiveBaselineInput - effectiveActualInput;
  const effectiveSavedPct = effectiveBaselineInput > 0
    ? (effectiveSavedInput / effectiveBaselineInput) * 100
    : 0;
  const transformedEffectiveSavedInput = transformedBaseline - transformedActual;
  const transformedEffectiveSavedPct = transformedBaseline > 0
    ? (transformedEffectiveSavedInput / transformedBaseline) * 100
    : 0;

  const transformed = cohort(transformedEvents);
  const passthrough = cohort(passthroughEvents);
  const abReady = transformed.usageRequests >= CODEX_AB_MIN_PER_ARM
    && passthrough.usageRequests >= CODEX_AB_MIN_PER_ARM;
  const observedCohortDeltaPct = abReady
    && transformed.avgEffectiveInput !== null
    && passthrough.avgEffectiveInput !== null
    && passthrough.avgEffectiveInput > 0
    ? ((transformed.avgEffectiveInput - passthrough.avgEffectiveInput) / passthrough.avgEffectiveInput) * 100
    : null;

  let verdict: CodexEconomicsVerdict;
  if (
    usageRequests === 0
    || transformed.usageRequests === 0
    || counterfactualUsageRequests === 0
  ) verdict = 'insufficient-data';
  else if (netNegativeTransforms > 0 || effectiveSavedPct < 0) verdict = 'regression';
  else if (effectiveSavedPct < 1) verdict = 'marginal';
  else if (effectiveSavedPct < 5) verdict = 'modest';
  else verdict = 'material';

  const usageCaveat = transformsWithoutUsage > 0
    ? ` ${transformsWithoutUsage} transformed request(s) lacked terminal provider usage and are excluded from token percentages.`
    : '';
  const counterfactualCaveat = transformsWithoutCounterfactual > 0
    ? ` ${transformsWithoutCounterfactual} transformed request(s) had an incomplete transform counterfactual and contribute no claimed savings.`
    : '';
  const legacyIdentityCaveat = legacyIdentityRequests > 0
    ? ` ${legacyIdentityRequests} provider-less legacy request(s) were included by the explicit model/path/accounting heuristic; their Codex route identity is not independently proven.`
    : '';
  const counterfactualAvailable = baselineImagedTokens > 0 && imageTokens > 0;
  const note = !abReady
    ? `${counterfactualAvailable ? 'Token counterfactual is available' : 'No provider-grounded token counterfactual is available yet'}, but a controlled routed A/B needs at least ${CODEX_AB_MIN_PER_ARM} usage-complete transformed and ${CODEX_AB_MIN_PER_ARM} passthrough requests. Run comparable tasks with pxpipe codex and pxpipe codex --passthrough.${usageCaveat}${counterfactualCaveat}${legacyIdentityCaveat}`
    : `A/B cohorts are large enough for a first observed comparison, but the compression gate creates selection bias. Compare similar tasks and use the provider-grounded counterfactual as the primary token-economics measure.${usageCaveat}${counterfactualCaveat}${legacyIdentityCaveat}`;

  const observedModels = new Set(
    events.map((event) => event.model).filter((value): value is string => Boolean(value)),
  );
  const observedModel = observedModels.size === 1 && events.every((event) => event.model)
    ? observedModels.values().next().value ?? null
    : null;

  return {
    model: model ?? observedModel,
    requests: events.length,
    legacyIdentityRequests,
    usageRequests,
    transformedRequests: transformedEvents.length,
    transformsWithoutUsage,
    transformsWithoutCounterfactual,
    passthroughBaselineRequests: passthroughEvents.length,
    providerInputTokens,
    providerOutputTokens,
    cachedTokens,
    cacheSharePct: providerInputTokens > 0 ? round((cachedTokens / providerInputTokens) * 100, 2) : 0,
    rawBaselineProviderInput: round(rawBaselineProviderInput, 1),
    rawSavedPct: round(rawSavedPct, 3),
    baselineImagedTokens,
    imageTokens,
    nativeInjectedTokens,
    grossRawSavedTokens,
    netRawSavedTokens,
    effectiveActualInput: round(effectiveActualInput, 1),
    effectiveBaselineInput: round(effectiveBaselineInput, 1),
    effectiveSavedInput: round(effectiveSavedInput, 1),
    effectiveSavedPct: round(effectiveSavedPct, 3),
    transformedEffectiveSavedInput: round(transformedEffectiveSavedInput, 1),
    transformedEffectiveSavedPct: round(transformedEffectiveSavedPct, 3),
    netNegativeTransforms,
    lowMarginTransforms,
    safetyFlagged,
    abnormalStreamTerminations,
    decisionReasons,
    historyReasons,
    streamTerminations,
    transformed,
    passthrough,
    abReady,
    abMinPerArm: CODEX_AB_MIN_PER_ARM,
    observedCohortDeltaPct: observedCohortDeltaPct === null ? null : round(observedCohortDeltaPct, 2),
    verdict,
    note,
  };
}

/** Read only the tail of the append-only JSONL so a report stays bounded even
 * after months of daemon use. The first partial line is discarded when the
 * read starts mid-file. Malformed rows are skipped rather than making the
 * diagnostic unavailable. */
export function loadRecentTrackEvents(
  filePath: string,
  maxBytes = DEFAULT_CODEX_REPORT_BYTES,
): TrackEvent[] {
  const size = statSync(filePath).size;
  if (size <= 0) return [];
  const wanted = Math.max(1, Math.min(size, Math.floor(maxBytes)));
  const start = Math.max(0, size - wanted);
  const fd = openSync(filePath, 'r');
  try {
    let startsAtLineBoundary = start === 0;
    if (start > 0) {
      const preceding = Buffer.allocUnsafe(1);
      startsAtLineBoundary = readSync(fd, preceding, 0, 1, start - 1) === 1
        && preceding[0] === 0x0a;
    }
    const buf = Buffer.allocUnsafe(wanted);
    let offset = 0;
    while (offset < wanted) {
      const n = readSync(fd, buf, offset, wanted - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString('utf8');
    if (!startsAtLineBoundary) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const out: TrackEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TrackEvent);
      } catch {
        // A concurrently appended trailing row can be partial. Ignore it.
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}
