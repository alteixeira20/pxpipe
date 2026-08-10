import { describe, expect, it } from 'vitest';
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
