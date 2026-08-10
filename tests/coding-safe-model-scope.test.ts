/**
 * Admission proofs for the two models added to the coding-safe validated scope:
 * `claude-opus-5` (Anthropic Messages) and `gpt-5.6-sol` (OpenAI Responses).
 *
 * These are deliberately MODEL-SPECIFIC. The generic per-provider suites already
 * cover the transforms; what needs proving here is that each newly admitted id
 * runs the already-validated contract and satisfies every coding-safe invariant
 * end to end, under the real `coding-safe` profile rather than hand-tuned
 * options.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isPxpipeSupportedGptModel,
  isPxpipeSupportedModelForScope,
  setAllowedModelBases,
} from '../src/core/applicability.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { transformAnthropicMessages } from '../src/core/library.js';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
} from '../src/core/safety-policy.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const CODING_SAFE = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));

// --- fixtures --------------------------------------------------------------

const SOL_TOOLS = [{
  type: 'function',
  name: 'shell',
  description: 'Run a shell command in the workspace.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { cmd: { type: 'array', items: { type: 'string' } } },
    required: ['cmd'],
  },
}];

/** A long read-only Codex session: closed tool rounds plus interleaved prose. */
function solRequest(rounds = 30, marker = ''): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [
    { role: 'developer', content: 'Project rules: never edit dist/. Run pnpm test before finishing.' },
  ];
  for (let i = 0; i < rounds; i += 1) {
    input.push({
      role: 'user',
      content: [{
        type: 'input_text',
        text: `Round ${i}:${i === 3 ? marker : ''} inspect src/core/openai.ts:${100 + i} and report.`,
      }],
    });
    input.push({
      type: 'function_call',
      call_id: `call_${i}`,
      name: 'shell',
      arguments: JSON.stringify({ cmd: ['rg', '-n', `symbol_${i}`, 'src/core/openai.ts'] }),
    });
    input.push({
      type: 'function_call_output',
      call_id: `call_${i}`,
      output: `src/core/openai.ts:${100 + i}:  export function symbol_${i}(arg: string): void {\n`
        + `stdout line ${i} `.repeat(120),
    });
    input.push({
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: `Round ${i}: symbol_${i} lives at src/core/openai.ts:${100 + i}. `
          + 'Analysis prose. '.repeat(60),
      }],
    });
  }
  input.push({
    role: 'user',
    content: [{ type: 'input_text', text: 'Now summarise what symbol_3 does. Do not modify anything.' }],
  });
  return {
    model: 'gpt-5.6-sol',
    instructions: 'You are Codex, a read-only coding agent. Obey AGENTS.md.',
    tools: SOL_TOOLS,
    input,
  };
}

const CLAUDE_TOOLS = [{
  name: 'Read',
  description: 'Read a file from the local filesystem.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, offset: { type: 'number' } },
    required: ['path'],
  },
}];

function claudeRequest(model: string, rounds = 26): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rounds; i += 1) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `Round ${i}: inspect src/core/transform.ts:${200 + i}.` }],
    });
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Reading src/core/transform.ts:${200 + i}. ` + 'reasoning prose '.repeat(60) },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { path: 'src/core/transform.ts', offset: 200 + i } },
      ],
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `toolu_${i}`,
        content: `src/core/transform.ts:${200 + i}: export function fn_${i}() {}\n`
          + `body line ${i} `.repeat(120),
      }],
    });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Now explain fn_3. Read-only.' }] });
  return {
    model,
    max_tokens: 1024,
    system: 'You are Claude Code. Obey CLAUDE.md. Never edit dist/.',
    tools: CLAUDE_TOOLS,
    messages,
  };
}

// --- helpers ---------------------------------------------------------------

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `${type}:${id}` for every protocol item, in wire order. */
function responsesCallIds(items: Array<Record<string, unknown>>): string[] {
  return items
    .filter((item) => item.type === 'function_call' || item.type === 'function_call_output')
    .map((item) => `${String(item.type)}:${String(item.call_id)}`);
}

function anthropicCallIds(messages: Array<Record<string, unknown>>): string[] {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []))
    .filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
    .map((b) => `${String(b.type)}:${String(b.id ?? b.tool_use_id)}`);
}

/** Every surviving id still appears, in its original relative order. */
function isOrderedSubsequence(survivors: string[], original: string[]): boolean {
  let cursor = 0;
  for (const id of survivors) {
    while (cursor < original.length && original[cursor] !== id) cursor += 1;
    if (cursor >= original.length) return false;
    cursor += 1;
  }
  return true;
}

/** How many trailing items survived byte-for-byte. */
function verbatimTail(before: unknown[], after: unknown[]): number {
  let count = 0;
  for (let k = 1; k <= before.length && k <= after.length; k += 1) {
    if (JSON.stringify(before[before.length - k]) !== JSON.stringify(after[after.length - k])) break;
    count += 1;
  }
  return count;
}

function allText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(allText).join('\n');
  return '';
}

// --- scope policy ----------------------------------------------------------

describe('coding-safe validated model scope', () => {
  const previousModels = process.env.PXPIPE_MODELS;

  beforeEach(() => {
    // Admission is only reachable when the operator ALSO configured the model.
    setAllowedModelBases([
      'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5',
      'claude-opus-4-6', 'claude-sonnet-4-6',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'grok-4.5',
    ]);
  });
  afterEach(() => {
    setAllowedModelBases(null);
    if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = previousModels;
  });

  it('admits the Claude 5 family and gpt-5.6-sol alongside the previously validated bases', () => {
    for (const model of [
      'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'gpt-5.6-sol',
    ]) {
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(true);
      expect(isPxpipeSupportedModelForScope(model, 'balanced')).toBe(true);
    }
  });

  it('admits a Claude id only when it resolves to the IDENTICAL validated profile object', () => {
    // Object identity is the admission criterion, not the name. Every admitted
    // Claude id must be the same CLAUDE_PROFILE that Fable 5 was validated on.
    const validated = resolveGptProfile('claude-fable-5');
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5']) {
      expect(resolveGptProfile(model)).toBe(validated);
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(true);
    }
    // Pre-4.7 Claude resolves to the legacy profile (standard vision tier), a
    // different contract, so it stays out however it is configured.
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(resolveGptProfile(model)).not.toBe(validated);
      expect(resolveGptProfile(model).visionTier).toBe('standard');
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(false);
    }
  });

  it('admits a GPT id only when it resolves to the IDENTICAL validated Sol profile', () => {
    const validated = resolveGptProfile('gpt-5.6-sol');
    expect(resolveGptProfile('gpt-5.6-sol-codex')).toBe(validated);
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6']) {
      const other = resolveGptProfile(model);
      expect(other).not.toBe(validated);
      // Materially different render contract, not a spelling difference.
      expect(other.stripCols).not.toBe(validated.stripCols);
      expect(other.history.responsesMode).not.toBe(validated.history.responsesMode);
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(false);
    }
  });

  it('admits the -suffixed aliases that resolve to the same validated profile', () => {
    for (const model of ['gpt-5.6-sol-codex', 'gpt-5.6-sol[1m]', 'gpt-5.6-sol-codex[1m]', 'vendor/gpt-5.6-sol']) {
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(true);
      expect(resolveGptProfile(model)).toBe(resolveGptProfile('gpt-5.6-sol'));
    }
    for (const model of ['claude-opus-5-20260101', 'anthropic/claude-opus-5']) {
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(true);
      expect(resolveGptProfile(model)).toBe(resolveGptProfile('claude-fable-5'));
    }
  });

  it('does not broaden to sibling variants that share a version number', () => {
    for (const model of [
      'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5-codex', 'gpt-5-mini', 'gpt-4o',
      'claude-opus-4-6', 'claude-sonnet-4-6', 'grok-4.5',
    ]) {
      expect(isPxpipeSupportedModelForScope(model, 'coding-safe')).toBe(false);
      expect(isPxpipeSupportedModelForScope(model, 'balanced')).toBe(false);
    }
  });

  it('keeps admission independent of enablement — the operator still has to configure the model', () => {
    setAllowedModelBases(null);
    delete process.env.PXPIPE_MODELS;
    expect(isPxpipeSupportedModelForScope('gpt-5.6-sol', 'coding-safe')).toBe(false);
    expect(isPxpipeSupportedModelForScope('claude-opus-5', 'coding-safe')).toBe(false);
    process.env.PXPIPE_MODELS = 'gpt-5.6-sol,claude-opus-5';
    expect(isPxpipeSupportedModelForScope('gpt-5.6-sol', 'coding-safe')).toBe(true);
    expect(isPxpipeSupportedModelForScope('claude-opus-5', 'coding-safe')).toBe(true);
  });

  it('still compresses nothing under passthrough', () => {
    for (const model of ['claude-opus-5', 'gpt-5.6-sol']) {
      expect(isPxpipeSupportedModelForScope(model, 'passthrough')).toBe(false);
    }
  });
});

// --- gpt-5.6-sol / OpenAI Responses ---------------------------------------

describe('gpt-5.6-sol coding-safe invariants (OpenAI Responses)', () => {
  it('images only eligible closed archival history and keeps everything live native', async () => {
    const body = solRequest();
    const before = clone(body);
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(body)),
      CODING_SAFE,
    );
    const after = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    const beforeInput = before.input as Array<Record<string, unknown>>;
    const afterInput = after.input as Array<Record<string, unknown>>;

    // Compression actually happened, via images.
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.imageCount).toBeGreaterThan(0);

    // Authority stays native: no pointer substitution, no imaged slab.
    expect(after.instructions).toBe(before.instructions);
    expect(afterInput[0]).toEqual(beforeInput[0]);
    expect(result.info.bucketChars?.static_slab).toBeUndefined();

    // Tool definitions and JSON schemas stay exact native JSON.
    expect(after.tools).toEqual(before.tools);

    // The current user request is untouched.
    expect(afterInput.at(-1)).toEqual(beforeInput.at(-1));

    // Recent tail native per policy: coding-safe keeps 12 recent pairs, and a
    // Responses round is a call + an output.
    expect(verbatimTail(beforeInput, afterInput)).toBeGreaterThanOrEqual(24);

    // Only closed, complete rounds moved: no orphaned call or output survives.
    const survivors = responsesCallIds(afterInput);
    const calls = new Set(survivors.filter((s) => s.startsWith('function_call:')).map((s) => s.split(':')[1]));
    const outputs = new Set(survivors.filter((s) => s.startsWith('function_call_output:')).map((s) => s.split(':')[1]));
    expect([...calls].every((id) => outputs.has(id))).toBe(true);
    expect([...outputs].every((id) => calls.has(id))).toBe(true);

    // Call ids and call/output ordering are exact for everything left native.
    expect(isOrderedSubsequence(survivors, responsesCallIds(beforeInput))).toBe(true);

    // Render was lossless.
    expect(result.info.droppedChars ?? 0).toBe(0);
  });

  it('carries exact historical identifiers into the precision ledger', async () => {
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(solRequest())),
      CODING_SAFE,
    );
    const after = JSON.parse(dec.decode(result.body)) as { input: unknown[] };
    const text = allText(after.input);
    // Symbols, paths-with-line and commands from the IMAGED prefix survive as text.
    expect(text).toContain('symbol_3');
    expect(text).toContain('src/core/openai.ts');
    expect(text).toMatch(/openai\.ts:10\d/);
  });

  it('leaves an open (unclosed) tool call and its request entirely native', async () => {
    const body = solRequest();
    const input = body.input as Array<Record<string, unknown>>;
    // Drop the final round's output: the call is now open.
    input.splice(input.length - 3, 0, {
      type: 'function_call', call_id: 'call_open', name: 'shell',
      arguments: JSON.stringify({ cmd: ['pnpm', 'test'] }),
    });
    const before = clone(body);
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(body)),
      CODING_SAFE,
    );
    const after = JSON.parse(dec.decode(result.body)) as { input: Array<Record<string, unknown>> };
    const open = after.input.find((item) => item.call_id === 'call_open');
    expect(open).toEqual((before.input as Array<Record<string, unknown>>).find((i) => i.call_id === 'call_open'));
    expect(after.input.filter((i) => i.call_id === 'call_open')).toHaveLength(1);
  });

  it('refuses to substitute an image the renderer could not represent losslessly', async () => {
    // U+0003 is the internal slot marker: exempt from escaping and absent from
    // the atlas, so it is the one condition the renderer cannot recover.
    const body = solRequest(30, '');
    const before = clone(body);
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(body)),
      CODING_SAFE,
    );
    const after = JSON.parse(dec.decode(result.body)) as { input: unknown[] };

    expect(result.info.historyReason).toBe('render_lossy');
    expect(result.info.droppedChars).toBeGreaterThan(0);
    expect(result.info.imageCount ?? 0).toBe(0);
    expect(after.input).toEqual(before.input);
  });

  it('keeps instructions and system/developer authority native even when the slab is large', async () => {
    // Regression: a model profile's minCompressTokens must not override the
    // coding-safe history-only static floor and image authority text.
    const body = {
      model: 'gpt-5.6-sol',
      instructions: 'You are a coding agent. Follow AGENTS.md exactly. '.repeat(400),
      tools: SOL_TOOLS,
      input: [
        { role: 'developer', content: 'Project rules: never edit dist/. '.repeat(200) },
        { role: 'user', content: [{ type: 'input_text', text: 'What does src/core/openai.ts do?' }] },
      ],
    };
    const before = clone(body);
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(body)),
      CODING_SAFE,
    );
    const after = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toMatch(/^below_min_chars/);
    expect(after.instructions).toBe(before.instructions);
    expect(after.input).toEqual(before.input);
    expect(after.tools).toEqual(before.tools);
  });

  it('abstains on unsupported request shapes instead of failing the request', async () => {
    for (const raw of ['{ not json', JSON.stringify({ model: 'gpt-5.6-sol', input: 42 })]) {
      const original = enc.encode(raw);
      const result = await transformOpenAIResponses(original, CODING_SAFE);
      expect(result.info.compressed).toBe(false);
      expect(result.info.reason).toMatch(/^parse_error/);
      expect(dec.decode(result.body)).toBe(raw);
    }
  });

  it('is byte-stable across repeated identical requests (cache stability)', async () => {
    const first = await transformOpenAIResponses(enc.encode(JSON.stringify(solRequest())), CODING_SAFE);
    const second = await transformOpenAIResponses(enc.encode(JSON.stringify(solRequest())), CODING_SAFE);
    expect(dec.decode(second.body)).toBe(dec.decode(first.body));
    expect(second.info.historyImageSha).toBe(first.info.historyImageSha);
  });

  it('keeps the existing OpenAI profitability gate unchanged', async () => {
    // Sol declares minCompressTokens, so the gate scores BOTH sides exactly:
    // the renderer's own page split for the image side, an o200k count for the
    // text side. A collapse therefore only ever happens when the images really
    // do cost less than the text they replace, and no charsPerToken override
    // can move that decision.
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(solRequest())),
      CODING_SAFE,
    );
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.imageTokens!).toBeLessThan(result.info.baselineImagedTokens!);

    const skewed = await transformOpenAIResponses(
      enc.encode(JSON.stringify(solRequest())),
      { ...CODING_SAFE, charsPerToken: 1_000 },
    );
    expect(skewed.info.imageTokens).toBe(result.info.imageTokens);
    expect(skewed.info.baselineImagedTokens).toBe(result.info.baselineImagedTokens);
  });

  it('leaves an archival prefix below the history floor entirely native', async () => {
    const body = solRequest(4);
    const before = clone(body);
    const result = await transformOpenAIResponses(
      enc.encode(JSON.stringify(body)),
      CODING_SAFE,
    );
    const after = JSON.parse(dec.decode(result.body)) as { input: unknown[] };
    expect(result.info.imageCount ?? 0).toBe(0);
    expect(result.info.historyReason).not.toBe('collapsed');
    expect(after.input).toEqual(before.input);
  });
});

// --- claude-opus-5 / Anthropic Messages ------------------------------------

describe('claude-opus-5 coding-safe invariants (Anthropic Messages)', () => {
  const previousModels = process.env.PXPIPE_MODELS;
  beforeEach(() => setAllowedModelBases(['claude-fable-5', 'claude-opus-5']));
  afterEach(() => {
    setAllowedModelBases(null);
    if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = previousModels;
  });

  it('runs the identical validated profile object as claude-fable-5', () => {
    expect(resolveGptProfile('claude-opus-5')).toBe(resolveGptProfile('claude-fable-5'));
    expect(resolveGptProfile('claude-opus-5').vision).toEqual({ regime: 'patch28' });
    expect(resolveGptProfile('claude-opus-5').visionTier).toBe('high-res');
  });

  it('images only eligible closed archival history and keeps everything live native', async () => {
    const body = claudeRequest('claude-opus-5');
    const before = clone(body);
    const result = await transformAnthropicMessages({
      body: enc.encode(JSON.stringify(body)),
      model: 'claude-opus-5',
    });
    const after = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    const beforeMessages = before.messages as unknown[];
    const afterMessages = after.messages as Array<Record<string, unknown>>;

    expect(result.applied).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.collapsedTurns).toBeGreaterThan(0);

    // System authority and tool schemas stay exact native JSON.
    expect(after.system).toBe(before.system);
    expect(after.tools).toEqual(before.tools);

    // Current request and recent tail stay native.
    expect(afterMessages.at(-1)).toEqual((beforeMessages as Array<unknown>).at(-1));
    expect(verbatimTail(beforeMessages, afterMessages)).toBeGreaterThanOrEqual(12);

    // Live tool results are never imaged under coding-safe: the most recent
    // tool_result still carries its exact source text.
    const liveResult = [...afterMessages].reverse()
      .flatMap((m) => (Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []))
      .find((b) => b.type === 'tool_result');
    expect(typeof liveResult?.content).toBe('string');
    expect(String(liveResult?.content)).toContain('src/core/transform.ts:');

    // Ids and ordering exact for everything left native.
    expect(isOrderedSubsequence(
      anthropicCallIds(afterMessages),
      anthropicCallIds(beforeMessages as Array<Record<string, unknown>>),
    )).toBe(true);

    // Lossless.
    expect(result.info.droppedChars ?? 0).toBe(0);
  });

  it('produces the same decision as claude-fable-5 on the same conversation', async () => {
    const opus = await transformAnthropicMessages({
      body: enc.encode(JSON.stringify(claudeRequest('claude-opus-5'))),
      model: 'claude-opus-5',
    });
    const fable = await transformAnthropicMessages({
      body: enc.encode(JSON.stringify(claudeRequest('claude-fable-5'))),
      model: 'claude-fable-5',
    });
    expect(opus.applied).toBe(fable.applied);
    expect(opus.info.imageCount).toBe(fable.info.imageCount);
    expect(opus.info.collapsedTurns).toBe(fable.info.collapsedTurns);
    expect(opus.info.collapsedChars).toBe(fable.info.collapsedChars);
  });

  it('carries exact historical identifiers into the precision ledger', async () => {
    const result = await transformAnthropicMessages({
      body: enc.encode(JSON.stringify(claudeRequest('claude-opus-5'))),
      model: 'claude-opus-5',
    });
    const after = JSON.parse(dec.decode(result.body)) as { messages: unknown[] };
    const text = allText(after.messages);
    expect(text).toContain('fn_3');
    expect(text).toContain('src/core/transform.ts');
  });

  it('is byte-stable across repeated identical requests (cache stability)', async () => {
    const run = () => transformAnthropicMessages({
      body: enc.encode(JSON.stringify(claudeRequest('claude-opus-5'))),
      model: 'claude-opus-5',
    });
    const first = await run();
    const second = await run();
    expect(dec.decode(second.body)).toBe(dec.decode(first.body));
  });

  it('abstains on unsupported request shapes instead of failing the request', async () => {
    const raw = '{ not json';
    const result = await transformAnthropicMessages({
      body: enc.encode(raw),
      model: 'claude-opus-5',
    });
    expect(result.applied).toBe(false);
    expect(dec.decode(result.body)).toBe(raw);
  });
});

// --- shared: neither model may be compressed on an unrelated id -------------

describe('scope containment', () => {
  const previousModels = process.env.PXPIPE_MODELS;
  afterEach(() => {
    setAllowedModelBases(null);
    if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = previousModels;
  });

  it('does not admit gpt-5.6-terra even when the operator configures it', () => {
    setAllowedModelBases(['gpt-5.6-terra']);
    expect(isPxpipeSupportedModelForScope('gpt-5.6-terra', 'coding-safe')).toBe(false);
    expect(isPxpipeSupportedModelForScope('gpt-5.6-terra', 'balanced')).toBe(false);
    // ...but aggressive still honours the explicit opt-in, unchanged.
    expect(isPxpipeSupportedModelForScope('gpt-5.6-terra', 'aggressive')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-terra')).toBe(true); // aggressive is the env default
  });
});
