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
  buildAgyModelCatalog,
  classifyAgyModel,
  discoverAgyModels,
  isAgyModelCatalogFresh,
  parseAgyModelCatalog,
  parseAgyModelsOutput,
  parseAgyModelsStreams,
} from '../src/agy-models.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pxpipe-agy-models-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('AGY model output parsing', () => {
  it('deduplicates model ids and ignores headings or unsafe lines', () => {
    expect(parseAgyModelsOutput(`
      Available models:
      gemini-3.6-flash-high
      gemini-3.6-flash-high
      claude-sonnet-4-6
      ../../not-safe
      model with spaces
      gpt-oss-120b-medium
    `)).toEqual([
      'gemini-3.6-flash-high',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ]);
  });

  it('accepts table/bullet output and safely inspects stderr without retaining warnings', () => {
    expect(parseAgyModelsStreams(
      'Available models:\n  - gemini-3.6-flash-high  default\n',
      '\u001b[32m* claude-sonnet-4-6 available\u001b[0m\nwarning\naccount@example.test\n',
    )).toEqual([
      'gemini-3.6-flash-high',
      'claude-sonnet-4-6',
    ]);
  });

  it.each([
    ['gemini-3.6-flash-high', 'gemini', 'google', 'supported'],
    ['gemini-3.5-flash-low', 'gemini', 'google', 'experimental'],
    ['claude-opus-4-6-thinking', 'claude', 'anthropic', 'supported'],
    ['gpt-oss-120b-medium', 'openai-compatible', 'openai', 'experimental'],
    ['custom-model', 'unknown', 'unknown', 'passthrough'],
  ] as const)(
    'classifies %s conservatively',
    (id, family, protocolHint, compressionSupport) => {
      expect(classifyAgyModel(id)).toEqual({
        id,
        family,
        protocolHint,
        compressionSupport,
        evidence: 'model-id-pattern',
      });
    },
  );
});

describe('AGY model catalog validation', () => {
  const identity = {
    binaryPath: '/tmp/agy',
    binaryVersion: '1.1.10',
    binaryMtimeMs: 123,
  };

  it('invalidates on TTL, path, version and binary modification changes', () => {
    const catalog = buildAgyModelCatalog({
      ...identity,
      fetchedAt: 1_000,
      output: 'gemini-3.6-flash-high',
    });

    expect(isAgyModelCatalogFresh(catalog, identity, 1_001)).toBe(true);
    expect(isAgyModelCatalogFresh(catalog, identity, 301_000)).toBe(false);
    expect(isAgyModelCatalogFresh(catalog, { ...identity, binaryPath: '/other/agy' }, 1_001)).toBe(false);
    expect(isAgyModelCatalogFresh(catalog, { ...identity, binaryVersion: '1.1.11' }, 1_001)).toBe(false);
    expect(isAgyModelCatalogFresh(catalog, { ...identity, binaryMtimeMs: 124 }, 1_001)).toBe(false);
  });

  it('round-trips a valid cache and rejects modified descriptors', () => {
    const catalog = buildAgyModelCatalog({
      ...identity,
      fetchedAt: 1_000,
      output: 'gemini-3.6-flash-high\nclaude-sonnet-4-6',
    });

    expect(parseAgyModelCatalog(JSON.stringify(catalog))).toEqual(catalog);
    expect(parseAgyModelCatalog(JSON.stringify({
      ...catalog,
      models: [{ ...catalog.models[0], protocolHint: 'invented' }],
    }))).toBeNull();
  });
});

describe('AGY executable discovery', () => {
  it('uses the cache without repeating `agy models` and refreshes explicitly', () => {
    const directory = temporaryDirectory();
    const binary = join(directory, 'agy');
    const cachePath = join(directory, 'cache', 'agy-models.json');
    const callsPath = join(directory, 'calls.log');

    writeFileSync(binary, `#!/bin/bash
set -eu
printf '%s\\n' "$1" >> "$AGY_FAKE_CALLS"
case "$1" in
  --version)
    printf '%s\\n' '1.1.10'
    ;;
  models)
    printf '%s\\n' \\
      'gemini-3.6-flash-high' \\
      'gemini-3.6-flash-medium' \\
      'claude-sonnet-4-6' \\
      'gpt-oss-120b-medium'
    ;;
  *)
    printf '%s\\n' 'private-account@example.test' >&2
    exit 7
    ;;
esac
`);
    chmodSync(binary, 0o700);

    const env = {
      PATH: directory,
      AGY_FAKE_CALLS: callsPath,
      HOME: directory,
    };

    const first = discoverAgyModels({
      env,
      cachePath,
      now: 10_000,
    });
    const second = discoverAgyModels({
      env,
      cachePath,
      now: 10_100,
    });
    const refreshed = discoverAgyModels({
      env,
      cachePath,
      now: 10_200,
      refresh: true,
    });

    expect(first.source).toBe('agy');
    expect(second.source).toBe('cache');
    expect(refreshed.source).toBe('agy');
    expect(first.catalog.models.map((model) => model.id)).toEqual([
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ]);

    const calls = readFileSync(callsPath, 'utf8').trim().split(/\r?\n/);
    expect(calls).toEqual([
      '--version', 'models', '--version',
      '--version',
      '--version', 'models', '--version',
    ]);
    expect(statSync(cachePath).mode & 0o077).toBe(0);
    expect(readFileSync(cachePath, 'utf8')).not.toContain('example.test');
  });

  it('re-reads models when AGY updates itself during discovery', () => {
    const directory = temporaryDirectory();
    const binary = join(directory, 'agy');
    const cachePath = join(directory, 'cache', 'agy-models.json');
    const callsPath = join(directory, 'calls.log');
    const versionPath = join(directory, 'version.txt');
    writeFileSync(versionPath, '1.1.10\n');

    writeFileSync(binary, `#!/bin/bash
set -eu
printf '%s\\n' "$1" >> "$AGY_FAKE_CALLS"
case "$1" in
  --version)
    IFS= read -r current < "$AGY_FAKE_VERSION"
    printf '%s\\n' "$current"
    ;;
  models)
    IFS= read -r current < "$AGY_FAKE_VERSION"
    if [[ "$current" == '1.1.10' ]]; then
      printf '%s\\n' '1.1.11' > "$AGY_FAKE_VERSION"
      printf '%s\\n' 'gemini-3.6-flash-high' 'claude-sonnet-4-6'
    else
      printf '%s\\n' \\
        'Available models:' \\
        '  - gemini-3.6-flash-high  default' \\
        '  - claude-sonnet-4-6  available' >&2
    fi
    ;;
esac
`);
    chmodSync(binary, 0o700);

    const result = discoverAgyModels({
      env: {
        PATH: directory,
        HOME: directory,
        AGY_FAKE_CALLS: callsPath,
        AGY_FAKE_VERSION: versionPath,
      },
      cachePath,
      now: 20_000,
      refresh: true,
    });

    expect(result.source).toBe('agy');
    expect(result.stale).toBeUndefined();
    expect(result.catalog.binaryVersion).toBe('1.1.11');
    expect(result.catalog.models.map((model) => model.id)).toEqual([
      'gemini-3.6-flash-high',
      'claude-sonnet-4-6',
    ]);
    expect(readFileSync(cachePath, 'utf8')).not.toContain('Available models');
    expect(readFileSync(callsPath, 'utf8').trim().split(/\r?\n/)).toEqual([
      '--version', 'models', '--version', 'models', '--version',
    ]);
  });

  it('retains a sanitized stale catalog when a refresh temporarily fails', () => {
    const directory = temporaryDirectory();
    const binary = join(directory, 'agy');
    const cachePath = join(directory, 'cache', 'agy-models.json');
    const failPath = join(directory, 'fail');

    writeFileSync(binary, `#!/bin/bash
set -eu
case "$1" in
  --version)
    printf '%s\\n' '1.1.11'
    ;;
  models)
    if [[ -f "$AGY_FAKE_FAIL" ]]; then
      printf '%s\\n' 'private-account@example.test' >&2
      exit 7
    fi
    printf '%s\\n' 'gemini-3.6-flash-high' 'claude-sonnet-4-6'
    ;;
esac
`);
    chmodSync(binary, 0o700);

    const env = {
      PATH: directory,
      HOME: directory,
      AGY_FAKE_FAIL: failPath,
    };
    const first = discoverAgyModels({ env, cachePath, now: 30_000 });
    writeFileSync(failPath, '1');
    const fallback = discoverAgyModels({ env, cachePath, now: 30_100, refresh: true });

    expect(first.source).toBe('agy');
    expect(fallback.source).toBe('cache');
    expect(fallback.stale).toBe(true);
    expect(fallback.catalog.models.map((model) => model.id)).toEqual([
      'gemini-3.6-flash-high',
      'claude-sonnet-4-6',
    ]);
    expect(readFileSync(cachePath, 'utf8')).not.toContain('private-account');
  });

  it('fails safely without exposing AGY stderr', () => {
    const directory = temporaryDirectory();
    const binary = join(directory, 'agy');

    writeFileSync(binary, `#!/bin/bash
if [[ "$1" == '--version' ]]; then
  printf '%s\\n' 'secret-account@example.test' >&2
  exit 9
fi
exit 0
`);
    chmodSync(binary, 0o700);

    expect(() => discoverAgyModels({
      env: { PATH: directory, HOME: directory },
      cachePath: join(directory, 'cache.json'),
    })).toThrow('AGY --version exited 9');

    try {
      discoverAgyModels({
        env: { PATH: directory, HOME: directory },
        cachePath: join(directory, 'cache.json'),
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-account');
    }
  });
});
