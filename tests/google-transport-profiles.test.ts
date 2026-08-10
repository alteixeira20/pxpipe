import { describe, expect, it } from 'vitest';
import {
  googleTransportVisionTokens,
  resolveGoogleTransportProfile,
} from '../src/core/google-transport-profiles.js';
import { CLAUDE_LEGACY_PROFILE } from '../src/core/claude-model-profiles.js';
import { GEMINI_3_6_FLASH_PROFILE } from '../src/core/gemini-model-profiles.js';
import { isPxpipeSupportedModel } from '../src/core/applicability.js';
import { transformAntigravityGenerateContent } from '../src/core/antigravity.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';

describe('Google transport profiles resolution and vision tokens', () => {
  describe('P0 & P1 — Profile resolution vs Coding-safe admission independence', () => {
    it.each([
      ['gemini-3.6-flash-high', true, true],
      ['gemini-3.6-flash-medium', true, true],
      ['gemini-3.6-flash-low', true, true],
      ['claude-opus-4-6-thinking', true, false],
      ['claude-sonnet-4-6', true, false],
      ['gemini-3.5-flash-high', false, false],
      ['gemini-3.1-pro-high', false, false],
      ['gpt-oss-120b-medium', false, false],
      ['unknown-model', false, false],
    ])(
      'for model %s: profileKnown=%s, codingSafeAdmitted=%s',
      (model, expectedProfileKnown, expectedCodingSafe) => {
        const hasProfile = resolveGoogleTransportProfile(model) !== null;
        const isAdmitted = isPxpipeSupportedModel(model);
        expect(hasProfile).toBe(expectedProfileKnown);
        expect(isAdmitted).toBe(expectedCodingSafe);
      },
    );
  });

  describe('resolveGoogleTransportProfile', () => {
    it.each([
      ['gemini-3.6-flash', GEMINI_3_6_FLASH_PROFILE],
      ['gemini-3.6-flash-high', GEMINI_3_6_FLASH_PROFILE],
      ['gemini-3.6-flash-medium', GEMINI_3_6_FLASH_PROFILE],
      ['gemini-3.6-flash-low', GEMINI_3_6_FLASH_PROFILE],
      ['google/gemini-3.6-flash-high', GEMINI_3_6_FLASH_PROFILE],
    ])('resolves %s to GEMINI_3_6_FLASH_PROFILE', (model, expectedProfile) => {
      expect(resolveGoogleTransportProfile(model)).toEqual(expectedProfile);
    });

    it.each([
      ['claude-opus-4-6-thinking', CLAUDE_LEGACY_PROFILE],
      ['claude-sonnet-4-6', CLAUDE_LEGACY_PROFILE],
      ['anthropic/claude-opus-4-6-thinking', CLAUDE_LEGACY_PROFILE],
    ])('resolves %s to CLAUDE_LEGACY_PROFILE', (model, expectedProfile) => {
      expect(resolveGoogleTransportProfile(model)).toEqual(expectedProfile);
    });

    it.each([
      ['gemini-3.5-flash-high'],
      ['gemini-3.5-flash-medium'],
      ['gemini-3.5-flash-low'],
      ['gemini-3.1-pro-high'],
      ['gemini-3.1-pro-low'],
      ['gpt-oss-120b-medium'],
      ['unknown-model'],
      [null],
      [undefined],
    ])('returns null for unvalidated or unknown model %s', (model) => {
      expect(resolveGoogleTransportProfile(model)).toBeNull();
    });
  });

  describe('googleTransportVisionTokens', () => {
    it('calculates vision tokens for Gemini 3.6 Flash effort aliases', () => {
      expect(googleTransportVisionTokens('gemini-3.6-flash-high', 1568, 728)).toBe(1078);
      expect(googleTransportVisionTokens('gemini-3.6-flash-low', 1568, 728)).toBe(1078);
    });

    it('calculates vision tokens for AGY Claude models using legacy profile economics', () => {
      expect(googleTransportVisionTokens('claude-opus-4-6-thinking', 1568, 728)).toBe(1456);
      expect(googleTransportVisionTokens('claude-sonnet-4-6', 1568, 728)).toBe(1456);
    });

    it('throws for unvalidated model on Google transport', () => {
      expect(() => googleTransportVisionTokens('gpt-oss-120b-medium', 1568, 728)).toThrow(
        /Unsupported Google-transport image-token estimate/,
      );
    });
  });

  describe('P2 — Deterministic Gemini 3.6 Flash High history collapse proof', () => {
    it('compresses profitable eligible history for gemini-3.6-flash-high', async () => {
      const contents: Array<Record<string, unknown>> = [];
      // The history gate is deliberately economic, not merely a unit-count gate.
      // Give the fixture enough archival prose that the Gemini image + native
      // framing cost is provably below the plain-text baseline on every CI node.
      for (let i = 0; i < 15; i++) {
        contents.push({
          role: 'user',
          parts: [{
            text: `User request turn ${i}: inspect src/core/google.ts line ${100 + i}. `
              + `Archived request context ${i}. `.repeat(50),
          }],
        });
        contents.push({
          role: 'model',
          parts: [{
            text: `Model response turn ${i}: inspection completed. `
              + `Archived analysis and findings ${i}. `.repeat(70),
          }],
        });
      }
      contents.push({
        role: 'user',
        parts: [{ text: 'User current live request: summarize findings so far.' }],
      });

      const body = {
        systemInstruction: {
          parts: [{ text: 'System instruction: You are Antigravity coding assistant.' }],
        },
        contents,
      };

      const inputBytes = new TextEncoder().encode(JSON.stringify(body));
      const res = await transformGoogleGenerateContent(inputBytes, 'gemini-3.6-flash-high', {
        googleHistory: { keepTail: 2, minCollapseUnits: 4, minCollapseTokens: 100 },
        googleMaxImageToTextRatio: 0.8,
        requireLosslessRender: true,
      });

      expect(res.info.compressed).toBe(true);
      expect(res.info.historyReason).toBe('collapsed');
      expect(res.info.imageCount).toBeGreaterThan(0);
      expect(res.info.droppedChars ?? 0).toBe(0);
      expect(res.info.baselineImagedTokens ?? 0).toBeGreaterThan(res.info.imageTokens ?? 0);
    });
  });

  describe('P4 — Provider Wire Transport Integrity', () => {
    it('preserves Google GenerateContent format for claude-opus-4-6-thinking without misrouting', async () => {
      const payload = {
        model: 'claude-opus-4-6-thinking',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Hello from AGY' }] }],
        },
      };
      const inputBytes = new TextEncoder().encode(JSON.stringify(payload));
      const res = await transformAntigravityGenerateContent(inputBytes, { compress: false });
      expect(res.info.reason).toBe('compression_disabled');
      const decoded = JSON.parse(new TextDecoder().decode(res.body));
      expect(decoded.model).toBe('claude-opus-4-6-thinking');
      expect(decoded.request.contents).toBeDefined();
    });
  });
});
