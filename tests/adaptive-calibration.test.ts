import { describe, expect, it } from 'vitest';
import { AdaptiveCalibration } from '../src/core/adaptive-calibration.js';
import type { TrackEvent } from '../src/core/tracker.js';

function event(overrides: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-08-11T00:00:00.000Z', method: 'POST', path: '/responses',
    status: 200, duration_ms: 10, model: 'gpt-5.6-sol', accounting_provider: 'openai',
    ...overrides,
  };
}

describe('AdaptiveCalibration', () => {
  it('marks OpenAI/Codex as exact-tokenizer without any startup probe', () => {
    const c = new AdaptiveCalibration();
    c.observe(event({ input_tokens: 1000 }));
    expect(c.snapshots()).toMatchObject([{ mode: 'exact-tokenizer', confidence: 'exact', appliesToRuntime: false }]);
  });

  it('derives shadow margin/floor only from attributable natural traffic', () => {
    const c = new AdaptiveCalibration();
    for (let i = 0; i < 12; i++) {
      c.observe(event({
        baseline_imaged_tokens: 1000 + i * 100,
        image_tokens: 300,
        native_injected_tokens: 50,
        compressed: true,
      }));
    }
    const snap = c.snapshots()[0]!;
    expect(snap.counterfactualObservations).toBe(12);
    expect(snap.observedMedianMarginPct).toBeGreaterThan(0);
    expect(snap.shadowMinBaselineTokens).not.toBeNull();
    expect(snap.appliesToRuntime).toBe(false);
  });

  it('does not fit unrelated full-body baselines as bucket CPT', () => {
    const c = new AdaptiveCalibration();
    for (let i = 0; i < 30; i++) {
      c.observe(event({
        accounting_provider: 'anthropic', model: 'claude-fable-5', path: '/v1/messages',
        baseline_tokens: 20_000, baseline_probe_status: 'ok', bucket_chars: { history: 5000 },
      }));
    }
    const snap = c.snapshots()[0]!;
    expect(snap.mode).toBe('awaiting-attributable-baseline');
    expect(snap.counterfactualObservations).toBe(0);
  });
});
