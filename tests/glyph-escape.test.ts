/**
 * tests/glyph-escape.test.ts
 *
 * Atlas-miss escaping: emoji, variation selectors, ZWJ, combining marks, zero-width format
 * codepoints, and other unrenderable source Unicode are preserved as ASCII `[U+HEX]`
 * escapes instead of blank cells.
 *
 * CONTRACT:
 *   • escapeMissingGlyphs is pure, idempotent, and lossless for non-exempt misses (hex payload → codepoint)
 *   • rendering text containing source Unicode (including U+FE0F, ZWJ, combining marks, zero-width)
 *     yields droppedChars === 0 on both 1-bit and AA (production dense) paths
 *   • internal slot markers (C0 controls 0x01–0x03) remain exempt from escaping to preserve
 *     slot-string width alignment and role coloring
 *   • glyph-availability checks respect font selection (default spleen-5x8 and JetBrains Mono)
 *     and fallback atlases
 */

import { describe, expect, it } from 'vitest';
import {
  escapeMissingGlyphs,
  hasGlyph,
  GLYPH_ESCAPE_OPEN,
  GLYPH_ESCAPE_CLOSE,
  renderChunkToPng,
  wrapLines,
  measureContentCols,
  roleSlotSegment,
  DENSE_RENDER_STYLE,
  SLOT_MARK_USER,
  SLOT_MARK_ASSISTANT,
  SLOT_NEUTRAL,
  type RenderFont,
} from '../src/core/render.js';

// ---------------------------------------------------------------------------
// 1. escapeMissingGlyphs unit contract
// ---------------------------------------------------------------------------

describe('escapeMissingGlyphs', () => {
  it('escapes an astral emoji as [U+HEX]', () => {
    expect(escapeMissingGlyphs('a\u{1F525}b')).toBe(
      `a${GLYPH_ESCAPE_OPEN}1F525${GLYPH_ESCAPE_CLOSE}b`,
    );
  });

  it('escapes U+FE0F and variation selectors as [U+HEX]', () => {
    expect(escapeMissingGlyphs('❤️')).toBe(
      `❤${GLYPH_ESCAPE_OPEN}FE0F${GLYPH_ESCAPE_CLOSE}`,
    );
    expect(escapeMissingGlyphs('text\ufe00')).toBe(
      `text${GLYPH_ESCAPE_OPEN}FE00${GLYPH_ESCAPE_CLOSE}`,
    );
  });

  it('escapes ZWJ emoji sequences as [U+HEX]', () => {
    // 👨‍👩‍👧 = U+1F468 U+200D U+1F469 U+200D U+1F467
    const seq = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const escaped = escapeMissingGlyphs(seq);
    expect(escaped).toContain(`${GLYPH_ESCAPE_OPEN}200D${GLYPH_ESCAPE_CLOSE}`);
    expect(escaped).toContain(`${GLYPH_ESCAPE_OPEN}1F468${GLYPH_ESCAPE_CLOSE}`);
  });

  it('escapes combining-mark sequences as [U+HEX]', () => {
    // e + combining diaeresis U+0308
    expect(escapeMissingGlyphs('e\u0308')).toBe(
      `e${GLYPH_ESCAPE_OPEN}308${GLYPH_ESCAPE_CLOSE}`,
    );
  });

  it('escapes zero-width format codepoints (U+200B, U+200C, U+2060, U+FEFF) as [U+HEX]', () => {
    expect(escapeMissingGlyphs('a\u200Bb\u200Cc\u2060d\uFEFFe')).toBe(
      `a${GLYPH_ESCAPE_OPEN}200B${GLYPH_ESCAPE_CLOSE}b${GLYPH_ESCAPE_OPEN}200C${GLYPH_ESCAPE_CLOSE}c${GLYPH_ESCAPE_OPEN}2060${GLYPH_ESCAPE_CLOSE}d${GLYPH_ESCAPE_OPEN}FEFF${GLYPH_ESCAPE_CLOSE}e`,
    );
  });

  it('fast path: returns the SAME reference when nothing misses', () => {
    const s = 'plain ascii — no atlas misses, incl. ↵ and CJK 漢字';
    expect(escapeMissingGlyphs(s)).toBe(s);
  });

  it('is idempotent (escape output contains only atlas-present chars)', () => {
    const complex = '❤️‍🔥 e\u0308 \u200B \u{1F680}';
    const once = escapeMissingGlyphs(complex);
    const twice = escapeMissingGlyphs(once);
    expect(twice).toBe(once);
  });

  it('is lossless: hex payload round-trips to the source codepoint', () => {
    const escaped = escapeMissingGlyphs('\u{1F680}');
    const m = /\[U\+([0-9A-F]+)\]/.exec(escaped);
    expect(m).not.toBeNull();
    expect(String.fromCodePoint(parseInt(m![1]!, 16))).toBe('\u{1F680}');
  });

  it('escapes every miss in a multi-emoji line, preserving order', () => {
    expect(escapeMissingGlyphs('\u{1F525}x\u{1F680}')).toBe(
      `${GLYPH_ESCAPE_OPEN}1F525${GLYPH_ESCAPE_CLOSE}x${GLYPH_ESCAPE_OPEN}1F680${GLYPH_ESCAPE_CLOSE}`,
    );
  });

  it('leaves internal C0 slot markers untouched (SLOT_MARK_USER, SLOT_MARK_ASSISTANT, SLOT_NEUTRAL)', () => {
    const s = SLOT_MARK_USER + SLOT_MARK_ASSISTANT + SLOT_NEUTRAL;
    expect(escapeMissingGlyphs(s)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// 2. Font atlas availability and fallback consistency
// ---------------------------------------------------------------------------

describe('font-aware glyph availability and escaping', () => {
  const fonts: RenderFont[] = [
    'spleen-5x8',
    'jetbrains-mono-10',
    'jetbrains-mono-12',
    'jetbrains-mono-14',
  ];

  it('hasGlyph reports true for standard ASCII across all supported render fonts', () => {
    for (const font of fonts) {
      expect(hasGlyph(0x41, font, false)).toBe(true); // 'A'
      expect(hasGlyph(0x41, font, true)).toBe(true); // 'A' in AA
    }
  });

  it('respects selected font and AA setting during escapeMissingGlyphs', () => {
    for (const font of fonts) {
      const escapedBit = escapeMissingGlyphs('a❤️b', font, false);
      const escapedGray = escapeMissingGlyphs('a❤️b', font, true);
      expect(escapedBit).toContain('[U+FE0F]');
      expect(escapedGray).toContain('[U+FE0F]');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Render integration: source Unicode no longer drops
// ---------------------------------------------------------------------------

describe('rendering source Unicode losslessly', () => {
  it('1-bit path: droppedChars === 0 and escape survives into wrapped lines for astral emoji', async () => {
    const text = 'deploy \u{1F680} done, fire \u{1F525} out';
    const img = await renderChunkToPng(text, 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
    expect(wrapLines(text, 80).join('')).toContain(
      `${GLYPH_ESCAPE_OPEN}1F680${GLYPH_ESCAPE_CLOSE}`,
    );
  });

  it('AA dense path (production DENSE_RENDER_STYLE): droppedChars === 0 for emoji', async () => {
    const img = await renderChunkToPng(
      'metrics \u{1F4CA} look good \u{1F389}',
      80,
      DENSE_RENDER_STYLE,
    );
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('reports droppedChars === 0 for ❤️ / U+FE0F', async () => {
    const img = await renderChunkToPng('x❤️y', 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('reports droppedChars === 0 for ZWJ emoji sequences', async () => {
    const img = await renderChunkToPng('family: 👨‍👩‍👧', 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('reports droppedChars === 0 for combining-mark sequences', async () => {
    const img = await renderChunkToPng('café with e\u0308 accent', 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('reports droppedChars === 0 for zero-width format codepoints', async () => {
    const img = await renderChunkToPng('zero\u200Bwidth\u200Cformat\u2060BOM\uFEFF', 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('reports droppedChars === 0 across default and alternate JetBrains Mono render fonts', async () => {
    const fonts: RenderFont[] = [
      'spleen-5x8',
      'jetbrains-mono-10',
      'jetbrains-mono-12',
      'jetbrains-mono-14',
    ];
    const source = '❤️ 👨‍👩‍👧 e\u0308 \u200B \u{1F680}';

    for (const font of fonts) {
      const bitImg = await renderChunkToPng(source, 80, { font, aa: false });
      const grayImg = await renderChunkToPng(source, 80, { font, aa: true });
      expect(bitImg.droppedChars).toBe(0);
      expect(grayImg.droppedChars).toBe(0);
    }
  });

  it('measureContentCols sees the ESCAPED width, matching what wrapLines lays out', () => {
    const text = '\u{1F525}'; // 1 source cell naively; 9 cells escaped
    const measured = measureContentCols(text, 312);
    const laidOut = wrapLines(text, 312)[0]!.length;
    expect(measured).toBe(laidOut);
    expect(measured).toBe(9); // [U+1F525]
  });

  it('slot-string alignment: body slot copy wraps identically to text and internal markers stay aligned', () => {
    const body = 'alert \u{1F6A8} now, and again \u{1F6A8} later';
    expect(wrapLines(body, 10)).toEqual(wrapLines(body, 10));
    expect(escapeMissingGlyphs(SLOT_MARK_USER).length).toBe(1);

    const slotSeg = roleSlotSegment('user', body, SLOT_MARK_USER);
    const textSeg = `<user>\n${body}\n</user>`;
    const wrappedSlot = wrapLines(slotSeg, 20);
    const wrappedText = wrapLines(textSeg, 20);
    expect(wrappedSlot.length).toBe(wrappedText.length);
    for (let i = 0; i < wrappedText.length; i++) {
      expect(wrappedSlot[i]!.length).toBe(wrappedText[i]!.length);
    }
  });
});
