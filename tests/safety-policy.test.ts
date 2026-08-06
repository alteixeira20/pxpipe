import { describe, expect, it } from 'vitest';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
  shouldKeepToolResultSharp,
} from '../src/core/safety-policy.js';
import { transformAnthropicMessages } from '../src/core/library.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('compression safety profiles', () => {
  it('defaults to coding-safe history-only behavior', () => {
    const p = resolveCompressionProfile();
    expect(p.name).toBe('coding-safe');
    expect(p.transform.compress).toBe(true);
    expect(p.transform.compressTools).toBe(false);
    expect(p.transform.compressToolResults).toBe(false);
    expect(p.transform.collapseHistory).toBe(true);
    expect(p.transform.minCompressChars).toBe(Number.MAX_SAFE_INTEGER);
    expect(p.transform.historyAmortizationHorizon).toBe(4);
  });

  it('keeps balanced non-destructive and differs only in archival-history aggressiveness', () => {
    const p = resolveCompressionProfile('balanced');
    expect(p.transform.compress).toBe(true);
    expect(p.transform.compressTools).toBe(false);
    expect(p.transform.compressToolResults).toBe(false);
    expect(p.transform.minCompressChars).toBe(Number.MAX_SAFE_INTEGER);
    expect(p.transform.collapseHistory).toBe(true);
    expect(p.transform.historyAmortizationHorizon).toBe(3);
  });

  it('keeps destructive legacy behavior behind an explicit aggressive opt-in', () => {
    const p = resolveCompressionProfile('legacy');
    expect(p.name).toBe('aggressive');
    expect(p.transform.compressTools).toBe(true);
    expect(p.transform.compressToolResults).toBe(true);
    expect(p.transform.minToolResultChars).toBe(6000);
  });

  it('rejects unknown profiles instead of silently weakening safety', () => {
    expect(() => resolveCompressionProfile('fastest')).toThrow(/invalid PXPIPE_PROFILE/);
  });

  it.each([
    ['source', 'import { x } from "./x";\nexport function run() { return x; }'],
    ['diff', 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new'],
    ['stack', 'TypeError: boom\n    at run (/tmp/app.ts:42:7)'],
    ['tests', 'FAIL tests/auth.test.ts\nTests: 1 failed, 7 passed'],
    ['path+line', '/home/user/project/src/auth.ts:118:9 bad value'],
    ['structured', '{"path":"src/a.ts","line":18,"ok":false}'],
  ])('keeps %s tool output native when tool-result imaging is deliberately enabled by a host', (_name, text) => {
    expect(shouldKeepToolResultSharp({ kind: 'tool_result', text })).toBe(true);
  });

  it('does not over-classify ordinary reference prose as exact-state content', () => {
    const text = 'This is reference documentation about architecture and rationale. '.repeat(200);
    expect(shouldKeepToolResultSharp({ kind: 'tool_result', text })).toBe(false);
  });

  it('composes caller keepSharp with the built-in guard using OR semantics', () => {
    const p = resolveCompressionProfile('balanced');
    const merged = mergeCompressionProfileOptions(p, {
      keepSharp: (block) => block.text.includes('CUSTOM-SENSITIVE'),
    });
    expect(merged.keepSharp?.({ kind: 'tool_result', text: 'import x from "x"' })).toBe(true);
    expect(merged.keepSharp?.({ kind: 'tool_result', text: 'CUSTOM-SENSITIVE prose' })).toBe(true);
  });
});

describe('library default safety profile', () => {
  const makeBody = () => enc.encode(JSON.stringify({
    model: 'claude-fable-5',
    system: 'system authority '.repeat(8_000),
    tools: [{
      name: 'Read',
      description: 'Read an exact source file and preserve its semantics.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_read',
        content: 'import x from "./x";\n'.repeat(2_000),
      }],
    }],
  }));

  it('keeps authority text, tool docs and live source-code results native by default', async () => {
    const original = makeBody();
    const before = JSON.parse(dec.decode(original));
    const result = await transformAnthropicMessages({
      body: original,
      model: 'claude-fable-5',
    });
    const parsed = JSON.parse(dec.decode(result.body));

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('below_min_chars');
    expect(parsed.system).toBe(before.system);
    expect(parsed.tools[0].description).toContain('Read an exact source file');
    const tr = parsed.messages[0].content.find((b: { type?: string }) => b.type === 'tool_result');
    expect(typeof tr.content).toBe('string');
    expect(tr.content).toContain('import x from');
  });

  it('retains the lossy image path only when aggressive is explicitly requested', async () => {
    const result = await transformAnthropicMessages({
      body: makeBody(),
      model: 'claude-fable-5',
      options: { profile: 'aggressive', charsPerToken: 2 },
    });
    expect(result.applied).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
  });
});
