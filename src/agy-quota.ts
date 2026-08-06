import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgyFailure, AgyFailureKind } from './agy.js';

export interface AgyCooldownEntry {
  authContext: string;
  model: string;
  failure: AgyFailureKind;
  createdAt: number;
  expiresAt: number;
  resetAfterSeconds: number;
}

interface AgyCooldownFile {
  version: 1;
  entries: AgyCooldownEntry[];
}

export interface AgyCooldownOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
  now?: number;
}

const VERSION = 1;
const MAX_ENTRIES = 256;
const DEFAULT_PATH = join(homedir(), '.pxpipe', 'agy-cooldowns.json');
const LEGACY_PATH = join(homedir(), '.pxpipe', 'agy-cooldown.json');
const DEFAULT_MODEL = '__default__';
const AUTH_WIDE_MODEL = '*';
const COOLDOWN_FAILURES = new Set<AgyFailureKind>([
  'quota_exhausted',
  'rate_limited',
  'not_authenticated',
]);

const DURATION_UNIT = '(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)';
const DURATION_SEQUENCE = new RegExp(
  `(\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT}(?:\\s*\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT})*)`,
  'i',
);
const DURATION_PART = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT})`, 'gi');

export function parseAgyResetDurationSeconds(text: string): number | undefined {
  const keyword = new RegExp(
    `(?:reset(?:s|ting)?|retry|again|available)[^\\d]{0,40}${DURATION_SEQUENCE.source}`,
    'i',
  ).exec(text);
  const sequence = keyword?.[1] ?? DURATION_SEQUENCE.exec(text)?.[1];
  if (!sequence) return undefined;

  let total = 0;
  for (const match of sequence.matchAll(DURATION_PART)) {
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (!Number.isFinite(amount)) continue;
    const multiplier = unit.startsWith('d') ? 86_400
      : unit.startsWith('h') ? 3_600
        : unit.startsWith('m') ? 60
          : 1;
    total += amount * multiplier;
  }
  return total > 0 ? Math.max(1, Math.ceil(total)) : undefined;
}

export function extractAgyModel(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--model') {
      const value = args[index + 1];
      if (value && !value.startsWith('-')) model = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length);
      if (value) model = value;
    }
  }
  return model;
}

function safeStatIdentity(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${path}:missing`;
  }
}

/**
 * Build a non-reversible local authentication-context key without reading or
 * persisting credential contents. Account/profile values contribute only to
 * the digest. Credential files contribute path, size and mtime metadata.
 */
export function agyAuthContextDigest(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  const material = [
    `home=${home}`,
    `profile=${env.AGY_PROFILE ?? ''}`,
    `project=${env.AGY_PROJECT ?? ''}`,
    `googleCredentials=${env.GOOGLE_APPLICATION_CREDENTIALS ?? ''}`,
    safeStatIdentity(join(home, '.gemini', 'oauth_creds.json')),
    safeStatIdentity(join(home, '.gemini', 'antigravity-cli', 'oauth_creds.json')),
    safeStatIdentity(join(home, '.gemini', 'config', 'oauth_creds.json')),
  ].join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function isEntry(value: unknown): value is AgyCooldownEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<AgyCooldownEntry>;
  return typeof entry.authContext === 'string'
    && /^[a-f0-9]{16}$/.test(entry.authContext)
    && typeof entry.model === 'string'
    && entry.model.length > 0
    && entry.model.length <= 256
    && typeof entry.failure === 'string'
    && COOLDOWN_FAILURES.has(entry.failure as AgyFailureKind)
    && typeof entry.createdAt === 'number'
    && typeof entry.expiresAt === 'number'
    && typeof entry.resetAfterSeconds === 'number';
}

function readFile(path: string): AgyCooldownFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgyCooldownFile>;
    if (parsed.version !== VERSION || !Array.isArray(parsed.entries)) {
      return { version: VERSION, entries: [] };
    }
    const entries = parsed.entries.filter(isEntry).slice(-MAX_ENTRIES);
    if (entries.length !== parsed.entries.length) return { version: VERSION, entries: [] };
    return { version: VERSION, entries };
  } catch {
    return { version: VERSION, entries: [] };
  }
}

function writeFile(path: string, file: AgyCooldownFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function scopedModel(failure: AgyFailureKind, model: string | undefined): string {
  if (failure === 'not_authenticated') return AUTH_WIDE_MODEL;
  return model || DEFAULT_MODEL;
}

function fallbackSeconds(kind: AgyFailureKind): number {
  if (kind === 'rate_limited') return 60;
  return 300;
}

function activeEntries(file: AgyCooldownFile, now: number): AgyCooldownEntry[] {
  return file.entries.filter((entry) => entry.expiresAt > now);
}

export function readAgyCooldown(
  model: string | undefined,
  options: AgyCooldownOptions = {},
): AgyCooldownEntry | null {
  const env = options.env ?? process.env;
  const path = options.path ?? DEFAULT_PATH;
  const now = options.now ?? Date.now();
  const authContext = agyAuthContextDigest(env);
  const requestedModel = model || DEFAULT_MODEL;
  const entries = activeEntries(readFile(path), now)
    .filter((entry) => entry.authContext === authContext)
    .filter((entry) => entry.model === requestedModel || entry.model === AUTH_WIDE_MODEL)
    .sort((left, right) => right.expiresAt - left.expiresAt);
  return entries[0] ?? null;
}

export function writeAgyCooldownForModel(
  failure: AgyFailure,
  model: string | undefined,
  options: AgyCooldownOptions = {},
): AgyCooldownEntry | null {
  if (!COOLDOWN_FAILURES.has(failure.kind)) return null;
  const env = options.env ?? process.env;
  const path = options.path ?? DEFAULT_PATH;
  const now = options.now ?? Date.now();
  const resetAfterSeconds = failure.resetAfterSeconds ?? fallbackSeconds(failure.kind);
  const entry: AgyCooldownEntry = {
    authContext: agyAuthContextDigest(env),
    model: scopedModel(failure.kind, model),
    failure: failure.kind,
    createdAt: now,
    expiresAt: now + resetAfterSeconds * 1000,
    resetAfterSeconds,
  };

  const current = activeEntries(readFile(path), now).filter((candidate) => !(
    candidate.authContext === entry.authContext
    && candidate.model === entry.model
    && candidate.failure === entry.failure
  ));
  current.push(entry);
  current.sort((left, right) => left.createdAt - right.createdAt);
  writeFile(path, { version: VERSION, entries: current.slice(-MAX_ENTRIES) });
  return entry;
}

export function clearAgyCooldown(
  model: string | undefined,
  options: AgyCooldownOptions = {},
): void {
  const env = options.env ?? process.env;
  const path = options.path ?? DEFAULT_PATH;
  const now = options.now ?? Date.now();
  const authContext = agyAuthContextDigest(env);
  const requestedModel = model || DEFAULT_MODEL;
  const remaining = activeEntries(readFile(path), now).filter((entry) => !(
    entry.authContext === authContext
    && (entry.model === requestedModel || entry.model === AUTH_WIDE_MODEL)
  ));
  writeFile(path, { version: VERSION, entries: remaining });
}

/** Remove the pre-0.13 global cooldown that could let one Claude quota pool block Gemini. */
export function removeLegacyAgyCooldown(path = LEGACY_PATH): boolean {
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
