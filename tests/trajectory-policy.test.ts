import { describe, expect, it } from 'vitest';
import { applyTrajectoryCircuitBreaker } from '../src/core/trajectory-policy.js';
import type { TrajectoryObservation } from '../src/core/trajectory.js';

function observation(active: boolean): TrajectoryObservation {
  return {
    sessionSha8: '01234567',
    newToolCalls: 0,
    newReadLikeCalls: 0,
    repeatedReadLikeCalls: 0,
    repeatedToolResults: 0,
    compressionExposed: true,
    breakerTriggered: active,
    breakerActive: active,
  };
}

describe('trajectory circuit breaker policy', () => {
  it('leaves transform options unchanged before the breaker opens', () => {
    const options = { compress: true, compressToolResults: true, collapseHistory: true };
    expect(applyTrajectoryCircuitBreaker(options, observation(false))).toEqual(options);
  });

  it('forces a full modality pass-through after the breaker opens', () => {
    expect(applyTrajectoryCircuitBreaker({
      compress: true,
      compressTools: true,
      compressToolResults: true,
      collapseHistory: true,
      charsPerToken: 1,
    }, observation(true))).toMatchObject({
      compress: false,
      compressTools: false,
      compressToolResults: false,
      collapseHistory: false,
      charsPerToken: 1,
    });
  });
});
