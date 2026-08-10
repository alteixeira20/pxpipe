import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { findExecutable } from './agy.js';
import { isPxpipeSupportedModelForScope } from './core/applicability.js';
import {
  buildCodexCommandArgs,
  buildCodexEnvironment,
  CODEX_PROVIDER_ID,
  CODEX_REFERENCE_MODEL,
  codexCompressionGate,
  inspectCodexRoute,
  parseCodexInvocation,
  resolveCodexPersistentProxy,
  resolveCodexPort,
  type CodexCompressionGate,
  type CodexInvocation,
} from './core/codex.js';
import {
  resolveCodexModelSelection,
  type CodexModelSelection,
} from './core/codex-model.js';
import { CertificateAuthority } from './warp/ca.js';

interface CodexDoctorReport {
  ok: boolean;
  binary: { requested: string; found: boolean; path?: string; version?: string };
  listener: { url: string; reachable: boolean };
  route: { ready: boolean; providers: string[]; baseUrl?: string };
  ca: { present: boolean; path?: string };
  model: CodexModelSelection & { configPath: string };
  profile: string;
  compression: CodexCompressionGate;
  transport: 'https-responses';
  /** Overall launch mode PXPipe would pick right now. */
  mode: 'persistent' | 'direct';
}

function caStatus(): { present: boolean; path?: string } {
  try {
    const ca = CertificateAuthority.loadOrCreate(join(homedir(), '.pxpipe'));
    return { present: true, path: ca.certPath };
  } catch {
    return { present: false };
  }
}

function safeVersion(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : undefined;
}

function codexConfigPath(env: NodeJS.ProcessEnv): string {
  const root = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(root, 'config.toml');
}

function currentCodexModel(
  invocation: CodexInvocation,
  env: NodeJS.ProcessEnv,
): CodexModelSelection & { configPath: string } {
  const configPath = codexConfigPath(env);
  let configText: string | undefined;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch {
    // A missing/unreadable config must never block the agent. The resolver will
    // report its reference model and the actual request telemetry remains the
    // final source of truth once Codex starts.
  }
  return {
    ...resolveCodexModelSelection(invocation.args, configText, CODEX_REFERENCE_MODEL),
    configPath,
  };
}

/**
 * Run the child so PXPipe is transparent to whoever called it: same stdio, same
 * signals, same exit status. PXPipe adds routing, never a lifecycle of its own.
 */
function spawnTransparent(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, [...args], { stdio: 'inherit', env, cwd: process.cwd() });
  const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwarded) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  child.on('error', (error) => {
    cleanup();
    console.error(`[pxpipe] codex: cannot run ${command}: ${error.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  return child;
}

function resolveBinary(invocation: CodexInvocation): string {
  const binary = findExecutable(invocation.binary);
  if (!binary) {
    console.error(
      `[pxpipe] codex: executable ${JSON.stringify(invocation.binary)} not found on PATH`,
    );
    console.error('[pxpipe] codex: install Codex, or select another one with --binary NAME');
    process.exit(127);
  }
  return binary;
}

async function runCodexDoctor(args: readonly string[]): Promise<void> {
  const json = args.includes('--json');
  const invocation = parseCodexInvocation(args.filter((arg) => arg !== '--json'));
  const port = resolveCodexPort();
  const ca = caStatus();
  const env = buildCodexEnvironment(process.env, { caCertPath: ca.path });
  const binaryPath = findExecutable(invocation.binary);
  const model = currentCodexModel(invocation, process.env);
  const persistent = await resolveCodexPersistentProxy();
  const route = persistent
    ? await inspectCodexRoute(port)
    : { reachable: false, codexRouteReady: false, providers: [] as string[] };

  const report: CodexDoctorReport = {
    ok: Boolean(binaryPath) && persistent !== null && route.codexRouteReady,
    binary: {
      requested: invocation.binary,
      found: Boolean(binaryPath),
      ...(binaryPath ? { path: binaryPath, version: safeVersion(binaryPath, env) } : {}),
    },
    listener: { url: `http://127.0.0.1:${port}/`, reachable: persistent !== null },
    route: {
      ready: route.codexRouteReady,
      providers: route.providers,
      ...(persistent ? { baseUrl: persistent.baseUrl } : {}),
    },
    ca,
    model,
    profile: route.profile ?? (process.env.PXPIPE_PROFILE?.trim() || 'coding-safe'),
    compression: codexCompressionGate(
      route.profile,
      model.model,
      isPxpipeSupportedModelForScope,
      route.allowedModelBases,
    ),
    transport: 'https-responses',
    mode: persistent && route.codexRouteReady ? 'persistent' : 'direct',
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  console.log(`Codex executable: ${report.binary.found
    ? `${report.binary.path} (${report.binary.version ?? 'version unknown'})`
    : `${report.binary.requested} — NOT FOUND on PATH`}`);
  console.log(`Persistent listener: ${report.listener.reachable ? 'reachable' : 'UNAVAILABLE'} at ${report.listener.url}`);
  console.log(`Codex inference route: ${report.route.ready
    ? `ready → ${report.route.baseUrl}`
    : report.listener.reachable
      ? `UNAVAILABLE (listener serves: ${report.route.providers.join(', ') || 'none'})`
      : 'UNAVAILABLE (listener down)'}`);
  console.log(`PXPipe CA: ${report.ca.present ? report.ca.path : 'UNAVAILABLE'} (not used by the Codex route)`);
  const modelSource = report.model.source === 'profile' && report.model.profile
    ? `profile ${report.model.profile}`
    : report.model.source;
  console.log(`Codex model: ${report.model.model} (${modelSource})`);
  console.log(`Compression profile: ${report.profile}`);
  console.log(report.compression.compresses
    ? `Codex compression: ACTIVE for ${report.compression.model} under ${report.compression.profile}`
    : `Codex compression: INACTIVE — ${report.compression.profile} does not admit ${report.compression.model}; `
      + 'Codex traffic is routed and measured but forwarded untransformed');
  console.log('Transport: HTTPS Responses (WebSocket disabled per launch, not globally)');
  console.log(`Launch mode: ${report.mode}${report.mode === 'direct' ? ' — Codex would bypass PXPipe' : ''}`);
  process.exitCode = report.ok ? 0 : 1;
}

/**
 * `pxpipe codex` / `pxpipe doctor codex`.
 *
 * The persistent listener is reused, never rebound; if it is not running the
 * launch still succeeds, loudly, in direct mode, because a developer must not
 * lose their agent because a token optimiser is down.
 */
export async function runCodexEntry(argv: readonly string[]): Promise<void> {
  if (argv[0] === 'doctor' && argv[1] === 'codex') {
    await runCodexDoctor(argv.slice(2));
    return;
  }

  let invocation: CodexInvocation;
  try {
    invocation = parseCodexInvocation(argv);
  } catch (error) {
    console.error(`[pxpipe] codex: ${(error as Error).message}`);
    process.exit(2);
  }

  const binary = resolveBinary(invocation);

  if (invocation.direct) {
    // An explicit direct launch means exactly that: preserve the caller's own
    // provider/base-url/proxy environment rather than applying PXPipe routing
    // sanitation before bypassing PXPipe.
    console.error('[pxpipe] codex: --direct requested — running Codex without PXPipe routing');
    spawnTransparent(binary, invocation.args, process.env);
    return;
  }

  const ca = caStatus();
  const env = buildCodexEnvironment(process.env, { caCertPath: ca.path });
  const model = currentCodexModel(invocation, process.env);
  const persistent = await resolveCodexPersistentProxy();
  if (!persistent) {
    console.error(
      `[pxpipe] codex: persistent PXPipe listener unavailable on port ${resolveCodexPort()} — `
      + 'running Codex direct (no compression). Start it with `pxpipe` and retry.',
    );
    spawnTransparent(binary, invocation.args, env);
    return;
  }

  const route = await inspectCodexRoute(persistent.port);
  if (!route.codexRouteReady) {
    console.error(
      `[pxpipe] codex: listener on ${persistent.port} serves no /providers/${CODEX_PROVIDER_ID} route `
      + '(older build?) — running Codex direct (no compression).',
    );
    spawnTransparent(binary, invocation.args, env);
    return;
  }

  const compression = codexCompressionGate(
    route.profile,
    model.model,
    isPxpipeSupportedModelForScope,
    route.allowedModelBases,
  );
  console.error(`[pxpipe] codex → ${persistent.baseUrl} (HTTPS Responses, persistent listener reused)`);
  console.error(compression.compresses
    ? `[pxpipe] codex compression ACTIVE → ${model.model} / ${compression.profile}`
    : `[pxpipe] codex compression INACTIVE → ${model.model} is outside ${compression.profile}; routing/accounting remain active`);

  // Pin only a model that came from persistent user configuration/profile. An
  // explicit CLI model already has higher precedence, while the diagnostic
  // reference must never overwrite a future Codex default.
  const routedModel = model.source === 'config' || model.source === 'profile'
    ? model.model
    : undefined;
  spawnTransparent(
    binary,
    buildCodexCommandArgs(persistent.baseUrl, invocation.args, routedModel),
    env,
  );
}
