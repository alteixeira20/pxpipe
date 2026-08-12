import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCodexCacheState,
  getCodexCacheHint,
  noteCodexCacheOutcome,
} from '../src/core/codex-cache-state.js';

beforeEach(() => clearCodexCacheState());

describe('Codex cache observation state', () => {
  it('records only authoritative input usage and clamps cached tokens', () => {
    noteCodexCacheOutcome('s', { inputTokens: 0, cachedTokens: 10, compressed: false });
    expect(getCodexCacheHint('s')).toBeUndefined();

    noteCodexCacheOutcome('s', {
      inputTokens: 1000,
      cachedTokens: 1500,
      compressed: true,
      historySegmentShas: ['a', 'b'],
    }, 123);
    expect(getCodexCacheHint('s')).toEqual({
      inputTokens: 1000,
      cachedTokens: 1000,
      cacheShare: 1,
      compressed: true,
      historySegmentShas: ['a', 'b'],
      lastSeenMs: 123,
    });
  });

  it('does not retain page hashes for a native request', () => {
    noteCodexCacheOutcome('s', {
      inputTokens: 1000,
      cachedTokens: 900,
      compressed: false,
      historySegmentShas: ['must-not-survive'],
    });
    expect(getCodexCacheHint('s')?.historySegmentShas).toEqual([]);
  });
});
