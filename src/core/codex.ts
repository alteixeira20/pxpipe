/**
 * Codex CLI integration.
 *
 * Codex 0.147 authenticates with ChatGPT tokens and sends inference to
 * `https://chatgpt.com/backend-api/codex/responses`. Two facts decide the shape
 * of this integration, both established against the local 0.147 executable:
 *
 *  1. `OPENAI_BASE_URL` is ignored under ChatGPT auth. Only the config layer
 *     redirects inference, and the built-in `openai` provider id is reserved
 *     ("Built-in providers cannot be overridden"). So PXPipe declares its own
 *     `model_providers.pxpipe` entry and selects it — through `-c` overrides,
 *     which touch no file, so CODEX_HOME, config.toml and auth.json are left
 *     exactly as the user has them.
 *  2. Codex prefers a WebSocket transport for the Responses endpoint
 *     (`prefer_websockets` in its model catalog) and only falls back to HTTPS
 *     after the upgrade fails. `ModelProviderInfo` exposes a supported
 *     `supports_websockets` switch; setting it false on our provider makes
 *     Codex use the plain HTTPS Responses transport from the first request,
 *     with no failed-upgrade noise and no speculative WebSocket proxy here.
 *
 * The child is pointed at the persistent PXPipe listener's own provider route,
 * so nothing binds a second port and no CA is involved: the hop from Codex to
 * PXPipe is plain loopback HTTP, and PXPipe re-originates TLS to ChatGPT.
 */

/** Where PXPipe forwards Codex inference. Overridable for API-key deployments
 *  (`PXPIPE_CODEX_UPSTREAM=https://api.openai.com/v1`). */
export const DEFAULT_CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex';

/** PXPipe's provider-router id: `/providers/codex/...`. */
export const CODEX_PROVIDER_ID = 'codex';

/** The id Codex knows this provider by, inside its own config namespace. */
export const CODEX_MODEL_PROVIDER_ID = 'pxpipe';

export const DEFAULT_CODEX_PORT = 47821;

/** Codex appends `/responses` and `/models` to this base. Deliberately without
 *  a `/v1` segment: PXPipe strips the `/providers/codex` prefix and forwards
 *  the remainder onto the upstream base, which already carries its own path. */
export function codexProviderBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/providers/${CODEX_PROVIDER_ID}`;
}

/**
 * The `-c` overrides that route one Codex process through PXPipe.
 *
 * `requires_openai_auth` keeps the ChatGPT bearer, account id and originator
 * headers on the request, so the upstream still sees the user's own session and
 * PXPipe never reads, stores or rewrites the credential.
 */
export function buildCodexConfigArgs(baseUrl: string): string[] {
  const provider = `model_providers.${CODEX_MODEL_PROVIDER_ID}`;
  return [
    '-c', `${provider}.name=PXPipe`,
    '-c', `${provider}.base_url=${baseUrl}`,
    '-c', `${provider}.wire_api=responses`,
    '-c', `${provider}.requires_openai_auth=true`,
    '-c', `${provider}.supports_websockets=false`,
    '-c', `model_provider=${CODEX_MODEL_PROVIDER_ID}`,
  ];
}

function isLoopbackProxyUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value.includes('://') ? value : `http://${value}`);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function appendNoProxy(existing: string | undefined): string {
  const wanted = ['127.0.0.1', 'localhost', '::1'];
  const have = (existing ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const entry of wanted) if (!have.includes(entry)) have.push(entry);
  return have.join(',');
}

export interface CodexEnvironmentOptions {
  /** PXPipe's own CA file. Inherited trust overrides pointing at it are removed
   *  from the child: they would replace the system roots for OpenSSL-style
   *  clients and break Codex's direct auth/update traffic. */
  caCertPath?: string;
}

/**
 * Environment for the Codex child.
 *
 * CODEX_HOME is deliberately untouched — that is the whole reason a wrapper
 * script like `codex-ar` (which exports its own CODEX_HOME before exec'ing
 * codex) keeps its separate account when launched through PXPipe.
 */
export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv,
  options: CodexEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env = { ...source };

  // An inherited endpoint override from another wrapper must not compete with
  // the provider table we install. Codex ignores this under ChatGPT auth, but
  // an API-key user would silently be sent somewhere else.
  delete env.OPENAI_BASE_URL;

  // A `pxpipe warp` shell exports a loopback proxy and a CA bundle containing
  // only PXPipe's certificate. Both are correct for the process warp launched
  // and wrong for this one: we speak plain HTTP to loopback, and Codex still
  // needs the real system roots for its own auth and update traffic.
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const) {
    if (isLoopbackProxyUrl(env[key])) delete env[key];
  }
  if (options.caCertPath) {
    for (const key of [
      'SSL_CERT_FILE',
      'CURL_CA_BUNDLE',
      'REQUESTS_CA_BUNDLE',
      'NODE_EXTRA_CA_CERTS',
    ] as const) {
      if (env[key] === options.caCertPath) delete env[key];
    }
  }
  // Any surviving proxy configuration must not swallow the loopback hop.
  env.NO_PROXY = appendNoProxy(env.NO_PROXY);
  env.no_proxy = appendNoProxy(env.no_proxy);

  return env;
}

export interface CodexInvocation {
  /** Executable to run: `codex` by default, or an alternate such as `codex-ar`. */
  binary: string;
  /** Skip PXPipe entirely and run the agent untouched. */
  direct: boolean;
  /** Everything forwarded to Codex verbatim. */
  args: string[];
}

/**
 * `pxpipe codex [--binary NAME] [--direct] [--] [codex args...]`
 *
 * PXPipe flags are only recognised in the leading position, and `--` ends them
 * explicitly, so any Codex flag of the same spelling still reaches Codex.
 */
export function parseCodexInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CodexInvocation {
  const rest = argv[0] === 'codex' ? argv.slice(1) : [...argv];
  let binary = env.PXPIPE_CODEX_BINARY?.trim() || 'codex';
  let direct = false;
  let index = 0;

  for (; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--binary') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--binary requires an executable name or path');
      }
      binary = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--binary=')) {
      binary = arg.slice('--binary='.length);
      if (!binary) throw new Error('--binary requires an executable name or path');
      continue;
    }
    if (arg === '--direct') {
      direct = true;
      continue;
    }
    break;
  }

  return { binary, direct, args: rest.slice(index) };
}

/** Full argument vector for the child: PXPipe routing first, user args verbatim. */
export function buildCodexCommandArgs(baseUrl: string, args: readonly string[]): string[] {
  return [...buildCodexConfigArgs(baseUrl), ...args];
}

export function resolveCodexPort(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env.PORT ?? DEFAULT_CODEX_PORT);
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CODEX_PORT;
}

export interface CodexPersistentProxy {
  baseUrl: string;
  port: number;
}

/**
 * Resolve the already-running persistent PXPipe listener.
 *
 * Nothing is ever bound here: reusing the service is the point, and a wrapper
 * that started its own server would collide with it (EADDRINUSE) rather than
 * cooperate. A health failure means "run Codex direct", not "fail the launch" —
 * compression is an optimisation, never a prerequisite for coding.
 */
export async function resolveCodexPersistentProxy(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<CodexPersistentProxy | null> {
  const port = resolveCodexPort(env);
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/proxy-stats`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
  } catch {
    return null;
  }
  return { baseUrl: codexProviderBaseUrl(port), port };
}

export interface CodexRouteReadiness {
  reachable: boolean;
  codexRouteReady: boolean;
  providers: string[];
  /** Compression profile the listener is actually running, not the doctor's env. */
  profile?: string;
  /** Allowed model bases from the running listener. */
  allowedModelBases?: string[];
}

/** Ask the persistent listener which provider routes it actually serves. */
export async function inspectCodexRoute(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<CodexRouteReadiness> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/proxy-routes`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return { reachable: false, codexRouteReady: false, providers: [] };
    const body = await response.json() as {
      providers?: Array<{ id?: unknown }>;
      profile?: unknown;
      allowedModelBases?: unknown;
    };
    const providers = (body.providers ?? [])
      .map((provider) => (typeof provider?.id === 'string' ? provider.id : ''))
      .filter(Boolean);
    const allowedModelBases = Array.isArray(body.allowedModelBases)
      ? body.allowedModelBases.filter((b): b is string => typeof b === 'string')
      : undefined;
    return {
      reachable: true,
      codexRouteReady: providers.includes(CODEX_PROVIDER_ID),
      providers,
      ...(typeof body.profile === 'string' ? { profile: body.profile } : {}),
      ...(allowedModelBases ? { allowedModelBases } : {}),
    };
  } catch {
    return { reachable: false, codexRouteReady: false, providers: [] };
  }
}

/** The model Codex ships as its default, used to report the compression gate. */
export const CODEX_REFERENCE_MODEL = 'gpt-5.6-sol';

export interface CodexCompressionGate {
  profile: string;
  model: string;
  /** Whether the listener's active scope admits this model for compression. */
  compresses: boolean;
}

/**
 * Whether Codex traffic is merely routed or actually compressed.
 *
 * Routing and compression are independent: `coding-safe` admits only model
 * families that have passed the coding non-inferiority suite, so a correctly
 * wired Codex route can still forward every request untransformed. Reporting
 * this explicitly is the difference between "PXPipe is doing nothing" and
 * "PXPipe is measuring but deliberately not compressing GPT yet".
 */
export function codexCompressionGate(
  profile: string | undefined,
  model: string,
  admits: (model: string, scope: SafetyScopeName, allowedBases?: readonly string[]) => boolean,
  allowedBases?: readonly string[],
): CodexCompressionGate {
  const scope = (profile ?? 'coding-safe') as SafetyScopeName;
  return { profile: scope, model, compresses: admits(model, scope, allowedBases) };
}

type SafetyScopeName = 'coding-safe' | 'balanced' | 'aggressive' | 'passthrough';
