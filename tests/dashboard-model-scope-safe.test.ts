import { afterEach, describe, expect, it } from 'vitest';
import { DashboardState } from '../src/dashboard.js';
import {
  getAllowedModelBases,
  getRequestedModelBases,
  setAllowedModelBases,
  setCompressionSafetyScope,
} from '../src/core/applicability.js';

const originalModels = process.env.PXPIPE_MODELS;

afterEach(() => {
  setAllowedModelBases(null);
  setCompressionSafetyScope(null);
  if (originalModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = originalModels;
});

describe('dashboard model scope under coding-safe', () => {
  it('activates validated Gemini and preserves configured-but-blocked experimental models', async () => {
    delete process.env.PXPIPE_MODELS;
    setCompressionSafetyScope('coding-safe');
    setAllowedModelBases(null);
    const saved = [];
    const dash = new DashboardState(undefined, async () => new Map(), (bases) => saved.push([...bases]));

    expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);
    dash.handleModelsToggle('gpt-5.5', true);
    expect(getRequestedModelBases()).toContain('gpt-5.5');
    expect(getAllowedModelBases()).not.toContain('gpt-5.5');

    const html = await (await dash.serveFragment('models', new URL('http://localhost/fragments/models'), 47821)).text();
    expect(html).toContain('Gemini 3.6 Flash ✓');
    expect(html).toContain('GPT 5.5 · configured');
    expect(html).toContain('claude-fable-5,gemini-3.6-flash,gpt-5.5');

    dash.handleModelsToggle('gpt-5.5', false);
    expect(getRequestedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);
    expect(saved.at(-1)).toEqual(['claude-fable-5', 'gemini-3.6-flash']);
  });
});
