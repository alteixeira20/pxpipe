import { describe, expect, it } from 'vitest';
import { parseAgyModelsOutput } from '../src/agy-models.js';

describe('AGY human model-list headings', () => {
  it('does not turn GPT-OSS family headings into phantom models', () => {
    expect(parseAgyModelsOutput(`
      GPT-OSS
      gpt-oss-120b-medium
      Gemini
      gemini-3.6-flash-high
    `)).toEqual([
      'gpt-oss-120b-medium',
      'gemini-3.6-flash-high',
    ]);
  });

  it('still accepts plausible unknown versioned or namespaced one-token ids', () => {
    expect(parseAgyModelsOutput('vendor/model-v2\ncustom.2026\n')).toEqual([
      'vendor/model-v2',
      'custom.2026',
    ]);
  });
});
