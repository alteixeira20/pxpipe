import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildAgyEnvironment, findExecutable } from './agy.js';

export type AgyModelFamily = 'claude' | 'gemini' | 'openai-compatible' | 'unknown';
export type AgyProtocolHint = 'anthropic' | 'google' | 'openai' | 'unknown';
export type AgyCompressionSupport = 'supported' | 'experimental' | 'passthrough';

export interface AgyModelDescriptor {
  id: string;
  family: AgyModelFamily;
  protocolHint: AgyProtocolHint;
  compressionSupport: AgyCompressionSupport;
  /** Model-id classification is a hint until real AGY traffic confirms protocol shape. */
  evidence: 'model-id-pattern';
}

export interface AgyModelCatalog {
  version: 1;
  binaryPath: string;
  binaryVersion: string;
  binaryMtimeMs: number;
  fetchedAt: number;
  models: AgyModelDescriptor[];
}

export interface AgyModelDiscoveryResult {
  source: 'agy' | 'cache';
  cachePath: string;
  catalog: AgyModelCatalog;
}

export interface DiscoverAgyModelsOptions {
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  now?: number;
  timeoutMs?: number;
}

const CATALOG_VERSION = 1;
const DEFAULT_CACHE_PATH = join(homedir(), '.cache', 'pxpipe', 'agy-models.json');
const CACHE_TTL_MS = 5 * 60_000;
const MAX_MODELS = 1_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function parseAgyModelsOutput(output: string): string[] {
  const unique = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !MODEL_ID.test(line)) continue;
    unique.add(line);
    if (unique.size >= MAX_MODELS) break;
  }
  return [...unique];
}

export function classifyAgyModel(id: string): AgyModelDescriptor {
  const normalized = id.toLowerCase();

  if (normalized.startsWith('claude-')) {
    return {
      id,
      family: 'claude',
      protocolHint: 'anthropic',
      compressionSupport: 'supported',
      evidence: 'model-id-pattern',
    };
  }

  if (normalized.startsWith('gemini-')) {
    return {
      id,
      family: 'gemini',
      protocolHint: 'google',
      compressionSupport: normalized.startsWith('gemini-3.6-flash')
        ? 'supported'
        : 'experimental',
      evidence: 'model-id-pattern',
    };
  }

  if (
    normalized.startsWith('gpt-')
    || normalized.startsWith('gpt_')
    || /^o\d(?:-|$)/.test(normalized)
  ) {
    return {
      id,
      family: 'openai-compatible',
      protocolHint: 'openai',
      compressionSupport: 'experimental',
      evidence: 'model-id-pattern',
    };
  }

  return {
    id,
    family: 'unknown',
    protocolHint: 'unknown',
    compressionSupport: 'passthrough',
    evidence: 'model-id-pattern',
  };
}

export function buildAgyModelCatalog(input: {
  binaryPath: string;
  binaryVersion: string;
  binaryMtimeMs: number;
  fetchedAt: number;
  output: string;
}): AgyModelCatalog {
  return {
    version: CATALOG_VERSION,
    binaryPath: input.binaryPath,
    binaryVersion: input.binaryVersion,
    binaryMtimeMs: input.binaryMtimeMs,
    fetchedAt: input.fetchedAt,
    models: parseAgyModelsOutput(input.output).map(classifyAgyModel),
  };
}

function isDescriptor(value: unknown): value is AgyModelDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<AgyModelDescriptor>;
  return typeof item.id === 'string'
    && MODEL_ID.test(item.id)
    && ['claude', 'gemini', 'openai-compatible', 'unknown'].includes(item.family ?? '')
    && ['anthropic', 'google', 'openai', 'unknown'].includes(item.protocolHint ?? '')
    && ['supported', 'experimental', 'passthrough'].includes(item.compressionSupport ?? '')
    && item.evidence === 'model-id-pattern';
}

export function parseAgyModelCatalog(text: string): AgyModelCatalog | null {
  try {
    const value = JSON.parse(text) as Partial<AgyModelCatalog>;
    if (
      value.version !== CATALOG_VERSION
      || typeof value.binaryPath !== 'string'
      || typeof value.binaryVersion !== 'string'
      || typeof value.binaryMtimeMs !== 'number'
      || typeof value.fetchedAt !== 'number'
      || !Array.isArray(value.models)
    ) {
      return null;
    }
    const models = value.models.filter(isDescriptor).slice(0, MAX_MODELS);
    if (models.length !== value.models.length) return null;
    return {
      version: CATALOG_VERSION,
      binaryPath: value.binaryPath,
      binaryVersion: value.binaryVersion,
      binaryMtimeMs: value.binaryMtimeMs,
      fetchedAt: value.fetchedAt,
      models,
    };
  } catch {
    return null;
  }
}

export function isAgyModelCatalogFresh(
  catalog: AgyModelCatalog,
  identity: {
    binaryPath: string;
    binaryVersion: string;
    binaryMtimeMs: number;
  },
  now = Date.now(),
): boolean {
  return catalog.binaryPath === identity.binaryPath
    && catalog.binaryVersion === identity.binaryVersion
    && catalog.binaryMtimeMs === identity.binaryMtimeMs
    && now >= catalog.fetchedAt
    && now - catalog.fetchedAt < CACHE_TTL_MS;
}

function readCache(cachePath: string): AgyModelCatalog | null {
  try {
    return parseAgyModelCatalog(readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, catalog: AgyModelCatalog): void {
  const parent = dirname(cachePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  renameSync(temporary, cachePath);
  chmodSync(cachePath, 0o600);
}

function runAgy(
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string {
  const result = spawnSync(binaryPath, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildAgyEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`cannot execute AGY: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`AGY ${args.join(' ')} exited ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
  return String(result.stdout ?? '').trim();
}

export function discoverAgyModels(
  options: DiscoverAgyModelsOptions = {},
): AgyModelDiscoveryResult {
  const env = options.env ?? process.env;
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const binaryPath = findExecutable('agy', env);
  if (!binaryPath) throw new Error('AGY executable not found on PATH');

  const binaryMtimeMs = existsSync(binaryPath) ? statSync(binaryPath).mtimeMs : 0;
  const binaryVersion = runAgy(binaryPath, ['--version'], env, timeoutMs);
  const identity = { binaryPath, binaryVersion, binaryMtimeMs };
  const cached = readCache(cachePath);
  if (!options.refresh && cached && isAgyModelCatalogFresh(cached, identity, now)) {
    return { source: 'cache', cachePath, catalog: cached };
  }

  const output = runAgy(binaryPath, ['models'], env, timeoutMs);
  const catalog = buildAgyModelCatalog({
    ...identity,
    fetchedAt: now,
    output,
  });
  writeCache(cachePath, catalog);
  return { source: 'agy', cachePath, catalog };
}
