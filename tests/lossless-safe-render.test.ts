import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resolveCompressionProfile } from '../src/core/safety-policy.js';
import type { Message } from '../src/core/types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// U+FE0F variation selector is safely escaped to [U+FE0F] (reporting droppedChars === 0),
// permitting history compression under coding-safe lossless requirements.
function historyWithVariationSelector(): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 24; index += 1) {
    const marker = index === 2 ? '\ufe0f' : '';
    const text = `turn-${index} ${marker} ` + 'archival context '.repeat(500);
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: text });
  }
  return messages;
}

// Internal slot marker U+0003 is exempt from escaping (to preserve slot/text alignment)
// and absent from the font atlas, making it an unrecoverable renderer condition.
function historyWithUnrecoverableMarker(): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 24; index += 1) {
    const marker = index === 2 ? '\u0003' : '';
    const text = `turn-${index} ${marker} ` + 'archival context '.repeat(500);
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: text });
  }
  return messages;
}

function body(messages: Message[]): Uint8Array {
  return enc.encode(JSON.stringify({
    model: 'claude-fable-5',
    max_tokens: 16,
    messages,
  }));
}

describe('lossless safe-render guard', () => {
  it('marks coding-safe and balanced as renderer-loss-intolerant', () => {
    expect(resolveCompressionProfile('coding-safe').transform.requireLosslessRender).toBe(true);
    expect(resolveCompressionProfile('balanced').transform.requireLosslessRender).toBe(true);
    expect(resolveCompressionProfile('aggressive').transform.requireLosslessRender).not.toBe(true);
    expect(resolveCompressionProfile('coding-safe').transform.compressToolResults).toBe(false);
    expect(resolveCompressionProfile('balanced').transform.compressToolResults).toBe(false);
  });

  it('successfully collapses history containing U+FE0F with zero dropped chars when requireLosslessRender is true', async () => {
    const messages = historyWithVariationSelector();
    const result = await transformRequest(body(messages), {
      model: 'claude-fable-5',
      compress: true,
      compressTools: false,
      compressToolResults: false,
      minCompressChars: Number.MAX_SAFE_INTEGER,
      collapseHistory: true,
      charsPerToken: 1,
      historyAmortizationHorizon: 1,
      requireLosslessRender: true,
    });

    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.droppedChars ?? 0).toBe(0);
  });

  it('keeps the original archival history native when the renderer reports a dropped codepoint', async () => {
    const messages = historyWithUnrecoverableMarker();
    const result = await transformRequest(body(messages), {
      model: 'claude-fable-5',
      compress: true,
      compressTools: false,
      compressToolResults: false,
      minCompressChars: Number.MAX_SAFE_INTEGER,
      collapseHistory: true,
      charsPerToken: 1,
      historyAmortizationHorizon: 1,
      requireLosslessRender: true,
    });

    expect(result.info.historyReason).toBe('render_lossy');
    expect(result.info.imageCount).toBe(0);
    expect(result.info.droppedChars ?? 0).toBeGreaterThan(0);
    const outgoing = JSON.parse(dec.decode(result.body)) as { messages: Message[] };
    expect(outgoing.messages).toEqual(messages);
  });

  it('retains the old lossy behavior only when lossless enforcement is explicitly disabled', async () => {
    const messages = historyWithUnrecoverableMarker();
    const result = await transformRequest(body(messages), {
      model: 'claude-fable-5',
      compress: true,
      compressTools: false,
      compressToolResults: false,
      minCompressChars: Number.MAX_SAFE_INTEGER,
      collapseHistory: true,
      charsPerToken: 1,
      historyAmortizationHorizon: 1,
      requireLosslessRender: false,
    });

    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.droppedChars ?? 0).toBeGreaterThan(0);
  });
});
