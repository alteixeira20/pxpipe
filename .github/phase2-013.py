from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected snippet not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Require a meaningful safety margin when Antigravity has no public countTokens
# endpoint to validate the local Gemini text-token counterfactual.
replace(
    'src/core/transform.ts',
    """  googleHistory?: {\n    keepTail?: number;\n    minCollapseUnits?: number;\n    minCollapseTokens?: number;\n  };\n""",
    """  googleHistory?: {\n    keepTail?: number;\n    minCollapseUnits?: number;\n    minCollapseTokens?: number;\n  };\n  /** Maximum image-side/text-side token ratio accepted by the local Google\n   * profitability gate. Values below 1 require headroom for tokenizer/model\n   * estimation error; public Google still gets its provider countTokens check. */\n  googleMaxImageToTextRatio?: number;\n""",
)
replace(
    'src/core/transform.ts',
    """  googleHistory: {},\n  model: '',\n""",
    """  googleHistory: {},\n  googleMaxImageToTextRatio: 1,\n  model: '',\n""",
)
replace(
    'src/core/safety-policy.ts',
    """      googleHistory: {\n        keepTail: 8,\n        minCollapseUnits: 4,\n        minCollapseTokens: 2_000,\n      },\n      keepSharp: shouldKeepToolResultSharp,\n""",
    """      googleHistory: {\n        keepTail: 8,\n        minCollapseUnits: 4,\n        minCollapseTokens: 2_000,\n      },\n      // Antigravity has no grounded public countTokens endpoint. Demand at\n      // least 20% local headroom before changing modality in the safest mode.\n      googleMaxImageToTextRatio: 0.80,\n      keepSharp: shouldKeepToolResultSharp,\n""",
)
replace(
    'src/core/safety-policy.ts',
    """      googleHistory: {\n        keepTail: 6,\n        minCollapseUnits: 2,\n        minCollapseTokens: 1_500,\n      },\n      keepSharp: shouldKeepToolResultSharp,\n""",
    """      googleHistory: {\n        keepTail: 6,\n        minCollapseUnits: 2,\n        minCollapseTokens: 1_500,\n      },\n      googleMaxImageToTextRatio: 0.90,\n      keepSharp: shouldKeepToolResultSharp,\n""",
)
replace(
    'src/core/safety-policy.ts',
    """      googleHistory: {\n        keepTail: 4,\n        minCollapseUnits: 1,\n        minCollapseTokens: 1_000,\n      },\n      reflow: true,\n""",
    """      googleHistory: {\n        keepTail: 4,\n        minCollapseUnits: 1,\n        minCollapseTokens: 1_000,\n      },\n      googleMaxImageToTextRatio: 1,\n      reflow: true,\n""",
)

replace(
    'src/core/google.ts',
    """      if (imageTokens + pointerTokens >= textTokens) {\n""",
    """      const maxRatio = Math.min(1, Math.max(0.05, options.googleMaxImageToTextRatio ?? 1));\n      if (imageTokens + pointerTokens >= textTokens * maxRatio) {\n""",
)
replace(
    'src/core/google.ts',
    """async function planGoogleHistory(\n  contents: GoogleContent[],\n  modelName: string,\n  reflowEnabled: boolean,\n  tuning: NonNullable<TransformOptions['googleHistory']> = {},\n): Promise<GoogleHistoryPlan | null> {\n""",
    """async function planGoogleHistory(\n  contents: GoogleContent[],\n  modelName: string,\n  reflowEnabled: boolean,\n  tuning: NonNullable<TransformOptions['googleHistory']> = {},\n  maxImageToTextRatio = 1,\n): Promise<GoogleHistoryPlan | null> {\n""",
)
replace(
    'src/core/google.ts',
    """  if (imageTokens + nativeTokens >= baselineTokens) return null;\n""",
    """  const maxRatio = Math.min(1, Math.max(0.05, maxImageToTextRatio));\n  if (imageTokens + nativeTokens >= baselineTokens * maxRatio) return null;\n""",
)
replace(
    'src/core/google.ts',
    """        options.reflow !== false,\n        options.googleHistory,\n      );\n""",
    """        options.reflow !== false,\n        options.googleHistory,\n        options.googleMaxImageToTextRatio ?? 1,\n      );\n""",
)
replace(
    'src/core/google.ts',
    """      profitable: imageTokens + nativeInjectedTokens < textTokens,\n""",
    """      profitable: imageTokens + nativeInjectedTokens < textTokens * Math.min(\n        1,\n        Math.max(0.05, options.googleMaxImageToTextRatio ?? 1),\n      ),\n""",
)

# Provider-neutral task telemetry in the current-session JSON. Dollar pricing can
# stay unavailable for Google while actual provider token/trajectory counts remain
# measurable and useful for A/B testing.
replace(
    'src/dashboard.ts',
    """  rawOutputTokens: number;\n}\n""",
    """  rawOutputTokens: number;\n  requests: number;\n  compressedRequests: number;\n  providerInputTokens: number;\n  providerOutputTokens: number;\n  providerCacheReadTokens: number;\n  providerCacheCreateTokens: number;\n  toolCalls: number;\n  readLikeCalls: number;\n  repeatedReadLikeCalls: number;\n  repeatedToolResults: number;\n  breakerActive: boolean;\n}\n""",
)
replace(
    'src/dashboard.ts',
    """          rawActualTokens: 0,\n          rawBaselineTokens: 0,\n          rawOutputTokens: 0,\n        };\n""",
    """          rawActualTokens: 0,\n          rawBaselineTokens: 0,\n          rawOutputTokens: 0,\n          requests: 0,\n          compressedRequests: 0,\n          providerInputTokens: 0,\n          providerOutputTokens: 0,\n          providerCacheReadTokens: 0,\n          providerCacheCreateTokens: 0,\n          toolCalls: 0,\n          readLikeCalls: 0,\n          repeatedReadLikeCalls: 0,\n          repeatedToolResults: 0,\n          breakerActive: false,\n        };\n""",
)
replace(
    'src/dashboard.ts',
    """      // Reuse the same haveUsage / haveBaseline guards + the\n      // baselineInputEff / actualInputEff locals computed earlier in\n""",
    """      s.requests += 1;\n      if (compressed) s.compressedRequests += 1;\n      if (haveUsage) {\n        s.providerInputTokens += inp;\n        s.providerOutputTokens += out;\n        s.providerCacheReadTokens += cacheReadForRow;\n        s.providerCacheCreateTokens += cc;\n      }\n      if (ev.trajectory) {\n        s.toolCalls += ev.trajectory.newToolCalls;\n        s.readLikeCalls += ev.trajectory.newReadLikeCalls;\n        s.repeatedReadLikeCalls += ev.trajectory.repeatedReadLikeCalls;\n        s.repeatedToolResults += ev.trajectory.repeatedToolResults;\n        s.breakerActive ||= ev.trajectory.breakerActive;\n      }\n      // Reuse the same haveUsage / haveBaseline guards + the\n      // baselineInputEff / actualInputEff locals computed earlier in\n""",
)
replace(
    'src/dashboard.ts',
    """      if (creditSaving && dollarEligible) {\n        s.baselineInputWeighted += baselineInputEff;\n        s.actualInputWeighted += actualInputEff;\n        s.baselineMeasuredCount += 1;\n        // RAW, rate-free compression: real tokens sent vs the same body as text.\n        s.rawActualTokens += rawActual;\n        s.rawBaselineTokens += rawBaseline;\n        s.rawOutputTokens += out; // not compressed; added to BOTH sides for the honest total\n      }\n""",
    """      if (creditSaving) {\n        // RAW, rate-free compression is provider-neutral. Keep it even when\n        // dollar pricing is intentionally unavailable (notably Google/AGY).\n        s.rawActualTokens += rawActual;\n        s.rawBaselineTokens += rawBaseline;\n        s.rawOutputTokens += out;\n        if (dollarEligible) {\n          s.baselineInputWeighted += baselineInputEff;\n          s.actualInputWeighted += actualInputEff;\n          s.baselineMeasuredCount += 1;\n        }\n      }\n""",
)
replace(
    'src/dashboard.ts',
    """      rawActualTokens: s.rawActualTokens,\n      rawBaselineTokens: s.rawBaselineTokens,\n      rawOutputTokens: s.rawOutputTokens,\n    });\n""",
    """      rawActualTokens: s.rawActualTokens,\n      rawBaselineTokens: s.rawBaselineTokens,\n      rawOutputTokens: s.rawOutputTokens,\n      requests: s.requests,\n      compressedRequests: s.compressedRequests,\n      providerInputTokens: s.providerInputTokens,\n      providerOutputTokens: s.providerOutputTokens,\n      providerCacheReadTokens: s.providerCacheReadTokens,\n      providerCacheCreateTokens: s.providerCacheCreateTokens,\n      toolCalls: s.toolCalls,\n      readLikeCalls: s.readLikeCalls,\n      repeatedReadLikeCalls: s.repeatedReadLikeCalls,\n      repeatedToolResults: s.repeatedToolResults,\n      breakerActive: s.breakerActive,\n    });\n""",
)

replace(
    'src/dashboard/types.ts',
    """  /** Raw output tokens — shown as an \"untouched\" note; output is never compressed. */\n  rawOutputTokens?: number;\n}\n""",
    """  /** Raw output tokens — shown as an \"untouched\" note; output is never compressed. */\n  rawOutputTokens?: number;\n  /** Provider-neutral task telemetry for controlled passthrough vs coding-safe A/B runs. */\n  requests?: number;\n  compressedRequests?: number;\n  providerInputTokens?: number;\n  providerOutputTokens?: number;\n  providerCacheReadTokens?: number;\n  providerCacheCreateTokens?: number;\n  toolCalls?: number;\n  readLikeCalls?: number;\n  repeatedReadLikeCalls?: number;\n  repeatedToolResults?: number;\n  breakerActive?: boolean;\n}\n""",
)

# Correct a stale UI comment left from the pre-Gemini safe-scope milestone.
replace(
    'src/dashboard/fragments.ts',
    """  /* collapsed model-scope section (#116): the default compress scope is Fable 5\n     only, so the three family rows stay hidden until the user opts in. The\n""",
    """  /* collapsed model-scope section (#116): validated safe families are active\n     by default while experimental families remain opt-in. The\n""",
)

# Document the local-gate safety margin and provider-neutral task counters.
release = Path('docs/RELEASE_0_13.md')
text = release.read_text()
text = text.replace(
    'but only when the provider-specific image-cost gate predicts a win.',
    'but only when the provider-specific image-cost gate predicts at least 20% local headroom. Public Google requests still get provider countTokens validation; Antigravity uses this conservative margin because no grounded public countTokens endpoint is available.',
)
text += """\n## Task-level A/B telemetry\n\n`/api/current-session.json` now exposes provider-reported input/output/cache token totals plus tool calls, read/search calls, repeated reads, repeated tool results and circuit-breaker state. These counters are provider-neutral and remain available for Google/AGY even when dollar pricing is intentionally unknown. Use them to compare completed tasks, not isolated request shrinkage.\n"""
release.write_text(text)

# Regression tests for the safety margin and provider-neutral current-session contract.
Path('tests/google-profit-margin.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { mergeCompressionProfileOptions, resolveCompressionProfile } from '../src/core/safety-policy.js';

const enc = new TextEncoder();

function request() {
  return {
    contents: Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn-${i} ` + 'history '.repeat(1400) }],
    })),
  };
}

describe('Google local profitability safety margin', () => {
  it('coding-safe exposes a stricter image/text ratio than aggressive', () => {
    const safe = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const aggressive = mergeCompressionProfileOptions(resolveCompressionProfile('aggressive'));
    expect(safe.googleMaxImageToTextRatio).toBe(0.8);
    expect(aggressive.googleMaxImageToTextRatio).toBe(1);
  });

  it('can fail closed when an operator demands impossible local headroom', async () => {
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(request())),
      'gemini-3.6-flash-high',
      {
        ...mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe')),
        googleMaxImageToTextRatio: 0.05,
      },
    );
    expect(out.info.compressed).toBe(false);
    expect(out.info.historyReason).toBe('not_profitable');
  });
});
''')

Path('tests/current-session-telemetry.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
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
''')

print('phase 2 0.13 hardening materialized')
