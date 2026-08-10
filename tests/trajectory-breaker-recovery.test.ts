import { describe, expect, it, beforeEach } from 'vitest';
import {
  observeAnthropicTrajectory,
  observeGoogleTrajectory,
  noteTrajectoryCompression,
  clearTrajectoryState,
} from '../src/core/trajectory.js';
import { applyTrajectoryCircuitBreaker } from '../src/core/trajectory-policy.js';
import { escapeMissingGlyphs, renderChunkToPng } from '../src/core/render.js';
import { toTrackEvent } from '../src/core/tracker.js';

describe('trajectory circuit breaker recovery & lineage isolation', () => {
  beforeEach(() => {
    clearTrajectoryState();
  });

  it('1. Real harmful loop: same read-like call repeated 3 times after compression triggers breaker and stays native', async () => {
    const makeBody = (readPath: string, toolId: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          messages: [
            { role: 'user', content: 'Debug issue' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: toolId, name: 'read_file', input: { path: readPath } }],
            },
          ],
        }),
      );

    // Turn 1
    const obs1 = await observeAnthropicTrajectory(makeBody('foo.ts', 't1'), 'claude-3-5-sonnet-20241022');
    expect(obs1?.breakerActive).toBe(false);
    noteTrajectoryCompression(obs1!.sessionSha8, true); // Exposure

    // Repeats 1, 2, 3
    const obs2 = await observeAnthropicTrajectory(makeBody('foo.ts', 't2'), 'claude-3-5-sonnet-20241022');
    expect(obs2?.breakerActive).toBe(false);

    const obs3 = await observeAnthropicTrajectory(makeBody('foo.ts', 't3'), 'claude-3-5-sonnet-20241022');
    expect(obs3?.breakerActive).toBe(false);

    const obs4 = await observeAnthropicTrajectory(makeBody('foo.ts', 't4'), 'claude-3-5-sonnet-20241022');
    expect(obs4?.breakerTriggered).toBe(true);
    expect(obs4?.breakerActive).toBe(true);
    expect(obs4?.breakerReason).toBe('repeated_read_like_calls');

    // Policy disables compression
    const policy = applyTrajectoryCircuitBreaker({ compress: true, collapseHistory: true }, obs4);
    expect(policy.compress).toBe(false);
    expect(policy.collapseHistory).toBe(false);

    // Turn 5: continuing loop stays native
    const obs5 = await observeAnthropicTrajectory(makeBody('foo.ts', 't5'), 'claude-3-5-sonnet-20241022');
    expect(obs5?.breakerActive).toBe(true);
  });

  it('2. Ordinary coding progress: many different tool/read calls do NOT trigger breaker', async () => {
    const makeBody = (tools: Array<{ id: string; name: string; path: string }>) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          messages: [
            { role: 'user', content: 'Refactor codebase' },
            {
              role: 'assistant',
              content: tools.map((t) => ({
                type: 'tool_use',
                id: t.id,
                name: t.name,
                input: { path: t.path },
              })),
            },
          ],
        }),
      );

    const obs1 = await observeAnthropicTrajectory(
      makeBody([{ id: 't1', name: 'read_file', path: 'file1.ts' }]),
      'claude-3-5-sonnet-20241022',
    );
    noteTrajectoryCompression(obs1!.sessionSha8, true);

    for (let i = 2; i <= 10; i++) {
      const obs = await observeAnthropicTrajectory(
        makeBody([{ id: `t${i}`, name: 'read_file', path: `file${i}.ts` }]),
        'claude-3-5-sonnet-20241022',
      );
      expect(obs?.breakerActive).toBe(false);
    }
  });

  it('3. AGY-style history compaction/rewrite: compacted history clears stale read counts and avoids false trigger', async () => {
    const makeAnthropicBody = (msgCount: number, readPath: string) => {
      const msgs: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'AGY session' }];
      for (let i = 1; i < msgCount; i++) {
        msgs.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t_${i}`, name: 'read_file', input: { path: readPath } }],
        });
      }
      return new TextEncoder().encode(
        JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: msgs }),
      );
    };

    // Grow trajectory to 20 messages with a read call
    const obs1 = await observeAnthropicTrajectory(makeAnthropicBody(20, 'src/index.ts'), 'claude-3-5-sonnet-20241022');
    noteTrajectoryCompression(obs1!.sessionSha8, true);

    // AGY compacts history from 20 down to 4 messages
    const obs2 = await observeAnthropicTrajectory(makeAnthropicBody(4, 'src/index.ts'), 'claude-3-5-sonnet-20241022');
    expect(obs2?.lineageReset).toBe(true);
    expect(obs2?.lineageEpoch).toBe(1);
    expect(obs2?.breakerActive).toBe(false);
    expect(obs2?.repeatedReadsAfterCompression).toBe(0);
  });

  it('4. Context/lineage reset after a breaker: verified new lineage recovers compression without daemon restart', async () => {
    const makeBody = (prompt: string, toolId: string, extraMsgs = 0) => {
      const msgs: Array<{ role: string; content: unknown }> = [{ role: 'user', content: prompt }];
      for (let i = 0; i < extraMsgs; i++) {
        msgs.push({ role: 'assistant', content: `turn ${i}` });
      }
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: 'read_file', input: { path: 'same.ts' } }],
      });
      return new TextEncoder().encode(
        JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: msgs }),
      );
    };

    // Trigger breaker in session (with 20 messages history)
    const obs1 = await observeAnthropicTrajectory(makeBody('AGY Task', 't1', 20), 'claude-3-5-sonnet-20241022');
    noteTrajectoryCompression(obs1!.sessionSha8, true);

    await observeAnthropicTrajectory(makeBody('AGY Task', 't2', 20), 'claude-3-5-sonnet-20241022');
    await observeAnthropicTrajectory(makeBody('AGY Task', 't3', 20), 'claude-3-5-sonnet-20241022');
    const obsBreaker = await observeAnthropicTrajectory(makeBody('AGY Task', 't4', 20), 'claude-3-5-sonnet-20241022');
    expect(obsBreaker?.breakerActive).toBe(true);

    // AGY resets/compacts history down to 2 messages (verified lineage reset)
    const obsReset = await observeAnthropicTrajectory(makeBody('AGY Task', 't1_reset', 0), 'claude-3-5-sonnet-20241022');
    expect(obsReset?.lineageReset).toBe(true);
    expect(obsReset?.breakerActive).toBe(false);

    const policy = applyTrajectoryCircuitBreaker({ compress: true, collapseHistory: true }, obsReset);
    expect(policy.compress).toBe(true);
  });

  it('5. Breaker does NOT clear simply because time passes', async () => {
    const makeBody = (toolId: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          messages: [
            { role: 'user', content: 'Long session' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: toolId, name: 'read_file', input: { path: 'stuck.ts' } }],
            },
          ],
        }),
      );

    const obs1 = await observeAnthropicTrajectory(makeBody('t1'), 'claude-3-5-sonnet-20241022');
    noteTrajectoryCompression(obs1!.sessionSha8, true);
    await observeAnthropicTrajectory(makeBody('t2'), 'claude-3-5-sonnet-20241022');
    await observeAnthropicTrajectory(makeBody('t3'), 'claude-3-5-sonnet-20241022');
    const obsBreaker = await observeAnthropicTrajectory(makeBody('t4'), 'claude-3-5-sonnet-20241022');
    expect(obsBreaker?.breakerActive).toBe(true);

    // Subsequent request on same lineage without forward progress or reset stays native
    const obsAfterTime = await observeAnthropicTrajectory(makeBody('t4'), 'claude-3-5-sonnet-20241022');
    expect(obsAfterTime?.breakerActive).toBe(true);
  });

  it('6. Forward progress automatically recovers breaker without daemon restart', async () => {
    const makeBody = (tools: Array<{ id: string; name: string; input: Record<string, unknown> }>) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          messages: [
            { role: 'user', content: 'Fix loop' },
            {
              role: 'assistant',
              content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
            },
          ],
        }),
      );

    // Trigger breaker
    const obs1 = await observeAnthropicTrajectory(makeBody([{ id: 't1', name: 'read_file', input: { p: 'loop.ts' } }]), 'claude-3-5-sonnet-20241022');
    noteTrajectoryCompression(obs1!.sessionSha8, true);
    await observeAnthropicTrajectory(makeBody([{ id: 't2', name: 'read_file', input: { p: 'loop.ts' } }]), 'claude-3-5-sonnet-20241022');
    await observeAnthropicTrajectory(makeBody([{ id: 't3', name: 'read_file', input: { p: 'loop.ts' } }]), 'claude-3-5-sonnet-20241022');
    const obsBreaker = await observeAnthropicTrajectory(makeBody([{ id: 't4', name: 'read_file', input: { p: 'loop.ts' } }]), 'claude-3-5-sonnet-20241022');
    expect(obsBreaker?.breakerActive).toBe(true);

    // Agent executes 5 distinct new forward progress tool calls (e.g. edit_file, execute_command)
    const obsRecover = await observeAnthropicTrajectory(
      makeBody([
        { id: 't4', name: 'read_file', input: { p: 'loop.ts' } },
        { id: 't5', name: 'edit_file', input: { p: 'a.ts' } },
        { id: 't6', name: 'edit_file', input: { p: 'b.ts' } },
        { id: 't7', name: 'bash', input: { c: 'pnpm test' } },
        { id: 't8', name: 'edit_file', input: { p: 'c.ts' } },
        { id: 't9', name: 'edit_file', input: { p: 'd.ts' } },
      ]),
      'claude-3-5-sonnet-20241022',
    );
    expect(obsRecover?.breakerActive).toBe(false);
  });

  it('7. Separate concurrent Claude/Codex/AGY trajectories do NOT contaminate one another', async () => {
    const makeAnthropicBody = (toolId: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          messages: [
            { role: 'user', content: 'Session A' },
            { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'read_file', input: { path: 'a.ts' } }] },
          ],
        }),
      );

    const bodyB = new TextEncoder().encode(
      JSON.stringify({
        model: 'gemini-3.6-flash',
        contents: [
          { role: 'user', parts: [{ text: 'Session B' }] },
          { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'b.ts' } } }] },
        ],
      }),
    );

    const obsA = await observeAnthropicTrajectory(makeAnthropicBody('t1'), 'claude-3-5-sonnet-20241022');
    const obsB = await observeGoogleTrajectory(bodyB, 'gemini-3.6-flash');

    expect(obsA?.sessionSha8).not.toBe(obsB?.sessionSha8);
    noteTrajectoryCompression(obsA!.sessionSha8, true);

    // Trip Session A
    await observeAnthropicTrajectory(makeAnthropicBody('t2'), 'claude-3-5-sonnet-20241022');
    await observeAnthropicTrajectory(makeAnthropicBody('t3'), 'claude-3-5-sonnet-20241022');
    const obsATrip = await observeAnthropicTrajectory(makeAnthropicBody('t4'), 'claude-3-5-sonnet-20241022');
    expect(obsATrip?.breakerActive).toBe(true);

    // Session B remains clean
    const obsBClean = await observeGoogleTrajectory(bodyB, 'gemini-3.6-flash');
    expect(obsBClean?.breakerActive).toBe(false);
  });

  it('8. P3 render_lossy fix: C0 controls (e.g. \\r 0x0D) are escaped to [U+HEX] and rendered with droppedChars === 0', async () => {
    const textWithCR = 'line1\r\nline2\r\nline3\r';
    const escaped = escapeMissingGlyphs(textWithCR);
    expect(escaped).toContain('[U+D]');

    const img = await renderChunkToPng(textWithCR, 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('9. Telemetry mapping populates lineage and breaker observability fields', () => {
    const event = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 15,
      trajectory: {
        sessionSha8: 'sess1234',
        lineageSha8: 'line5678',
        lineageEpoch: 2,
        lineageReset: true,
        newToolCalls: 3,
        newReadLikeCalls: 1,
        repeatedReadLikeCalls: 1,
        repeatedReadsAfterCompression: 3,
        repeatedToolResults: 0,
        compressionExposed: true,
        breakerTriggered: true,
        breakerActive: true,
        breakerReason: 'repeated_read_like_calls',
      },
    });

    expect(event).toMatchObject({
      trajectory_session_sha8: 'sess1234',
      trajectory_lineage_sha8: 'line5678',
      trajectory_lineage_epoch: 2,
      trajectory_lineage_reset: true,
      trajectory_new_tool_calls: 3,
      trajectory_new_read_like_calls: 1,
      trajectory_repeated_read_like_calls: 1,
      trajectory_repeated_reads_after_compression: 3,
      trajectory_breaker_triggered: true,
      trajectory_breaker_active: true,
      trajectory_breaker_reason: 'repeated_read_like_calls',
    });
  });
});
