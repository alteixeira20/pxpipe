import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildAgyEnvironment,
  classifyAgyFailure,
  findExecutable,
  inspectAgyHelp,
  isAgyWarpInvocation,
  parseAgyWarpInvocation,
  runAgyEntry,
  type AgyCapabilities,
  type AgyFailure,
  type AgyFailureKind,
} from './agy.js';
import { discoverAgyModels } from './agy-models.js';
import {
  clearAgyCooldown,
  extractAgyModel,
  parseAgyResetDurationSeconds,
  readAgyCooldown,
  removeLegacyAgyCooldown,
  writeAgyCooldownForModel,
} from './agy-quota.js';

export interface AgyDoctorOptions {
  json: boolean;
  live: boolean;
  model?: string;
}

interface AgyDoctorReportV2 {
  ok: boolean;
  binary: { found: boolean; path?: string; version?: string };
  authentication: 'present-unverified' | 'not-found' | 'unknown';
  capabilities: AgyCapabilities;
  selectedModel?: string;
  modelsDiscovered: number;
  modelKnown?: boolean;
  server: {
    url: string;
    reachable: boolean;
  };
  route: {
    configured: boolean;
    count: number;
    compressionReady: boolean;
  };
  quota: {
    state: 'unknown' | 'available' | 'blocked';
    failure?: AgyFailureKind;
    resetAfterSeconds?: number;
  };
  live?: {
    attempted: boolean;
    exitCode: number | null;
    failure?: AgyFailureKind;
  };
}

const DEFAULT_LIVE_TIMEOUT_MS = 60_000;
const NON_MODEL_SUBCOMMANDS = new Set([
  'agent',
  'agents',
  'changelog',
  'help',
  'install',
  'models',
  'plugin',
  'plugins',
  'update',
  'version',
]);

export function parseAgyDoctorOptions(args: readonly string[]): AgyDoctorOptions {
  let json = false;
  let live = false;
  let model: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--live') live = true;
    else if (arg === '--model') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--model requires a model id');
      model = value;
      index += 1;
    } else if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
      if (!model) throw new Error('--model requires a model id');
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  if (live && !model) {
    throw new Error('--live requires --model so quota state is not attributed globally');
  }
  return { json, live, ...(model ? { model } : {}) };
}

function authArtifactPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  return [
    join(home, '.gemini', 'oauth_creds.json'),
    join(home, '.gemini', 'antigravity-cli', 'oauth_creds.json'),
    join(home, '.gemini', 'config', 'oauth_creds.json'),
  ].some((candidate) => existsSync(candidate));
}

function routeSpecs(env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env.PXPIPE_AGY_ROUTES ?? env.PXPIPE_AGY_ROUTE;
  if (!value) return [];
  return value.split(/[;\n]/).map((item) => item.trim()).filter(Boolean);
}

async function serverReachable(env: NodeJS.ProcessEnv = process.env): Promise<{ url: string; reachable: boolean }> {
  const port = Number(env.PORT ?? 47821);
  const url = `http://127.0.0.1:${Number.isFinite(port) ? port : 47821}/`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return { url, reachable: response.ok };
  } catch {
    return { url, reachable: false };
  }
}

function safeVersion(binary: string): string | undefined {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: buildAgyEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : undefined;
}

function safeHelp(binary: string): string {
  const result = spawnSync(binary, ['--help'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: buildAgyEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  return `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
}

export function withAgyCompoundReset(
  failure: AgyFailure | null,
  stdout: string,
  stderr: string,
): AgyFailure | null {
  if (!failure) return null;
  const parsed = parseAgyResetDurationSeconds(`${stdout}\n${stderr}`);
  if (!parsed) return failure;
  return { ...failure, resetAfterSeconds: parsed };
}

async function runDoctor(args: readonly string[]): Promise<void> {
  let options: AgyDoctorOptions;
  try {
    options = parseAgyDoctorOptions(args);
  } catch (error) {
    console.error(`[pxpipe] doctor agy: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }

  removeLegacyAgyCooldown();
  const binary = findExecutable('agy');
  const version = binary ? safeVersion(binary) : undefined;
  const help = binary ? safeHelp(binary) : '';
  const capabilities = inspectAgyHelp(help);
  let modelCount = 0;
  let modelKnown: boolean | undefined;
  try {
    const discovery = discoverAgyModels();
    modelCount = discovery.catalog.models.length;
    if (options.model) {
      modelKnown = discovery.catalog.models.some((model) => model.id === options.model);
    }
  } catch {
    // Binary/version/help status remains useful even if model listing fails.
  }

  const server = await serverReachable();
  const routes = routeSpecs();
  const cooldown = readAgyCooldown(options.model);
  const report: AgyDoctorReportV2 = {
    ok: Boolean(binary && version && help),
    binary: {
      found: Boolean(binary),
      ...(binary ? { path: binary } : {}),
      ...(version ? { version } : {}),
    },
    authentication: binary ? (authArtifactPresent() ? 'present-unverified' : 'not-found') : 'unknown',
    capabilities,
    ...(options.model ? { selectedModel: options.model } : {}),
    modelsDiscovered: modelCount,
    ...(modelKnown !== undefined ? { modelKnown } : {}),
    server,
    route: {
      configured: routes.length > 0,
      count: routes.length,
      compressionReady: routes.length > 0 && server.reachable,
    },
    quota: cooldown
      ? {
          state: 'blocked',
          failure: cooldown.failure,
          resetAfterSeconds: Math.max(1, Math.ceil((cooldown.expiresAt - Date.now()) / 1_000)),
        }
      : { state: 'unknown' },
  };

  if (options.live && binary && options.model) {
    const result = spawnSync(binary, [
      '--model', options.model,
      '--output-format', 'json',
      '--print', 'Reply with exactly: OK',
    ], {
      encoding: 'utf8',
      timeout: Number(process.env.PXPIPE_AGY_LIVE_TIMEOUT_MS ?? DEFAULT_LIVE_TIMEOUT_MS),
      env: buildAgyEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    const failure = withAgyCompoundReset(classifyAgyFailure({
      stdout,
      stderr,
      exitCode: result.status,
      timedOut: result.error?.name === 'TimeoutError' || result.signal === 'SIGTERM',
      structuredExpected: true,
    }), stdout, stderr);

    if (failure) {
      writeAgyCooldownForModel(failure, options.model);
    } else {
      clearAgyCooldown(options.model);
    }

    report.live = {
      attempted: true,
      exitCode: result.status,
      ...(failure ? { failure: failure.kind } : {}),
    };
    report.quota = failure
      ? {
          state: 'blocked',
          failure: failure.kind,
          ...(failure.resetAfterSeconds ? { resetAfterSeconds: failure.resetAfterSeconds } : {}),
        }
      : { state: 'available' };
    report.ok = report.ok && !failure;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  console.log(`AGY binary: ${report.binary.found ? `${report.binary.path} (${report.binary.version ?? 'version unknown'})` : 'not found'}`);
  console.log(`Authentication artifact: ${report.authentication}`);
  console.log(`Models discovered: ${report.modelsDiscovered}`);
  if (report.selectedModel) {
    console.log(`Selected model: ${report.selectedModel}${report.modelKnown === false ? ' (not in AGY catalogue)' : ''}`);
  }
  console.log(`PXPipe server: ${report.server.reachable ? 'reachable' : 'unreachable'} at ${report.server.url}`);
  console.log(`PXPipe AGY route: ${report.route.configured ? `${report.route.count} configured` : 'not configured (AGY runs direct)'}`);
  console.log(`Quota: ${report.quota.state}${report.quota.failure ? ` (${report.quota.failure})` : ''}`);
  if (!options.live) {
    console.log('Live model call: not requested; use --model MODEL --live to test one model.');
  }
  process.exitCode = report.ok ? 0 : 1;
}

function commandArgs(argv: readonly string[]): readonly string[] {
  if (argv[0] === 'agy') return argv.slice(1);
  if (isAgyWarpInvocation(argv)) {
    try {
      return parseAgyWarpInvocation(argv).args;
    } catch {
      return [];
    }
  }
  return [];
}

export function isAgyNonModelInvocation(args: readonly string[]): boolean {
  if (args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version')) return true;
  const first = args.find((arg) => !arg.startsWith('-'));
  return first !== undefined && NON_MODEL_SUBCOMMANDS.has(first);
}

export async function runAgyEntryV2(argv: readonly string[]): Promise<void> {
  removeLegacyAgyCooldown();

  if (argv[0] === 'doctor' && argv[1] === 'agy') {
    await runDoctor(argv.slice(2));
    return;
  }

  const args = commandArgs(argv);
  if (!isAgyNonModelInvocation(args)) {
    const model = extractAgyModel(args);
    const cooldown = readAgyCooldown(model);
    if (cooldown) {
      const remaining = Math.max(1, Math.ceil((cooldown.expiresAt - Date.now()) / 1_000));
      console.error(
        `[pxpipe] agy: ${cooldown.failure} for ${model ?? 'default model'}; retry after about ${remaining}s`,
      );
      process.exit(1);
    }
  }

  await runAgyEntry(argv);
}
