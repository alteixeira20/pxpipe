import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTrajectoryState,
  noteTrajectoryCompression,
  observeGoogleTrajectory,
} from '../src/core/trajectory.js';

const enc = new TextEncoder();

beforeEach(() => clearTrajectoryState());

function googleBody(readCount: number, antigravity = false): Uint8Array {
  const contents: Array<Record<string, unknown>> = [
    { role: 'user', parts: [{ text: 'Fix the repository carefully.' }] },
  ];
  for (let i = 0; i < readCount; i++) {
    contents.push({
      role: 'model',
      parts: [{ functionCall: { name: 'Read', args: { file_path: '/repo/src/a.ts' } } }],
    });
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: 'Read', response: { content: 'const answer = 42;' } } }],
    });
  }
  const request = { contents };
  return enc.encode(JSON.stringify(
    antigravity
      ? { model: 'gemini-3.6-flash-high', project: 'p', request }
      : request,
  ));
}

describe('Google/Antigravity trajectory guard', () => {
  it('does not recount replayed history, but detects newly appended repeated reads', async () => {
    const first = await observeGoogleTrajectory(
      googleBody(1),
      'gemini-3.6-flash-high',
    );
    expect(first).toMatchObject({
      newToolCalls: 1,
      newReadLikeCalls: 1,
      repeatedReadLikeCalls: 0,
      repeatedToolResults: 0,
      breakerActive: false,
    });
    noteTrajectoryCompression(first!.sessionSha8, true);

    const replay = await observeGoogleTrajectory(
      googleBody(1),
      'gemini-3.6-flash-high',
    );
    expect(replay).toMatchObject({
      newToolCalls: 0,
      newReadLikeCalls: 0,
      repeatedReadLikeCalls: 0,
    });

    const second = await observeGoogleTrajectory(googleBody(2), 'gemini-3.6-flash-high');
    expect(second).toMatchObject({ newReadLikeCalls: 1, repeatedReadLikeCalls: 1, breakerActive: false });
    const third = await observeGoogleTrajectory(googleBody(3), 'gemini-3.6-flash-high');
    expect(third).toMatchObject({ newReadLikeCalls: 1, repeatedReadLikeCalls: 1, breakerActive: false });
    const fourth = await observeGoogleTrajectory(googleBody(4), 'gemini-3.6-flash-high');
    expect(fourth).toMatchObject({
      newReadLikeCalls: 1,
      repeatedReadLikeCalls: 1,
      breakerTriggered: true,
      breakerActive: true,
    });
  });

  it('understands the nested Antigravity request without hashing provider metadata into the task', async () => {
    const a = await observeGoogleTrajectory(
      googleBody(1, true),
      'gemini-3.6-flash-high',
      true,
    );
    expect(a?.newReadLikeCalls).toBe(1);
    noteTrajectoryCompression(a!.sessionSha8, true);
    const b = await observeGoogleTrajectory(
      googleBody(2, true),
      'gemini-3.6-flash-high',
      true,
    );
    expect(b).toMatchObject({ repeatedReadLikeCalls: 1, compressionExposed: true });
  });
});
