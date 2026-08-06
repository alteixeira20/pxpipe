import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { CertificateAuthority } from './warp/ca.js';
import { createWarpHandlers } from './warp/connect.js';
import { parseRoute, type Route } from './warp/route.js';

export type AgyFailureKind =
  | 'not_authenticated'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'model_unavailable'
  | 'permission_denied'
  | 'timeout'
  | 'malformed_structured_output'
  | 'transport_failure'
  | 'unknown';

export interface AgyFailure {
  kind: AgyFailureKind;
  resetAfterSeconds?: number;
  safeMessage: string;
}

export interface AgyCapabilities {
  print: boolean;
  outputJson: boolean;
  outputStreamJson: boolean;
  jsonSchema: boolean;
  model: boolean;
  effort: boolean;
  continuation: boolean;
  conversation: boolean;
  sandbox: boolean;
  permissionMode: boolean;
}

export interface AgyDoctorReport {
  ok: boolean;
  binary: { found: boolean; path?: string; version?: string };
  authentication: 'present-unverified' | 'not-found' | 'unknown';
  capabilities: AgyCapabilities;
  route: {
    configured: boolean;
    count: number;
    proxyReachable: boolean | null;
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

export interface ParsedAgyWarpInvocation {
  routes: string[];
  args: string[];
}

const DEFAULT_PORT = 47821;
const DEFAULT_LIVE_TIMEOUT_MS = 60_000;
const COOLDOWN_FILE = join(homedir(), '.pxpipe', 'agy-cooldown.json');
const SAFE_NON_MODEL_ARGS = new Set(['--help', '-h', '--version', 'version', 'help']);

function splitRouteEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAgyCommand(word: string | undefined): boolean {
  if (!word) return false;
  const name = basename(word).toLowerCase();
  return name === 'agy' || name === 'agy.exe';
}

export function isAgyWarpInvocation(argv: readonly string[]): boolean {
  if (argv[0] !== 'warp') return false;
  const separator = argv.indexOf('--');
  return separator >= 0 && isAgyCommand(argv[separator + 1]);
}

export function parseAgyWarpInvocation(argv: readonly string[]): ParsedAgyWarpInvocation {
  if (!isAgyWarpInvocation(argv)) {
    throw new Error('expected pxpipe warp [--route PATTERN=TARGET] -- agy [args...]');
  }
  const separator = argv.indexOf('--');
  const ownArgs = argv.slice(1, separator);
  const routes: string[] = [];
  for (let index = 0; index < ownArgs.length; index += 1) {
    const arg = ownArgs[index]!;
    if (arg === '--route') {
      const route = ownArgs[index + 1];
      if (!route) throw new Error('--route needs PATTERN=TARGET');
      routes.push(route);
      index += 1;
      continue;
    }
    if (arg.startsWith('--route=')) {
      routes.push(arg.slice('--route='.length));
      continue;
    }
    throw new Error(`unknown pxpipe warp option before agy: ${arg}`);
  }
  return { routes, args: argv.slice(separator + 2) };
}

export function safeAgyCommandLabel(args: readonly string[]): string {
  const flags = args
    .filter((arg) => arg.startsWith('-'))
    .map((arg) => arg.split('=', 1)[0])
    .filter((arg, index, all) => all.indexOf(arg) === index)
    .slice(0, 8);
  return `agy (${args.length} args${flags.length ? `; flags ${flags.join(', ')}` : ''})`;
}

export function buildAgyEnvironment(
  source: NodeJS.ProcessEnv,
  proxyUrl?: string,
  caCertPath?: string,
): NodeJS.ProcessEnv {
  const env = { ...source };

  // AGY owns its provider routing and authentication. Inherited base URL
  // overrides from Claude/OpenAI wrappers can silently send AGY to an
  // incompatible endpoint, so remove only those endpoint overrides. Project,
  // model, plugin, auth and Remote Control state remain untouched.
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_UNIX_SOCKET;
  delete env.OPENAI_BASE_URL;
  delete env.GEMINI_API_BASE_URL;
  delete env.GOOGLE_GENERATIVE_AI_BASE_URL;

  if (proxyUrl && caCertPath) {
    env.HTTP_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.https_proxy = proxyUrl;
    env.NODE_EXTRA_CA_CERTS = caCertPath;
    env.SSL_CERT_FILE = caCertPath;
    env.CURL_CA_BUNDLE = caCertPath;
    env.REQUESTS_CA_BUNDLE = caCertPath;
  }

  return env;
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const directory of (env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

export function inspectAgyHelp(help: string): AgyCapabilities {
  const has = (...needles: string[]): boolean => needles.some((needle) => help.includes(needle));
  return {
    print: has('--print', '-p'),
    outputJson: has('--output-format') && /\bjson\b/.test(help),
    outputStreamJson: has('--output-format') && /stream-json/.test(help),
    jsonSchema: has('--json-schema'),
    model: has('--model', '-m'),
    effort: has('--effort'),
    continuation: has('--continue', '-c'),
    conversation: has('--conversation'),
    sandbox: has('--sandbox'),
    permissionMode: has('--permission-mode', '--approval-mode', '--dangerously-skip-permissions'),
  };
}

function parseDurationText(text: string): number | undefined {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi)];
  if (matches.length === 0) return undefined;
  const match = matches[0]!;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit.startsWith('d') ? 86_400
    : unit.startsWith('h') ? 3_600
      : unit.startsWith('m') ? 60
        : 1;
  return Number.isFinite(amount) ? Math.max(1, Math.ceil(amount * multiplier)) : undefined;
}

function collectJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const trimmed = text.trim();
  if (!trimmed) return objects;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      objects.push(parsed as Record<string, unknown>);
      return objects;
    }
  } catch {
    // Structured streaming commonly emits one JSON object per line.
  }
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Preserve malformed lines for the caller; never rewrite stdout.
    }
  }
  return objects;
}

function envelopeMessage(value: Record<string, unknown>): string {
  const error = value.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return String((error as Record<string, unknown>).message);
  }
  return typeof value.message === 'string' ? value.message : '';
}

export function classifyAgyFailure(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  structuredExpected?: boolean;
}): AgyFailure | null {
  if (input.timedOut) {
    return { kind: 'timeout', safeMessage: 'AGY exceeded the configured timeout.' };
  }

  const objects = collectJsonObjects(input.stdout);
  const envelope = [...objects].reverse().find((value) => {
    const status = String(value.status ?? '').toUpperCase();
    return status === 'ERROR' || value.error !== undefined;
  });
  const combined = [envelope ? envelopeMessage(envelope) : '', input.stderr].filter(Boolean).join('\n');
  const lower = combined.toLowerCase();
  const resetAfterSeconds = parseDurationText(combined)
    ?? (typeof envelope?.retry_after_seconds === 'number' ? envelope.retry_after_seconds : undefined)
    ?? (typeof envelope?.reset_after_seconds === 'number' ? envelope.reset_after_seconds : undefined);

  const make = (kind: AgyFailureKind, safeMessage: string): AgyFailure => ({
    kind,
    safeMessage,
    ...(resetAfterSeconds ? { resetAfterSeconds } : {}),
  });

  if (/not authenticated|authentication required|sign[ -]?in required|invalid credentials|unauthenticated/.test(lower)) {
    return make('not_authenticated', 'AGY authentication is unavailable.');
  }
  if (/individual quota reached|quota (?:is )?(?:reached|exhausted)|resource[_ ]?exhausted|usage limit/.test(lower)) {
    return make('quota_exhausted', 'AGY quota is exhausted.');
  }
  if (/rate limit|too many requests|http\s*429|status\s*429/.test(lower)) {
    return make('rate_limited', 'AGY is rate limited.');
  }
  if (/model (?:is )?(?:unavailable|not found|unsupported|disabled)|no available model/.test(lower)) {
    return make('model_unavailable', 'The selected AGY model is unavailable.');
  }
  if (/permission denied|not permitted|approval required|sandbox.*denied|access denied/.test(lower)) {
    return make('permission_denied', 'AGY was denied permission to continue.');
  }
  if (/timeout|timed out|deadline exceeded/.test(lower)) {
    return make('timeout', 'AGY timed out.');
  }
  if (/connection refused|connection reset|network is unreachable|dns|transport|tls|certificate/.test(lower)) {
    return make('transport_failure', 'AGY could not reach its service.');
  }
  if (input.structuredExpected && input.exitCode !== 0 && objects.length === 0 && input.stdout.trim().length > 0) {
    return make('malformed_structured_output', 'AGY returned malformed structured output.');
  }
  if (input.exitCode !== 0) {
    return make('unknown', 'AGY exited with an error.');
  }
  return null;
}

function authArtifactPresent(): boolean {
  const home = homedir();
  const candidates = [
    join(home, '.gemini', 'oauth_creds.json'),
    join(home, '.gemini', 'antigravity-cli', 'oauth_creds.json'),
    join(home, '.gemini', 'config', 'oauth_creds.json'),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

function readCooldown(): { failure: AgyFailureKind; expiresAt: number; resetAfterSeconds?: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.failure !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    if (Date.now() >= parsed.expiresAt) return null;
    return {
      failure: parsed.failure as AgyFailureKind,
      expiresAt: parsed.expiresAt,
      ...(typeof parsed.resetAfterSeconds === 'number' ? { resetAfterSeconds: parsed.resetAfterSeconds } : {}),
    };
  } catch {
    return null;
  }
}

export function writeAgyCooldown(failure: AgyFailure, now = Date.now()): void {
  if (!['quota_exhausted', 'rate_limited', 'not_authenticated'].includes(failure.kind)) return;
  const fallbackSeconds = failure.kind === 'quota_exhausted' ? 300 : failure.kind === 'not_authenticated' ? 300 : 60;
  const resetAfterSeconds = failure.resetAfterSeconds ?? fallbackSeconds;
  const payload = {
    failure: failure.kind,
    createdAt: now,
    expiresAt: now + resetAfterSeconds * 1000,
    resetAfterSeconds,
  };
  mkdirSync(dirname(COOLDOWN_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${COOLDOWN_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  renameSync(temporary, COOLDOWN_FILE);
  chmodSync(COOLDOWN_FILE, 0o600);
}

function routeSpecsFromEnvironment(): string[] {
  return splitRouteEnv(process.env.PXPIPE_AGY_ROUTES ?? process.env.PXPIPE_AGY_ROUTE);
}

function proxyTargetReachable(routes: readonly string[]): Promise<boolean | null> {
  const first = routes[0];
  if (!first) return Promise.resolve(null);
  try {
    const route = parseRoute(first);
    const target = new URL(route.target.toString());
    const health = `${target.protocol}//${target.host}/`;
    return fetch(health, { signal: AbortSignal.timeout(1500) })
      .then((response) => response.ok)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function spawnWithTransparentLifecycle(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
): ChildProcess {
  const child = spawn(command, [...args], { stdio: 'inherit', env, cwd: process.cwd() });
  const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  for (const signal of forwarded) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`[pxpipe] agy: cannot run AGY: ${error.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    onExit?.(code, signal);
    if (signal) {
      for (const forwardedSignal of forwarded) process.removeAllListeners(forwardedSignal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  return child;
}

function runAgyProcess(args: readonly string[], routeSpecs: readonly string[]): void {
  const binary = findExecutable('agy');
  if (!binary) {
    console.error('[pxpipe] agy: executable not found on PATH');
    process.exit(127);
  }

  if (routeSpecs.length === 0) {
    spawnWithTransparentLifecycle(binary, args, buildAgyEnvironment(process.env));
    return;
  }

  let routes: Route[];
  try {
    routes = routeSpecs.map((spec) => parseRoute(spec));
  } catch (error) {
    console.error(`[pxpipe] agy: invalid route: ${(error as Error).message}`);
    process.exit(2);
  }

  const ca = CertificateAuthority.loadOrCreate(join(homedir(), '.pxpipe'));
  const debug = /^(?:1|true|yes|on)$/i.test(process.env.PXPIPE_AGY_DEBUG ?? '');
  const handlers = createWarpHandlers({
    routes,
    ca,
    onDivert: (host, path, target) => {
      if (debug) console.error(`[pxpipe] agy route: ${host}${path} -> ${target}`);
    },
  });
  const proxy = createServer(handlers.handleAbsoluteForm);
  proxy.on('connect', handlers.handleConnect);
  proxy.on('error', (error) => {
    console.error(`[pxpipe] agy: proxy listener failed: ${error.message}`);
    process.exit(1);
  });
  proxy.listen(0, '127.0.0.1', () => {
    const address = proxy.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const proxyUrl = `http://127.0.0.1:${port}`;
    if (debug) console.error(`[pxpipe] agy: ${safeAgyCommandLabel(args)} via ${routeSpecs.length} route(s)`);
    spawnWithTransparentLifecycle(binary, args, buildAgyEnvironment(process.env, proxyUrl, ca.certPath));
  });
}

function isNonModelInvocation(args: readonly string[]): boolean {
  return args.length === 0 || args.some((arg) => SAFE_NON_MODEL_ARGS.has(arg));
}

async function runDoctor(args: readonly string[]): Promise<void> {
  const json = args.includes('--json');
  const live = args.includes('--live');
  const unknown = args.filter((arg) => arg !== '--json' && arg !== '--live');
  if (unknown.length > 0) {
    console.error(`[pxpipe] doctor agy: unknown option ${unknown[0]}`);
    process.exit(2);
  }

  const binary = findExecutable('agy');
  const versionResult = binary
    ? spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, env: buildAgyEnvironment(process.env) })
    : null;
  const helpResult = binary
    ? spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 5000, env: buildAgyEnvironment(process.env) })
    : null;
  const help = `${helpResult?.stdout ?? ''}\n${helpResult?.stderr ?? ''}`;
  const capabilities = inspectAgyHelp(help);
  const routes = routeSpecsFromEnvironment();
  const reachable = await proxyTargetReachable(routes);
  const cooldown = readCooldown();

  const report: AgyDoctorReport = {
    ok: Boolean(binary && versionResult?.status === 0 && helpResult?.status === 0),
    binary: {
      found: Boolean(binary),
      ...(binary ? { path: binary } : {}),
      ...(versionResult?.status === 0 ? { version: String(versionResult.stdout).trim() } : {}),
    },
    authentication: binary ? (authArtifactPresent() ? 'present-unverified' : 'not-found') : 'unknown',
    capabilities,
    route: {
      configured: routes.length > 0,
      count: routes.length,
      proxyReachable: reachable,
      compressionReady: routes.length > 0 && reachable === true,
    },
    quota: cooldown
      ? {
          state: 'blocked',
          failure: cooldown.failure,
          ...(cooldown.resetAfterSeconds ? { resetAfterSeconds: cooldown.resetAfterSeconds } : {}),
        }
      : { state: 'unknown' },
  };

  if (live && binary) {
    const result = spawnSync(
      binary,
      ['--print', '--output-format', 'json', 'Reply with OK'],
      {
        encoding: 'utf8',
        timeout: Number(process.env.PXPIPE_AGY_LIVE_TIMEOUT_MS ?? DEFAULT_LIVE_TIMEOUT_MS),
        input: '',
        env: buildAgyEnvironment(process.env),
      },
    );
    const failure = classifyAgyFailure({
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      exitCode: result.status,
      timedOut: result.error?.name === 'TimeoutError' || result.signal === 'SIGTERM',
      structuredExpected: true,
    });
    if (failure) writeAgyCooldown(failure);
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

  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const yesNo = (value: boolean): string => value ? 'yes' : 'no';
  console.log(`AGY binary: ${report.binary.found ? `${report.binary.path} (${report.binary.version ?? 'version unknown'})` : 'not found'}`);
  console.log(`Authentication artifact: ${report.authentication}`);
  console.log(`Structured output: json=${yesNo(capabilities.outputJson)}, stream-json=${yesNo(capabilities.outputStreamJson)}, json-schema=${yesNo(capabilities.jsonSchema)}`);
  console.log(`Conversation controls: continue=${yesNo(capabilities.continuation)}, conversation=${yesNo(capabilities.conversation)}`);
  console.log(`PXPipe AGY route: ${routes.length > 0 ? `${routes.length} configured; target ${reachable ? 'reachable' : 'unreachable'}` : 'not configured (AGY runs direct)'}`);
  console.log(`Quota: ${report.quota.state}${report.quota.failure ? ` (${report.quota.failure})` : ''}`);
  if (!live) console.log('Live model call: not requested; use --live to perform one minimal call.');
  process.exitCode = report.ok ? 0 : 1;
}

function printAgyHelp(): void {
  console.log(`pxpipe AGY integration

Usage:
  pxpipe agy [AGY_ARGS...]
  pxpipe warp [--route PATTERN=TARGET]... -- agy [AGY_ARGS...]
  pxpipe doctor agy [--json] [--live]

AGY is kept on its native provider endpoint by default. No provider route is
injected unless PXPIPE_AGY_ROUTE or PXPIPE_AGY_ROUTES is configured, or a
--route is supplied to pxpipe warp. This preserves authentication, projects,
agents, plugins, model selection and Remote Control behavior.

Environment:
  PXPIPE_AGY_ROUTE        one PATTERN=TARGET route
  PXPIPE_AGY_ROUTES       semicolon/newline-separated routes
  PXPIPE_AGY_DEBUG        emit safe route diagnostics (never prompts/schemas)
  PXPIPE_AGY_LIVE_TIMEOUT_MS
                          doctor --live timeout (default 60000)
`);
}

export async function runAgyEntry(argv: readonly string[]): Promise<void> {
  if (argv[0] === 'doctor' && argv[1] === 'agy') {
    await runDoctor(argv.slice(2));
    return;
  }

  if (isAgyWarpInvocation(argv)) {
    try {
      const parsed = parseAgyWarpInvocation(argv);
      runAgyProcess(parsed.args, parsed.routes);
    } catch (error) {
      console.error(`[pxpipe] agy: ${(error as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (argv[0] === 'agy') {
    const args = argv.slice(1);
    if (args[0] === 'help' || args.includes('--pxpipe-help')) {
      printAgyHelp();
      return;
    }
    const cooldown = !isNonModelInvocation(args) ? readCooldown() : null;
    if (cooldown) {
      const remaining = Math.max(1, Math.ceil((cooldown.expiresAt - Date.now()) / 1000));
      console.error(`[pxpipe] agy: ${cooldown.failure}; retry after about ${remaining}s`);
      process.exit(1);
    }
    runAgyProcess(args, routeSpecsFromEnvironment());
    return;
  }

  throw new Error('unsupported AGY command dispatch');
}
