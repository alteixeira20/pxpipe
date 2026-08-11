import { describe, expect, it } from 'vitest';
import { CPT_BUCKETS, MIN_CPT_SAMPLES, fitCpt, type CptSample } from '../src/core/cpt-fit.js';
import type { BucketName } from '../src/core/transform.js';

function sample(chars: Partial<Record<BucketName, number>>, cpt: Partial<Record<BucketName, number>>): CptSample {
  let textTokens = 0;
  for (const bucket of CPT_BUCKETS) {
    const n = chars[bucket] ?? 0;
    const rate = cpt[bucket];
    if (n > 0 && rate) textTokens += n / rate;
  }
  return { bucketChars: chars, textTokens };
}

describe('fitCpt', () => {
  it('fails closed below the sample floor', () => {
    const fit = fitCpt(Array.from({ length: MIN_CPT_SAMPLES - 1 }, () => ({
      bucketChars: { history: 1000 }, textTokens: 500,
    })));
    expect(fit.cpt).toEqual({});
    expect(fit.rejected.history).toContain('n=');
  });

  it('recovers independent bucket densities', () => {
    const truth = { history: 2.2, tool_result_json: 1.6, tool_result_prose: 3.1 } as const;
    const rows: CptSample[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(sample({
        history: 900 + i * 73,
        tool_result_json: 300 + ((i * 97) % 1300),
        tool_result_prose: 200 + ((i * 157) % 900),
      }, truth));
    }
    const fit = fitCpt(rows);
    expect(fit.cpt.history).toBeCloseTo(truth.history, 3);
    expect(fit.cpt.tool_result_json).toBeCloseTo(truth.tool_result_json, 3);
    expect(fit.cpt.tool_result_prose).toBeCloseTo(truth.tool_result_prose, 3);
  });

  it('rejects collinear bucket mixtures instead of emitting a confident rate', () => {
    const rows: CptSample[] = [];
    for (let i = 0; i < 30; i++) {
      const n = 1000 + i * 10;
      rows.push({ bucketChars: { history: n, tool_result_prose: n * 2 }, textTokens: n });
    }
    const fit = fitCpt(rows);
    expect(Object.keys(fit.cpt)).toHaveLength(0);
  });
});
