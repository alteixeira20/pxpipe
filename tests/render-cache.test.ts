import { beforeEach, describe, expect, it } from 'vitest';
import { clearRenderCache, renderCacheStats, renderTextToPngsWithCharLimit } from '../src/core/render.js';

beforeEach(() => clearRenderCache());

describe('render cache', () => {
  it('reuses an identical render without exposing mutable dropped-codepoint maps', async () => {
    const first = await renderTextToPngsWithCharLimit('hello world'.repeat(50), 80, 5000);
    const afterFirst = renderCacheStats();
    const second = await renderTextToPngsWithCharLimit('hello world'.repeat(50), 80, 5000);
    const afterSecond = renderCacheStats();
    expect(afterFirst.misses).toBe(1);
    expect(afterSecond.hits).toBe(1);
    expect(second.map((x) => [...x.png])).toEqual(first.map((x) => [...x.png]));
    expect(second[0]!.droppedCodepoints).not.toBe(first[0]!.droppedCodepoints);
  });

  it('keys geometry/style changes separately', async () => {
    await renderTextToPngsWithCharLimit('same text', 80, 5000);
    await renderTextToPngsWithCharLimit('same text', 81, 5000);
    expect(renderCacheStats().misses).toBe(2);
  });
});
