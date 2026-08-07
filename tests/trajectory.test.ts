import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTrajectoryState,
  noteTrajectoryCompression,
  observeAnthropicTrajectory,
  trajectoryLimits,
} from '../src/core/trajectory.js';

const enc = new TextEncoder();

function request(toolCalls: Array<{ id: string; name: string; input: unknown; result?: string }>): Uint8Array {
  const messages: unknown[] = [
    { role: 'user', content: 'Fix the repository regression.' },
  ];
  for (const call of toolCalls) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }],
    });
    if (call.result !== undefined) {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call.id, content: call.result }],
      });
    }
  }
  return enc.encode(JSON.stringify({ model: 'claude-fable-5', messages }));
}

beforeEach(() => clearTrajectoryState());

describe('trajectory guard', () => {
  it('counts only newly observed tool ids when history is resent', async () => {
    const body = request([
      { id: 'a', name: 'Read', input: { file_path: '/repo/src/a.ts' }, result: 'alpha' },
    ]);
    const first = await observeAnthropicTrajectory(body);
    const second = await observeAnthropicTrajectory(body);
    expect(first?.newToolCalls).toBe(1);
    expect(first?.newReadLikeCalls).toBe(1);
    expect(second?.newToolCalls).toBe(0);
    expect(second?.newReadLikeCalls).toBe(0);
  });

  it('does not arm the breaker until a rendered request exposed the session to compression', async () => {
    const first = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    ]));
    expect(first?.breakerActive).toBe(false);

    for (let index = 0; index < trajectoryLimits.repeatBreakerThreshold + 2; index += 1) {
      const observed = await observeAnthropicTrajectory(request([
        { id: 'a', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
        { id: `repeat-${index}`, name: 'Read', input: { file_path: '/repo/src/a.ts' } },
      ]));
      expect(observed?.breakerActive).toBe(false);
    }
  });

  it('opens a sticky pass-through breaker after repeated exact reads following compression', async () => {
    const initial = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Read', input: { file_path: '/repo/src/a.ts' }, result: 'same file' },
    ]));
    expect(initial).toBeDefined();
    noteTrajectoryCompression(initial!.sessionSha8, true);

    let latest = initial;
    for (let index = 0; index < trajectoryLimits.repeatBreakerThreshold; index += 1) {
      latest = await observeAnthropicTrajectory(request([
        { id: 'a', name: 'Read', input: { file_path: '/repo/src/a.ts' }, result: 'same file' },
        ...Array.from({ length: index + 1 }, (_, offset) => ({
          id: `repeat-${offset}`,
          name: 'Read',
          input: { file_path: '/repo/src/a.ts' },
          result: 'same file',
        })),
      ]));
    }

    expect(latest?.breakerTriggered).toBe(true);
    expect(latest?.breakerActive).toBe(true);
    const next = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    ]));
    expect(next?.breakerActive).toBe(true);
  });

  it('treats canonical-equivalent tool inputs as the same read fingerprint', async () => {
    const first = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Grep', input: { pattern: 'thing', path: '/repo' } },
    ]));
    noteTrajectoryCompression(first!.sessionSha8, true);
    const second = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Grep', input: { pattern: 'thing', path: '/repo' } },
      { id: 'b', name: 'Grep', input: { path: '/repo', pattern: 'thing' } },
    ]));
    expect(second?.repeatedReadLikeCalls).toBe(1);
  });

  it('counts repeated result contents without exposing their text', async () => {
    const first = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Read', input: { file_path: '/secret/path.ts' }, result: 'private payload' },
    ]));
    noteTrajectoryCompression(first!.sessionSha8, true);
    const second = await observeAnthropicTrajectory(request([
      { id: 'a', name: 'Read', input: { file_path: '/secret/path.ts' }, result: 'private payload' },
      { id: 'b', name: 'Read', input: { file_path: '/secret/path.ts' }, result: 'private payload' },
    ]));
    expect(second?.repeatedToolResults).toBe(1);
    expect(JSON.stringify(second)).not.toContain('/secret/path.ts');
    expect(JSON.stringify(second)).not.toContain('private payload');
  });
});
