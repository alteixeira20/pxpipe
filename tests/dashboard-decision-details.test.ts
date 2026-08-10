import { describe, expect, it } from 'vitest';
import { renderContextMapFragment, renderRecentFragment } from '../src/dashboard/fragments.js';
import type { RecentPayload } from '../src/dashboard/types.js';

function payload(reason = 'below_threshold'): RecentPayload {
  return {
    has_preview: false,
    preview_meta: '',
    recent: [{
      ts: 1,
      method: 'POST',
      path: '/v1internal:streamGenerateContent',
      model: 'gemini-3.6-flash-high',
      status: 200,
      compressed: false,
      transformation_state: 'passthrough',
      detail_id: 77,
      decision_reason: reason,
      history_reason: 'no_history',
      image_count: 0,
    }],
  };
}

describe('dashboard decision explainability', () => {
  it('offers Details for a text-only request and explains fresh coding-safe traffic inline', () => {
    const html = renderRecentFragment(payload());
    expect(html).toContain('context-map?req=77');
    expect(html).toContain('not enough old closed history');
  });

  it('renders a no-image detail panel instead of the generic empty prompt', () => {
    const html = renderContextMapFragment({
      id: 77,
      baselineTokens: 0,
      realInput: 18560,
      baselineInputEff: 18560,
      actualInputEff: 18560,
      haveBaseline: false,
      cacheRead: 0,
      warm: false,
      output: 68,
      imageCount: 0,
      buckets: {},
      imageIds: [],
      compressed: false,
      model: 'gemini-3.6-flash-high',
      reason: 'below_threshold',
      historyReason: 'no_history',
    });
    expect(html).toContain('Why no image');
    expect(html).toContain('not enough old closed history');
    expect(html).toContain('nothing imaged this request');
  });
});
