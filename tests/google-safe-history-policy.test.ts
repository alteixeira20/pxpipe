import { describe, expect, it } from 'vitest';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
} from '../src/core/safety-policy.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function request(turns: number, charsPerTurn: number) {
  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: 'CRITICAL: keep this system authority native. ' + 'RULE '.repeat(3000) }],
    },
    contents: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn-${i} ` + String.fromCharCode(65 + (i % 20)).repeat(charsPerTurn) }],
    })),
  };
}

describe('Google coding-safe history policy', () => {
  it('keeps authority + eight recent contents native while imaging a profitable old closed prefix', async () => {
    const original = request(12, 5000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(4);
    expect(out.info.bucketChars?.static_slab ?? 0).toBe(0);
    expect(out.info.bucketChars?.history).toBeGreaterThan(0);
    expect(out.info.imageCount).toBeGreaterThan(0);

    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);
    const tailTexts = parsed.contents.slice(-8).map((c: any) => c.parts?.[0]?.text);
    expect(tailTexts).toEqual(original.contents.slice(-8).map((c) => c.parts[0]!.text));
  });

  it('does not image a fresh one-turn coding-safe request and explains the lack of old history', async () => {
    const original = request(1, 1000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(false);
    expect(out.info.historyReason).toBe('no_history');
    expect(dec.decode(out.body)).toBe(JSON.stringify(original));
  });

  it('balanced keeps six recent contents native but can collapse two sufficiently large old units', async () => {
    const original = request(8, 6500);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('balanced'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(2);
    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);
    expect(parsed.contents.slice(-6).map((c: any) => c.parts?.[0]?.text)).toEqual(
      original.contents.slice(-6).map((c) => c.parts[0]!.text),
    );
  });
});
