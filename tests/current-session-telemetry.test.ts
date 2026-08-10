import { describe, expect, it } from 'vitest';
import { DashboardState } from '../src/dashboard.js';
import type { ProxyEvent } from '../src/core/proxy.js';

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('provider-neutral current-session telemetry', () => {
  it('keeps Google/AGY provider and trajectory counters without inventing dollar pricing', async () => {
    const state = new DashboardState();
    const ev: ProxyEvent = {
      method: 'POST',
      path: '/v1internal:streamGenerateContent',
      status: 200,
      durationMs: 100,
      model: 'gemini-3.6-flash-high',
      provider: 'google',
      accountingProvider: 'google',
      info: {
        compressed: true,
        origChars: 12000,
        compressedChars: 12000,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        imageCount: 1,
        imageBytes: 1000,
        imageTokens: 1100,
        baselineImagedTokens: 5000,
        nativeInjectedTokens: 100,
        baselineTokens: 9000,
        baselineProbeStatus: 'estimated',
        firstUserSha8: 'session01',
      },
      usage: { input_tokens: 5200, output_tokens: 300, cached_tokens: 700 },
      trajectory: {
        sessionSha8: 'session01',
        newToolCalls: 4,
        newReadLikeCalls: 2,
        repeatedReadLikeCalls: 1,
        repeatedToolResults: 1,
        compressionExposed: true,
        breakerTriggered: false,
        breakerActive: false,
      },
    };
    state.update(ev);
    const body = await json(state.serveCurrentSessionJson());
    expect(body).toMatchObject({
      sessionId: 'session01',
      requests: 1,
      compressedRequests: 1,
      providerInputTokens: 5200,
      providerOutputTokens: 300,
      providerCacheReadTokens: 700,
      toolCalls: 4,
      readLikeCalls: 2,
      repeatedReadLikeCalls: 1,
      repeatedToolResults: 1,
      breakerActive: false,
    });
    expect(body.rawActualTokens).toBeGreaterThan(0);
    expect(body.rawBaselineTokens).toBeGreaterThan(body.rawActualTokens);
    // Google dollars are intentionally not guessed from Claude pricing.
    expect(body.baselineInputWeighted).toBe(0);
    expect(body.actualInputWeighted).toBe(0);
  });
});
