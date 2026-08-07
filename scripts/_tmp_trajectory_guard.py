from pathlib import Path

proxy = Path('src/core/proxy.ts')
text = proxy.read_text()

old = "import { markCacheDead, noteCacheOutcome, responseLeftNoCache } from './session-state.js';\n"
new = old + "import { noteTrajectoryCompression, observeAnthropicTrajectory, type TrajectoryObservation } from './trajectory.js';\nimport { applyTrajectoryCircuitBreaker } from './trajectory-policy.js';\n"
if old not in text:
    raise SystemExit('proxy import insertion point not found')
text = text.replace(old, new, 1)

old = "  upstream_attempt_count?: number;\n}\n"
new = "  upstream_attempt_count?: number;\n  /** Privacy-preserving session trajectory counters; never contains tool input, paths or result text. */\n  trajectory?: TrajectoryObservation;\n}\n"
if old not in text:
    raise SystemExit('ProxyEvent insertion point not found')
text = text.replace(old, new, 1)

old = "    let baselineStatusApplies = false;\n\n    if (isMessages || isOpenAIChat || isOpenAIResponses || isGoogle) {\n"
new = "    let baselineStatusApplies = false;\n    let trajectory: TrajectoryObservation | undefined;\n\n    if (isMessages || isOpenAIChat || isOpenAIResponses || isGoogle) {\n"
if old not in text:
    raise SystemExit('trajectory variable insertion point not found')
text = text.replace(old, new, 1)

old = "        const model = googleModel ?? readModelField(bodyIn);\n        requestModel = model ?? undefined;\n"
new = "        const model = googleModel ?? readModelField(bodyIn);\n        requestModel = model ?? undefined;\n        if (isMessages) {\n          trajectory = await observeAnthropicTrajectory(bodyIn, requestModel);\n        }\n"
if old not in text:
    raise SystemExit('trajectory observation insertion point not found')
text = text.replace(old, new, 1)

old = """        const effectiveOpts: TransformOptions = (modelOk
          ? (featherlessProvider ? { ...transformOpts, imagePlacement: 'merge_first_user' as const, imageDetail: 'auto' as const } : transformOpts)
          : { ...transformOpts, compress: false }) ?? { compress: false };
"""
new = """        const profileOpts: TransformOptions = (modelOk
          ? (featherlessProvider ? { ...transformOpts, imagePlacement: 'merge_first_user' as const, imageDetail: 'auto' as const } : transformOpts)
          : { ...transformOpts, compress: false }) ?? { compress: false };
        const effectiveOpts = applyTrajectoryCircuitBreaker(profileOpts, trajectory);
"""
if old not in text:
    raise SystemExit('effectiveOpts block not found')
text = text.replace(old, new, 1)

old = """              ? await transformOpenAIChatCompletions(bodyIn, effectiveOpts)
              : await transformOpenAIResponses(bodyIn, effectiveOpts);
        if (isGoogle && r.info.compressed) {
"""
new = """              ? await transformOpenAIChatCompletions(bodyIn, effectiveOpts)
              : await transformOpenAIResponses(bodyIn, effectiveOpts);
        if (trajectory) {
          noteTrajectoryCompression(
            trajectory.sessionSha8,
            Boolean(r.info.compressed && (r.info.imageCount ?? 0) > 0),
          );
        }
        if (isGoogle && r.info.compressed) {
"""
if old not in text:
    raise SystemExit('trajectory outcome insertion point not found')
text = text.replace(old, new, 1)

old = """          fallback_result: featherlessProvider ? fallbackResult : undefined,
          upstream_attempt_count: featherlessProvider ? upstreamAttemptCount : undefined,
        });
"""
new = """          fallback_result: featherlessProvider ? fallbackResult : undefined,
          upstream_attempt_count: featherlessProvider ? upstreamAttemptCount : undefined,
          trajectory,
        });
"""
if old not in text:
    raise SystemExit('final event insertion point not found')
proxy.write_text(text.replace(old, new, 1))

tracker = Path('src/core/tracker.ts')
text = tracker.read_text()
old = """  // Fingerprints:
  system_sha8?: string;
  first_user_sha8?: string;

  // From Anthropic/OpenAI Usage:
"""
new = """  // Fingerprints:
  system_sha8?: string;
  first_user_sha8?: string;

  // Privacy-preserving coding-agent trajectory telemetry. No raw tool inputs,
  // paths, prompts or result contents are persisted.
  trajectory_session_sha8?: string;
  trajectory_new_tool_calls?: number;
  trajectory_new_read_like_calls?: number;
  trajectory_repeated_read_like_calls?: number;
  trajectory_repeated_tool_results?: number;
  trajectory_compression_exposed?: boolean;
  trajectory_breaker_triggered?: boolean;
  trajectory_breaker_active?: boolean;

  // From Anthropic/OpenAI Usage:
"""
if old not in text:
    raise SystemExit('TrackEvent trajectory field insertion point not found')
text = text.replace(old, new, 1)

old = """  if (ev.firstByteMs !== undefined) out.first_byte_ms = ev.firstByteMs;
  if (ev.error) out.error = ev.error;
"""
new = """  if (ev.firstByteMs !== undefined) out.first_byte_ms = ev.firstByteMs;
  if (ev.trajectory) {
    out.trajectory_session_sha8 = ev.trajectory.sessionSha8;
    if (ev.trajectory.newToolCalls > 0) out.trajectory_new_tool_calls = ev.trajectory.newToolCalls;
    if (ev.trajectory.newReadLikeCalls > 0) out.trajectory_new_read_like_calls = ev.trajectory.newReadLikeCalls;
    if (ev.trajectory.repeatedReadLikeCalls > 0) {
      out.trajectory_repeated_read_like_calls = ev.trajectory.repeatedReadLikeCalls;
    }
    if (ev.trajectory.repeatedToolResults > 0) {
      out.trajectory_repeated_tool_results = ev.trajectory.repeatedToolResults;
    }
    if (ev.trajectory.compressionExposed) out.trajectory_compression_exposed = true;
    if (ev.trajectory.breakerTriggered) out.trajectory_breaker_triggered = true;
    if (ev.trajectory.breakerActive) out.trajectory_breaker_active = true;
  }
  if (ev.error) out.error = ev.error;
"""
if old not in text:
    raise SystemExit('toTrackEvent trajectory insertion point not found')
tracker.write_text(text.replace(old, new, 1))

index = Path('src/core/index.ts')
text = index.read_text()
append = """export {
  clearTrajectoryState,
  noteTrajectoryCompression,
  observeAnthropicTrajectory,
  trajectoryLimits,
  type TrajectoryObservation,
} from './trajectory.js';
export { applyTrajectoryCircuitBreaker } from './trajectory-policy.js';
"""
if "from './trajectory.js'" not in text:
    text += append
index.write_text(text)

Path('tests/trajectory-tracker.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
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
''')
