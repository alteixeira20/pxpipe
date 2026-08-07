import { describe, expect, it } from 'vitest';
import { toTrackEvent } from '../src/core/tracker.js';

describe('trajectory tracker mapping', () => {
  it('persists only counters and a session digest', () => {
    const event = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 10,
      trajectory: {
        sessionSha8: 'deadbeef',
        newToolCalls: 2,
        newReadLikeCalls: 1,
        repeatedReadLikeCalls: 1,
        repeatedToolResults: 1,
        compressionExposed: true,
        breakerTriggered: true,
        breakerActive: true,
      },
    });
    expect(event).toMatchObject({
      trajectory_session_sha8: 'deadbeef',
      trajectory_new_tool_calls: 2,
      trajectory_new_read_like_calls: 1,
      trajectory_repeated_read_like_calls: 1,
      trajectory_repeated_tool_results: 1,
      trajectory_compression_exposed: true,
      trajectory_breaker_triggered: true,
      trajectory_breaker_active: true,
    });
    expect(JSON.stringify(event)).not.toContain('file_path');
    expect(JSON.stringify(event)).not.toContain('tool_use_id');
  });
});
