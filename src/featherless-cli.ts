import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  normalizeUpstreamRoot,
  parseFeatherlessModelMetadata,
} from './core/featherless.js';

interface CachedModel {
  id: string;
  visionSupported: boolean;
  status?: string;
  inputModalities?: string[];
}

interface CatalogCache {
  version: 1;
  upstream: string;
  fetchedAt: number;
  models: CachedModel[];
}

interface CatalogResult {
  source: 'api' | 'cache' | 'stale-cache';
  cacheAgeMs: number;
  models: CachedModel[];
  warning?: string;
}

const CACHE_FILE = join(homedir(), '.cache', 'pxpipe', 'featherless-models.json');
const FRESH_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 24 * 60 * 60_000;
const MAX_MODELS = 2_000;

function upstream(): string {
  return normalizeUpstreamRoot(
    process.env.OPENAI_UPSTREAM
      ?? process.env.PXPIPE_UPSTREAM
      ?? 'https://api.featherless.ai',
  );
}

function apiKey(): string | undefined {
  return process.env.OPENAI_API_KEY ?? process.env.FEATHERLESS_API_KEY;
}

function readCache(expectedUpstream = upstream()): CatalogCache | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Partial<CatalogCache>;
    if (
      parsed.version !== 1
      || parsed.upstream !== expectedUpstream
      || typeof parsed.fetchedAt !== 'number'
      || !Array.isArray(parsed.models)
    ) {
      return null;
    }
    const models = parsed.models.filter((model): model is CachedModel => (
      Boolean(model)
      && typeof model.id === 'string'
      && typeof model.visionSupported === 'boolean'
    )).slice(0, MAX_MODELS);
    return { version: 1, upstream: expectedUpstream, fetchedAt: parsed.fetchedAt, models };
  } catch {
    return null;
  }
}

function writeCache(cache: CatalogCache): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${CACHE_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  renameSync(temporary, CACHE_FILE);
  chmodSync(CACHE_FILE, 0o600);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeModel(value: unknown): CachedModel | null {
  const model = object(value);
  if (!model || typeof model.id !== 'string' || model.id.length === 0 || model.id.length > 300) {
    return null;
  }
  const modalities = Array.isArray(model.input_modalities)
    ? model.input_modalities.filter((item): item is string => typeof item === 'string').slice(0, 16)
    : undefined;
  return {
    id: model.id,
    visionSupported: parseFeatherlessModelMetadata(model),
    ...(typeof model.status === 'string' ? { status: model.status } : {}),
    ...(modalities ? { inputModalities: modalities } : {}),
  };
}

async function fetchCatalog(targetUpstream: string): Promise<CatalogCache> {
  const key = apiKey();
  if (!key) throw new Error('Featherless API key is not configured');
  const response = await fetch(`${targetUpstream}/v1/models`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${key}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Featherless model discovery returned HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  const root = object(payload);
  const list = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : [];
  const unique = new Map<string, CachedModel>();
  for (const item of list) {
    const model = sanitizeModel(item);
    if (model) unique.set(model.id, model);
    if (unique.size >= MAX_MODELS) break;
  }
  const cache: CatalogCache = {
    version: 1,
    upstream: targetUpstream,
    fetchedAt: Date.now(),
    models: [...unique.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  writeCache(cache);
  return cache;
}

async function loadCatalog(refresh: boolean): Promise<CatalogResult> {
  const target = upstream();
  const cached = readCache(target);
  const age = cached ? Math.max(0, Date.now() - cached.fetchedAt) : Number.POSITIVE_INFINITY;
  if (!refresh && cached && age < FRESH_TTL_MS) {
    return { source: 'cache', cacheAgeMs: age, models: cached.models };
  }

  try {
    const fresh = await fetchCatalog(target);
    return { source: 'api', cacheAgeMs: 0, models: fresh.models };
  } catch (error) {
    if (cached && age < STALE_TTL_MS) {
      return {
        source: 'stale-cache',
        cacheAgeMs: age,
        models: cached.models,
        warning: (error as Error).message,
      };
    }
    throw error;
  }
}

function parseFlags(args: readonly string[], allowed: ReadonlySet<string>): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (!allowed.has(arg)) throw new Error(`unknown option: ${arg}`);
    flags.add(arg);
  }
  return flags;
}

async function modelsCommand(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, new Set(['--refresh', '--json']));
  const result = await loadCatalog(flags.has('--refresh'));
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  for (const model of result.models) {
    console.log(`${model.id}\tvision=${model.visionSupported ? 'yes' : 'no'}`);
  }
  console.error(`[pxpipe] featherless models: ${result.models.length}; source=${result.source}; cache_age_ms=${result.cacheAgeMs}`);
  if (result.warning) console.error(`[pxpipe] featherless models: using stale cache (${result.warning})`);
}

async function doctorCommand(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, new Set(['--json']));
  const target = upstream();
  const cache = readCache(target);
  const cacheAgeMs = cache ? Math.max(0, Date.now() - cache.fetchedAt) : null;
  const report = {
    ok: Boolean(apiKey()),
    upstream: target,
    apiKeyConfigured: Boolean(apiKey()),
    providerMode: process.env.PXPIPE_PROVIDER ?? null,
    transformMode: process.env.PXPIPE_FEATHERLESS_TRANSFORM ?? 'auto',
    cache: {
      path: CACHE_FILE,
      present: Boolean(cache),
      ageMs: cacheAgeMs,
      fresh: cacheAgeMs !== null && cacheAgeMs < FRESH_TTL_MS,
      staleUsable: cacheAgeMs !== null && cacheAgeMs < STALE_TTL_MS,
      models: cache?.models.length ?? 0,
    },
  };
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    console.log(`Featherless upstream: ${report.upstream}`);
    console.log(`API key configured: ${report.apiKeyConfigured ? 'yes' : 'no'}`);
    console.log(`Provider mode: ${report.providerMode ?? 'not set'}`);
    console.log(`Transform mode: ${report.transformMode}`);
    console.log(`Model cache: ${report.cache.present ? `${report.cache.models} models; age ${report.cache.ageMs}ms` : 'empty'}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

export async function runFeatherlessCli(argv: readonly string[]): Promise<void> {
  try {
    if (argv[0] === 'models' && argv[1] === 'featherless') {
      await modelsCommand(argv.slice(2));
      return;
    }
    if (argv[0] === 'doctor' && argv[1] === 'featherless') {
      await doctorCommand(argv.slice(2));
      return;
    }
    throw new Error('usage: pxpipe models featherless [--refresh] [--json] | pxpipe doctor featherless [--json]');
  } catch (error) {
    console.error(`[pxpipe] featherless: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
