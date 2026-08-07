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
  /** True only when discovery failed and an older sanitized catalog was retained. */
  stale?: boolean;
}

export interface DiscoverAgyModelsOptions {
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  now?: number;
  timeoutMs?: number;
}

interface AgyCapture {
  stdout: string;
  stderr: string;
}

interface AgyBinaryIdentity {
  binaryPath: string;
  binaryVersion: string;
  binaryMtimeMs: number;
}

const CATALOG_VERSION = 1;
const DEFAULT_CACHE_PATH = join(homedir(), '.cache', 'pxpipe', 'agy-models.json');
const CACHE_TTL_MS = 5 * 60_000;
const MAX_MODELS = 1_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const KNOWN_MODEL_TOKEN = /(?:claude-[A-Za-z0-9._:/-]+|gemini-[A-Za-z0-9._:/-]+|gpt[-_][A-Za-z0-9._:/-]+|o\d(?:-[A-Za-z0-9._:/-]+)?)/gi;
const VERSION_TOKEN = /\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/;

function cleanLine(raw: string): string {
  return raw.replace(ANSI_ESCAPE, '').trim();
}

function addModel(unique: Set<string>, candidate: string): void {
  const normalized = candidate.replace(/[),;]+$/g, '');
  if (!MODEL_ID.test(normalized)) return;
  unique.add(normalized);
}

/**
 * Parse both the historical one-id-per-line format and newer human-formatted
 * tables/bullets. Exact single-token lines retain unknown models; formatted
 * lines only contribute recognized family-shaped ids so headings/warnings do
 * not become fake model identifiers.
 */
export function parseAgyModelsOutput(output: string): string[] {
  const unique = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (!line) continue;

    if (MODEL_ID.test(line)) {
      addModel(unique, line);
    } else {
      for (const match of line.matchAll(KNOWN_MODEL_TOKEN)) {
        addModel(unique, match[0]);
        if (unique.size >= MAX_MODELS) break;
      }
    }

    if (unique.size >= MAX_MODELS) break;
  }
  return [...unique];
}

/**
 * AGY has historically emitted command help on stderr and may do the same for
 * informational model listings. We inspect stderr in memory but only retain
 * recognized model-shaped identifiers from it; raw stderr is never cached.
 */
export function parseAgyModelsStreams(stdout: string, stderr: string): string[] {
  const unique = new Set(parseAgyModelsOutput(stdout));
  for (const raw of stderr.split(/\r?\n/)) {
    const line = cleanLine(raw);
    for (const match of line.matchAll(KNOWN_MODEL_TOKEN)) {
      addModel(unique, match[0]);
      if (unique.size >= MAX_MODELS) break;
    }
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

function buildCatalogFromIds(
  identity: AgyBinaryIdentity,
  fetchedAt: number,
  ids: readonly string[],
): AgyModelCatalog {
  return {
    version: CATALOG_VERSION,
    ...identity,
    fetchedAt,
    models: ids.slice(0, MAX_MODELS).map(classifyAgyModel),
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
  identity: AgyBinaryIdentity,
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
): AgyCapture {
  const result = spawnSync(binaryPath, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildAgyEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`cannot execute AGY ${args.join(' ')} (${result.error.name})`);
  }
  if (result.status !== 0) {
    // AGY stderr may contain account identities, project names or provider
    // details. Discovery diagnostics retain only the safe command and status.
    throw new Error(`AGY ${args.join(' ')} exited ${result.status}`);
  }
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function parseVersion(capture: AgyCapture): string {
  for (const text of [capture.stdout, capture.stderr]) {
    const match = VERSION_TOKEN.exec(text);
    if (match) return match[0];
  }
  throw new Error('AGY --version returned no parseable version');
}

function readIdentity(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): AgyBinaryIdentity {
  const version = parseVersion(runAgy(binaryPath, ['--version'], env, timeoutMs));
  const binaryMtimeMs = existsSync(binaryPath) ? statSync(binaryPath).mtimeMs : 0;
  return {
    binaryPath,
    binaryVersion: version,
    binaryMtimeMs,
  };
}

function sameIdentity(left: AgyBinaryIdentity, right: AgyBinaryIdentity): boolean {
  return left.binaryPath === right.binaryPath
    && left.binaryVersion === right.binaryVersion
    && left.binaryMtimeMs === right.binaryMtimeMs;
}

function staleFallback(
  cached: AgyModelCatalog | null,
  cachePath: string,
  binaryPath: string,
): AgyModelDiscoveryResult | null {
  if (!cached || cached.binaryPath !== binaryPath || cached.models.length === 0) return null;
  return { source: 'cache', cachePath, catalog: cached, stale: true };
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

  const identityBefore = readIdentity(binaryPath, env, timeoutMs);
  const cached = readCache(cachePath);
  if (!options.refresh && cached && isAgyModelCatalogFresh(cached, identityBefore, now)) {
    return { source: 'cache', cachePath, catalog: cached };
  }

  let capture: AgyCapture;
  try {
    capture = runAgy(binaryPath, ['models'], env, timeoutMs);
  } catch (error) {
    const fallback = staleFallback(cached, cachePath, binaryPath);
    if (fallback) return fallback;
    throw error;
  }

  let identityAfter = readIdentity(binaryPath, env, timeoutMs);

  // AGY can update itself between `--version` and `models`. Never stamp model
  // output produced by one binary with another binary's identity. Re-run once
  // after an observed version/mtime change and persist only the stable result.
  if (!sameIdentity(identityBefore, identityAfter)) {
    try {
      capture = runAgy(binaryPath, ['models'], env, timeoutMs);
      identityAfter = readIdentity(binaryPath, env, timeoutMs);
    } catch (error) {
      const fallback = staleFallback(cached, cachePath, binaryPath);
      if (fallback) return fallback;
      throw error;
    }
  }

  const ids = parseAgyModelsStreams(capture.stdout, capture.stderr);
  if (ids.length === 0) {
    const fallback = staleFallback(cached, cachePath, binaryPath);
    if (fallback) return fallback;
    throw new Error('AGY models returned no parseable model identifiers');
  }

  const catalog = buildCatalogFromIds(identityAfter, now, ids);
  writeCache(cachePath, catalog);
  return { source: 'agy', cachePath, catalog };
}
