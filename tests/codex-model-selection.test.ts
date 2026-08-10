import { describe, expect, it } from 'vitest';

import { buildCodexCommandArgs } from '../src/core/codex.js';
import {
  codexModelFromArgs,
  codexProfileFromArgs,
  resolveCodexModelSelection,
} from '../src/core/codex-model.js';

const REFERENCE = 'gpt-5.6-sol';

describe('Codex model selection diagnostics', () => {
  it('uses an explicit --model/-m before every config source', () => {
    const config = 'model = "gpt-5.6-sol"\n';
    expect(resolveCodexModelSelection(['--model', 'gpt-5.6-terra'], config, REFERENCE))
      .toEqual({ model: 'gpt-5.6-terra', source: 'cli' });
    expect(resolveCodexModelSelection(['-m', 'gpt-5.6-luna'], config, REFERENCE))
      .toEqual({ model: 'gpt-5.6-luna', source: 'cli' });
  });

  it('understands Codex -c/--config model overrides', () => {
    expect(codexModelFromArgs(['exec', '-c', 'model="gpt-5.6-sol"', 'task']))
      .toBe('gpt-5.6-sol');
    expect(codexModelFromArgs(['--config=model=gpt-5.6-terra']))
      .toBe('gpt-5.6-terra');
    expect(codexModelFromArgs(['-c=model=gpt-5.6-luna']))
      .toBe('gpt-5.6-luna');
  });

  it('uses the top-level configured model when no CLI model is present', () => {
    const config = [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/tmp/work"]',
      'trust_level = "trusted"',
    ].join('\n');
    expect(resolveCodexModelSelection(['exec', 'task'], config, REFERENCE))
      .toEqual({ model: 'gpt-5.6-sol', source: 'config' });
  });

  it('resolves the explicitly selected Codex profile model', () => {
    const config = [
      'model = "gpt-5.6-sol"',
      '',
      '[profiles.fast]',
      'model = "gpt-5.6-terra"',
      '',
      '[profiles.safe]',
      'model = "gpt-5.6-sol"',
    ].join('\n');
    expect(codexProfileFromArgs(['-p', 'fast'])).toBe('fast');
    expect(resolveCodexModelSelection(['--profile=fast', 'exec', 'task'], config, REFERENCE))
      .toEqual({ model: 'gpt-5.6-terra', source: 'profile', profile: 'fast' });
  });

  it('honors a default profile declared in config', () => {
    const config = [
      'profile = "safe"',
      'model = "gpt-5.6-terra"',
      '',
      '[profiles.safe]',
      'model = "gpt-5.6-sol"',
    ].join('\n');
    expect(resolveCodexModelSelection([], config, REFERENCE))
      .toEqual({ model: 'gpt-5.6-sol', source: 'profile', profile: 'safe' });
  });

  it('does not mistake nested unrelated model keys for the top-level Codex model', () => {
    const config = [
      '[model_providers.somewhere]',
      'model = "should-not-win"',
      '',
      '[projects."/tmp/work"]',
      'model = "also-not-top-level"',
    ].join('\n');
    expect(resolveCodexModelSelection([], config, REFERENCE))
      .toEqual({ model: REFERENCE, source: 'reference' });
  });

  it('falls back diagnostically when config is absent or malformed', () => {
    expect(resolveCodexModelSelection([], undefined, REFERENCE))
      .toEqual({ model: REFERENCE, source: 'reference' });
    expect(resolveCodexModelSelection([], 'model = "unterminated', REFERENCE))
      .toEqual({ model: REFERENCE, source: 'reference' });
  });
});

describe('routed Codex model pinning', () => {
  it('pins a resolved persistent config model before user args', () => {
    const args = buildCodexCommandArgs(
      'http://127.0.0.1:47821/providers/codex',
      ['exec', 'task'],
      'gpt-5.6-sol',
    );
    const providerSelect = args.indexOf('model_provider=pxpipe');
    const modelPin = args.indexOf('model=gpt-5.6-sol');
    const exec = args.indexOf('exec');
    expect(providerSelect).toBeGreaterThan(-1);
    expect(modelPin).toBeGreaterThan(providerSelect);
    expect(exec).toBeGreaterThan(modelPin);
    expect(args[modelPin - 1]).toBe('-c');
  });

  it('does not inject a reference model when no persistent model was resolved', () => {
    const args = buildCodexCommandArgs(
      'http://127.0.0.1:47821/providers/codex',
      ['exec', 'task'],
    );
    expect(args).not.toContain('model=gpt-5.6-sol');
  });

  it('keeps explicit user model arguments last so Codex retains normal precedence', () => {
    const args = buildCodexCommandArgs(
      'http://127.0.0.1:47821/providers/codex',
      ['-m', 'gpt-5.6-terra', 'exec', 'task'],
      'gpt-5.6-sol',
    );
    const modelPin = args.indexOf('model=gpt-5.6-sol');
    const explicitModel = args.indexOf('gpt-5.6-terra');
    expect(explicitModel).toBeGreaterThan(modelPin);
  });
});
