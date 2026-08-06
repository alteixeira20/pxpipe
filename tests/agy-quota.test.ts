import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isAgyNonModelInvocation,
  parseAgyDoctorOptions,
  withAgyCompoundReset,
} from '../src/agy-entry.js';
import {
  agyAuthContextDigest,
  clearAgyCooldown,
  extractAgyModel,
  parseAgyResetDurationSeconds,
  readAgyCooldown,
  removeLegacyAgyCooldown,
  writeAgyCooldownForModel,
} from '../src/agy-quota.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pxpipe-agy-quota-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('AGY reset-duration parsing', () => {
  it.each([
    ['Resets in 39m9s.', 2_349],
    ['retry after 1h 2m 3s', 3_723],
    ['available in 2 days 4 hours', 187_200],
    ['Individual quota reached. Resets in 54s.', 54],
  ])('parses %s', (text, seconds) => {
    expect(parseAgyResetDurationSeconds(text)).toBe(seconds);
  });

  it('does not invent a duration', () => {
    expect(parseAgyResetDurationSeconds('quota exhausted')).toBeUndefined();
  });

  it('overrides the legacy single-component parser result', () => {
    expect(withAgyCompoundReset({
      kind: 'quota_exhausted',
      safeMessage: 'AGY quota is exhausted.',
      resetAfterSeconds: 2_340,
    }, '', 'Resets in 39m9s.')).toEqual({
      kind: 'quota_exhausted',
      safeMessage: 'AGY quota is exhausted.',
      resetAfterSeconds: 2_349,
    });
  });
});

describe('AGY model selection', () => {
  it('extracts separate and inline model options with last value winning', () => {
    expect(extractAgyModel([
      '--model', 'gemini-3.6-flash-low',
      '--model=gemini-3.6-flash-high',
      '--print', 'OK',
    ])).toBe('gemini-3.6-flash-high');
  });

  it('recognizes non-model commands so cooldowns do not block diagnostics', () => {
    expect(isAgyNonModelInvocation(['--version'])).toBe(true);
    expect(isAgyNonModelInvocation(['models'])).toBe(true);
    expect(isAgyNonModelInvocation(['plugin', 'list'])).toBe(true);
    expect(isAgyNonModelInvocation(['--model', 'gemini-3.6-flash-high', '--print', 'OK'])).toBe(false);
  });
});

describe('model-aware AGY doctor options', () => {
  it('accepts explicit model selection in both forms', () => {
    expect(parseAgyDoctorOptions([
      '--model', 'gemini-3.6-flash-high', '--live', '--json',
    ])).toEqual({
      model: 'gemini-3.6-flash-high',
      live: true,
      json: true,
    });
    expect(parseAgyDoctorOptions([
      '--model=gemini-3.6-flash-medium', '--json',
    ])).toEqual({
      model: 'gemini-3.6-flash-medium',
      live: false,
      json: true,
    });
  });

  it('requires a model for a billable live check', () => {
    expect(() => parseAgyDoctorOptions(['--live'])).toThrow(/requires --model/);
  });
});

describe('model-scoped AGY cooldown store', () => {
  it('blocks only the affected model and keeps credentials out of the file', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'agy-cooldowns.json');
    const env = {
      HOME: directory,
      AGY_PROFILE: 'private-user@example.test',
      AGY_PROJECT: 'secret-project',
    };

    writeAgyCooldownForModel({
      kind: 'quota_exhausted',
      safeMessage: 'AGY quota is exhausted.',
      resetAfterSeconds: 2_349,
    }, 'claude-sonnet-4-6', { path, env, now: 10_000 });

    expect(readAgyCooldown('claude-sonnet-4-6', { path, env, now: 10_100 })).toMatchObject({
      model: 'claude-sonnet-4-6',
      failure: 'quota_exhausted',
      resetAfterSeconds: 2_349,
    });
    expect(readAgyCooldown('gemini-3.6-flash-high', { path, env, now: 10_100 })).toBeNull();

    const stored = readFileSync(path, 'utf8');
    expect(stored).not.toContain('private-user');
    expect(stored).not.toContain('secret-project');
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('applies authentication failures across models but rate limits per model', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'cooldowns.json');
    const env = { HOME: directory };

    writeAgyCooldownForModel({
      kind: 'not_authenticated',
      safeMessage: 'Authentication unavailable.',
    }, 'claude-sonnet-4-6', { path, env, now: 1_000 });
    expect(readAgyCooldown('gemini-3.6-flash-high', { path, env, now: 1_001 })?.failure)
      .toBe('not_authenticated');

    clearAgyCooldown('gemini-3.6-flash-high', { path, env, now: 1_002 });
    expect(readAgyCooldown('claude-sonnet-4-6', { path, env, now: 1_003 })).toBeNull();

    writeAgyCooldownForModel({
      kind: 'rate_limited',
      safeMessage: 'Rate limited.',
      resetAfterSeconds: 60,
    }, 'claude-sonnet-4-6', { path, env, now: 2_000 });
    expect(readAgyCooldown('gemini-3.6-flash-high', { path, env, now: 2_001 })).toBeNull();
  });

  it('isolates different authentication contexts', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'cooldowns.json');
    const first = { HOME: directory, AGY_PROFILE: 'one' };
    const second = { HOME: directory, AGY_PROFILE: 'two' };

    expect(agyAuthContextDigest(first)).not.toBe(agyAuthContextDigest(second));
    writeAgyCooldownForModel({
      kind: 'quota_exhausted',
      safeMessage: 'Quota exhausted.',
    }, 'claude-sonnet-4-6', { path, env: first, now: 1_000 });

    expect(readAgyCooldown('claude-sonnet-4-6', { path, env: first, now: 1_001 })).not.toBeNull();
    expect(readAgyCooldown('claude-sonnet-4-6', { path, env: second, now: 1_001 })).toBeNull();
  });

  it('removes the unsafe legacy global cooldown file', () => {
    const directory = temporaryDirectory();
    const legacy = join(directory, 'agy-cooldown.json');
    writeFileSync(legacy, '{"failure":"quota_exhausted"}\n');
    chmodSync(legacy, 0o600);

    expect(removeLegacyAgyCooldown(legacy)).toBe(true);
    expect(removeLegacyAgyCooldown(legacy)).toBe(false);
  });
});
