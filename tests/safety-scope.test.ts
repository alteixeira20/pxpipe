import { afterEach, describe, expect, it } from 'vitest';
import {
  getAllowedModelBases,
  isPxpipeSupportedGptModel,
  isPxpipeSupportedModel,
  setAllowedModelBases,
  setCompressionSafetyScope,
} from '../src/core/applicability.js';

const originalProfile = process.env.PXPIPE_PROFILE;
const originalModels = process.env.PXPIPE_MODELS;

afterEach(() => {
  setAllowedModelBases(null);
  setCompressionSafetyScope(null);
  if (originalProfile === undefined) delete process.env.PXPIPE_PROFILE;
  else process.env.PXPIPE_PROFILE = originalProfile;
  if (originalModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = originalModels;
});

describe('semantic safety scope gates model families', () => {
  it('safe profiles cannot be weakened by a runtime model toggle', () => {
    setCompressionSafetyScope('coding-safe');
    setAllowedModelBases([
      'claude-fable-5',
      'gemini-3.6-flash',
      'gpt-5.6-sol',
      'moonshotai/kimi-k3',
    ]);

    expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);
    expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
    expect(isPxpipeSupportedModel('gemini-3.6-flash')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);
  });

  it('balanced preserves the same validated model boundary', () => {
    setCompressionSafetyScope('balanced');
    setAllowedModelBases(['claude-fable-5', 'gemini-3.6-flash']);
    expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);
  });

  it('aggressive allows explicit experimental model opt-ins', () => {
    setCompressionSafetyScope('aggressive');
    setAllowedModelBases(['gemini-3.6-flash', 'gpt-5.6-sol']);
    expect(getAllowedModelBases()).toEqual(['gemini-3.6-flash', 'gpt-5.6-sol']);
    expect(isPxpipeSupportedModel('gemini-3.6-flash')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(true);
  });

  it('passthrough blocks all transformation regardless of the model list', () => {
    setCompressionSafetyScope('passthrough');
    setAllowedModelBases(['claude-fable-5']);
    expect(getAllowedModelBases()).toEqual([]);
    expect(isPxpipeSupportedModel('claude-fable-5')).toBe(false);
  });

  it('Node derives aggressive scope from PXPIPE_PROFILE when no host override is installed', () => {
    setCompressionSafetyScope(null);
    setAllowedModelBases(null);
    process.env.PXPIPE_PROFILE = 'aggressive';
    process.env.PXPIPE_MODELS = 'gemini-3.6-flash';
    expect(getAllowedModelBases()).toEqual(['gemini-3.6-flash']);
  });

  it('unknown profile values fail closed during applicability checks', () => {
    setCompressionSafetyScope(null);
    setAllowedModelBases(null);
    process.env.PXPIPE_PROFILE = 'mystery';
    process.env.PXPIPE_MODELS = 'claude-fable-5';
    expect(getAllowedModelBases()).toEqual([]);
  });
});
