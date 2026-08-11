/**
 * Conservative chars-per-token calibration from existing PXPipe telemetry.
 *
 * This is pure math: no fs/process/network. Runtime users may feed it shadow
 * samples collected from normal traffic; it never performs a model call.
 */
import type { BucketName } from './transform.js';

export const CPT_BUCKETS: readonly BucketName[] = [
  'static_slab',
  'reminder',
  'tool_result_json',
  'tool_result_log',
  'tool_result_prose',
  'history',
];

export const MIN_CPT_SAMPLES = 20;
export const MIN_CPT_BUCKET_PRESENCE = 8;
export const CPT_PLAUSIBLE_MIN = 0.8;
export const CPT_PLAUSIBLE_MAX = 6.0;
export const MAX_CPT_CONDITION = 1e8;

export interface CptSample {
  bucketChars: Partial<Record<BucketName, number>>;
  /** Target text-token count attributable to the bucket mixture. */
  textTokens: number;
}

export interface CptFitResult {
  cpt: Partial<Record<BucketName, number>>;
  nSamples: number;
  rejected: Partial<Record<BucketName, string>>;
  conditionEstimate: number;
  active: BucketName[];
}

function rejectAll(reason: string): Partial<Record<BucketName, string>> {
  const rejected: Partial<Record<BucketName, string>> = {};
  for (const bucket of CPT_BUCKETS) rejected[bucket] = reason;
  return rejected;
}

function invertMatrix(src: readonly number[][]): { inv: number[][]; condition: number } | null {
  const n = src.length;
  if (n === 0) return null;
  const a: number[][] = src.map((row, i) => {
    const out = new Array<number>(2 * n).fill(0);
    for (let j = 0; j < n; j++) out[j] = row[j] ?? 0;
    out[n + i] = 1;
    return out;
  });

  let minPivot = Infinity;
  let maxPivot = 0;
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[best]![col]!)) best = row;
    }
    const pivot = Math.abs(a[best]![col]!);
    if (!Number.isFinite(pivot) || pivot <= Number.EPSILON) return null;
    minPivot = Math.min(minPivot, pivot);
    maxPivot = Math.max(maxPivot, pivot);
    if (best !== col) [a[col], a[best]] = [a[best]!, a[col]!];

    const d = a[col]![col]!;
    for (let j = 0; j < 2 * n; j++) a[col]![j] = a[col]![j]! / d;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        a[row]![j] = a[row]![j]! - factor * a[col]![j]!;
      }
    }
  }
  return {
    inv: a.map((row) => row.slice(n)),
    condition: minPivot > 0 ? maxPivot / minPivot : Infinity,
  };
}

export function fitCpt(samples: readonly CptSample[]): CptFitResult {
  const finiteSamples = samples.filter((sample) =>
    Number.isFinite(sample.textTokens) && sample.textTokens > 0,
  );
  const n = finiteSamples.length;
  if (n < MIN_CPT_SAMPLES) {
    return {
      cpt: {},
      nSamples: n,
      rejected: rejectAll(`n=${n} < ${MIN_CPT_SAMPLES}`),
      conditionEstimate: Infinity,
      active: [],
    };
  }

  const active: BucketName[] = [];
  const rejected: Partial<Record<BucketName, string>> = {};
  for (const bucket of CPT_BUCKETS) {
    let present = 0;
    for (const sample of finiteSamples) if ((sample.bucketChars[bucket] ?? 0) > 0) present++;
    if (present < MIN_CPT_BUCKET_PRESENCE) {
      rejected[bucket] = `present=${present} < ${MIN_CPT_BUCKET_PRESENCE}`;
    } else {
      active.push(bucket);
    }
  }
  if (active.length === 0) {
    return { cpt: {}, nSamples: n, rejected, conditionEstimate: Infinity, active };
  }

  const k = active.length;
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (const sample of finiteSamples) {
    const row = active.map((bucket) => Math.max(0, sample.bucketChars[bucket] ?? 0));
    for (let i = 0; i < k; i++) {
      xty[i] = xty[i]! + row[i]! * sample.textTokens;
      for (let j = 0; j < k; j++) xtx[i]![j] = xtx[i]![j]! + row[i]! * row[j]!;
    }
  }

  const inverted = invertMatrix(xtx);
  if (!inverted) {
    for (const bucket of active) rejected[bucket] = 'singular';
    return { cpt: {}, nSamples: n, rejected, conditionEstimate: Infinity, active };
  }
  if (!Number.isFinite(inverted.condition) || inverted.condition > MAX_CPT_CONDITION) {
    for (const bucket of active) rejected[bucket] = `ill-conditioned=${inverted.condition}`;
    return { cpt: {}, nSamples: n, rejected, conditionEstimate: inverted.condition, active };
  }

  const cpt: Partial<Record<BucketName, number>> = {};
  for (let i = 0; i < k; i++) {
    let alpha = 0;
    for (let j = 0; j < k; j++) alpha += inverted.inv[i]![j]! * xty[j]!;
    const bucket = active[i]!;
    if (!(alpha > 0) || !Number.isFinite(alpha)) {
      rejected[bucket] = 'non-positive slope';
      continue;
    }
    const value = 1 / alpha;
    if (value < CPT_PLAUSIBLE_MIN || value > CPT_PLAUSIBLE_MAX) {
      rejected[bucket] = `cpt=${value.toFixed(3)} outside [${CPT_PLAUSIBLE_MIN},${CPT_PLAUSIBLE_MAX}]`;
      continue;
    }
    cpt[bucket] = value;
  }

  return { cpt, nSamples: n, rejected, conditionEstimate: inverted.condition, active };
}
