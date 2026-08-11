/**
 * Passive, model-specific profitability calibration.
 *
 * This module NEVER calls a model and NEVER mutates semantic safety policy.
 * It consumes telemetry PXPipe already produced and exposes shadow-only
 * recommendations. A future release may promote a recommendation into the
 * economic gate only after controlled A/B evidence proves it improves outcomes.
 */
import { fitCpt, type CptFitResult, type CptSample } from './cpt-fit.js';
import type { TrackEvent } from './tracker.js';

export type CalibrationMode =
  | 'exact-tokenizer'
  | 'provider-probe'
  | 'learned-cpt-shadow'
  | 'awaiting-attributable-baseline';

export interface CalibrationSnapshot {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  mode: CalibrationMode;
  observations: number;
  counterfactualObservations: number;
  profitableObservations: number;
  /** Median observed raw saving on rows with an attributable transform delta. */
  observedMedianMarginPct: number | null;
  /** Conservative 10th-percentile margin; useful as a reserve diagnostic. */
  observedP10MarginPct: number | null;
  /** Shadow-only floor inferred from naturally profitable rows. Never applied. */
  shadowMinBaselineTokens: number | null;
  cpt: CptFitResult['cpt'];
  cptRejected: CptFitResult['rejected'];
  conditionEstimate: number | null;
  confidence: 'exact' | 'insufficient' | 'measured';
  appliesToRuntime: false;
  note: string;
}

interface CalibrationState {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  observations: number;
  counterfactualObservations: number;
  margins: number[];
  profitableBaselines: number[];
  cptSamples: CptSample[];
  sawProviderProbe: boolean;
}

const MAX_MODEL_SAMPLES = 512;
const MIN_THRESHOLD_SAMPLES = 8;

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function providerOf(event: TrackEvent): 'anthropic' | 'openai' | 'google' {
  if (event.accounting_provider) return event.accounting_provider;
  if (event.path.includes('responses') || event.path.includes('chat/completions')) return 'openai';
  if (event.path.includes('google-ai-studio') || event.path.includes('generateContent')) return 'google';
  return 'anthropic';
}

export class AdaptiveCalibration {
  private readonly states = new Map<string, CalibrationState>();

  observe(event: TrackEvent): void {
    if (!event.model) return;
    const provider = providerOf(event);
    const key = `${provider}\0${event.model}`;
    let state = this.states.get(key);
    if (!state) {
      state = {
        provider,
        model: event.model,
        observations: 0,
        counterfactualObservations: 0,
        margins: [],
        profitableBaselines: [],
        cptSamples: [],
        sawProviderProbe: false,
      };
      this.states.set(key, state);
    }
    state.observations += 1;
    if (event.baseline_probe_status === 'ok' && finitePositive(event.baseline_tokens) > 0) {
      state.sawProviderProbe = true;
    }

    const baseline = finitePositive(event.baseline_imaged_tokens);
    const image = finitePositive(event.image_tokens);
    const injected = finitePositive(event.native_injected_tokens);
    if (baseline > 0 && image > 0) {
      state.counterfactualObservations += 1;
      const margin = (baseline - image - injected) / baseline;
      if (Number.isFinite(margin)) {
        state.margins.push(margin);
        if (margin > 0) state.profitableBaselines.push(baseline);
      }
      const bucketChars = event.bucket_chars;
      if (bucketChars && Object.values(bucketChars).some((n) => (n ?? 0) > 0)) {
        state.cptSamples.push({ bucketChars: { ...bucketChars }, textTokens: baseline });
      }
    }

    if (state.margins.length > MAX_MODEL_SAMPLES) state.margins.shift();
    if (state.profitableBaselines.length > MAX_MODEL_SAMPLES) state.profitableBaselines.shift();
    if (state.cptSamples.length > MAX_MODEL_SAMPLES) state.cptSamples.shift();
  }

  snapshots(): CalibrationSnapshot[] {
    return [...this.states.values()]
      .map((state) => this.snapshot(state))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  }

  private snapshot(state: CalibrationState): CalibrationSnapshot {
    const fit = fitCpt(state.cptSamples);
    const marginPct = state.margins.map((value) => value * 100);
    const profitableFloor = state.profitableBaselines.length >= MIN_THRESHOLD_SAMPLES
      ? percentile(state.profitableBaselines, 0.25)
      : null;

    let mode: CalibrationMode;
    let confidence: CalibrationSnapshot['confidence'];
    let note: string;
    if (state.provider === 'openai') {
      mode = 'exact-tokenizer';
      confidence = 'exact';
      note = 'Text and image economics use the model profile/tokenizer directly; no learned CPT is needed. Shadow observations only validate the gate margin.';
    } else if (state.provider === 'google' && state.sawProviderProbe) {
      mode = 'provider-probe';
      confidence = state.counterfactualObservations > 0 ? 'measured' : 'insufficient';
      note = 'Provider countTokens observations are preferred. Learned values remain diagnostic and never override coding-safe policy.';
    } else if (Object.keys(fit.cpt).length > 0) {
      mode = 'learned-cpt-shadow';
      confidence = 'measured';
      note = 'CPT fit passed conservative guards, but remains shadow-only until controlled A/B evidence proves it beats the fixed gate.';
    } else {
      mode = 'awaiting-attributable-baseline';
      confidence = 'insufficient';
      note = 'Not enough attributable natural-traffic evidence yet; PXPipe keeps the conservative fixed economic gate.';
    }

    return {
      provider: state.provider,
      model: state.model,
      mode,
      observations: state.observations,
      counterfactualObservations: state.counterfactualObservations,
      profitableObservations: state.profitableBaselines.length,
      observedMedianMarginPct: round(percentile(marginPct, 0.5)),
      observedP10MarginPct: round(percentile(marginPct, 0.1)),
      shadowMinBaselineTokens: round(profitableFloor, 0),
      cpt: fit.cpt,
      cptRejected: fit.rejected,
      conditionEstimate: Number.isFinite(fit.conditionEstimate) ? round(fit.conditionEstimate) : null,
      confidence,
      appliesToRuntime: false,
      note,
    };
  }
}
