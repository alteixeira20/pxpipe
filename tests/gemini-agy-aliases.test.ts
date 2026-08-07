import { describe, expect, it } from 'vitest';
import {
  canonicalGeminiModel,
  geminiVisionTokens,
  isGeminiModel,
} from '../src/core/gemini-model-profiles.js';

describe('AGY Gemini effort aliases', () => {
  it.each([
    'gemini-3.6-flash',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-low',
    'google/gemini-3.6-flash-high',
  ])('maps %s to the validated 3.6 Flash profile', (model) => {
    expect(canonicalGeminiModel(model)).toBe('gemini-3.6-flash');
    expect(isGeminiModel(model)).toBe(true);
    expect(geminiVisionTokens(model, 1568, 728)).toBe(1078);
  });

  it.each([
    'gemini-3.5-flash-high',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'gemini-3.6-pro-high',
  ])('keeps unvalidated family %s out of the safe image profile', (model) => {
    expect(canonicalGeminiModel(model)).toBeNull();
    expect(isGeminiModel(model)).toBe(false);
  });
});
