from pathlib import Path

transform = Path('src/core/transform.ts')
text = transform.read_text()

old = "  /** Caller fidelity hint: return `true` for a block that must stay as text (IDs,\n"
new = """  /** When true, any renderer-known character loss makes the candidate ineligible.
   *  Safe profiles use this for archival history so invisible/unsupported codepoints
   *  never disappear merely because the image path was otherwise profitable. */
  requireLosslessRender?: boolean;
  /** Caller fidelity hint: return `true` for a block that must stay as text (IDs,
"""
if old not in text:
    raise SystemExit('TransformOptions insertion point not found')
text = text.replace(old, new, 1)

old = "  reflow: true,\n  keepSharp: () => false,\n"
new = "  reflow: true,\n  requireLosslessRender: false,\n  keepSharp: () => false,\n"
if old not in text:
    raise SystemExit('DEFAULTS insertion point not found')
text = text.replace(old, new, 1)

old = "    | 'over_budget'\n    | 'collapsed';\n"
new = "    | 'over_budget'\n    | 'render_lossy'\n    | 'collapsed';\n"
if old not in text:
    raise SystemExit('historyReason union insertion point not found')
text = text.replace(old, new, 1)

old = """    recordFreezeStep(info.firstUserSha8, histInfo.freezeStep);
    if (histInfo.freezeStep !== undefined) info.historyFreezeStep = histInfo.freezeStep;
    if (histInfo.budgetTrimmed) info.historyBudgetTrimmed = true;
    if (tuning.packFill) info.historyPackFill = true;
    if (histInfo.collapsedTurns > 0) {
"""
new = """    const renderLossy = o.requireLosslessRender && histInfo.droppedChars > 0;
    if (!renderLossy) {
      recordFreezeStep(info.firstUserSha8, histInfo.freezeStep);
      if (histInfo.freezeStep !== undefined) info.historyFreezeStep = histInfo.freezeStep;
      if (histInfo.budgetTrimmed) info.historyBudgetTrimmed = true;
      if (tuning.packFill) info.historyPackFill = true;
    }
    if (renderLossy) {
      info.historyReason = 'render_lossy';
      info.droppedChars = (info.droppedChars ?? 0) + histInfo.droppedChars;
      for (const [cp, n] of histInfo.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
      }
    } else if (histInfo.collapsedTurns > 0) {
"""
count = text.count(old)
if count != 2:
    raise SystemExit(f'expected 2 history finalization blocks, found {count}')
transform.write_text(text.replace(old, new))

policy = Path('src/core/safety-policy.ts')
text = policy.read_text()
old = "      historyAmortizationHorizon: 4,\n      reflow: true,\n"
new = "      historyAmortizationHorizon: 4,\n      reflow: true,\n      requireLosslessRender: true,\n"
if old not in text:
    raise SystemExit('coding-safe insertion point not found')
text = text.replace(old, new, 1)
old = "      historyAmortizationHorizon: 3,\n      reflow: true,\n"
new = "      historyAmortizationHorizon: 3,\n      reflow: true,\n      requireLosslessRender: true,\n"
if old not in text:
    raise SystemExit('balanced insertion point not found')
policy.write_text(text.replace(old, new, 1))

Path('tests/lossless-safe-render.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resolveCompressionProfile } from '../src/core/safety-policy.js';
import type { Message } from '../src/core/types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function historyWithVariationSelector(): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 24; index += 1) {
    const marker = index === 2 ? '\ufe0f' : '';
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

  it('keeps the original archival history native when the renderer reports a dropped codepoint', async () => {
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

    expect(result.info.historyReason).toBe('render_lossy');
    expect(result.info.imageCount).toBe(0);
    expect(result.info.droppedChars ?? 0).toBeGreaterThan(0);
    const outgoing = JSON.parse(dec.decode(result.body)) as { messages: Message[] };
    expect(outgoing.messages).toEqual(messages);
  });

  it('retains the old lossy behavior only when lossless enforcement is explicitly disabled', async () => {
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
      requireLosslessRender: false,
    });

    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.droppedChars ?? 0).toBeGreaterThan(0);
  });
});
''')
