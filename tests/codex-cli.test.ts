import { describe, it, expect } from 'vitest';

import {
  buildCodexCommandArgs,
  buildCodexConfigArgs,
  buildCodexEnvironment,
  CODEX_MODEL_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  CODEX_REFERENCE_MODEL,
  codexCompressionGate,
  codexProviderBaseUrl,
  DEFAULT_CODEX_UPSTREAM,
  inspectCodexRoute,
  parseCodexInvocation,
  resolveCodexPersistentProxy,
  resolveCodexPort,
} from '../src/core/codex.js';
import { isPxpipeSupportedModelForScope } from '../src/core/applicability.js';
import { parseProviderRoute } from '../src/core/provider-router.js';

const okResponse = (body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('codex provider base url', () => {
  it('addresses the persistent listener rather than a wrapper-owned port', () => {
    expect(codexProviderBaseUrl(47821)).toBe('http://127.0.0.1:47821/providers/codex');
  });

  it('resolves to a path the provider router routes to the codex provider', () => {
    // Codex appends its endpoint to the configured base.
    const responses = new URL(`${codexProviderBaseUrl(47821)}/responses`);
    const parsed = parseProviderRoute(responses.pathname);
    expect(parsed).toEqual({ providerId: CODEX_PROVIDER_ID, upstreamPath: '/responses' });
  });

  it('routes the model listing Codex fetches on startup through the same provider', () => {
    const models = new URL(`${codexProviderBaseUrl(47821)}/models?client_version=0.147.0`);
    expect(parseProviderRoute(models.pathname)).toEqual({
      providerId: CODEX_PROVIDER_ID,
      upstreamPath: '/models',
    });
  });

  it('keeps the ChatGPT backend as the default upstream', () => {
    expect(DEFAULT_CODEX_UPSTREAM).toBe('https://chatgpt.com/backend-api/codex');
  });
});

describe('codex config overrides', () => {
  const args = buildCodexConfigArgs('http://127.0.0.1:47821/providers/codex');
  const pairs = args.filter((_value, index) => index % 2 === 1);

  it('declares its own provider instead of overriding the reserved built-in id', () => {
    // Codex refuses `model_providers.openai`: "Built-in providers cannot be overridden".
    expect(pairs.some((pair) => pair.startsWith('model_providers.openai.'))).toBe(false);
    expect(pairs).toContain(`model_providers.${CODEX_MODEL_PROVIDER_ID}.name=PXPipe`);
    expect(pairs).toContain(`model_provider=${CODEX_MODEL_PROVIDER_ID}`);
  });

  it('pins the HTTPS Responses transport instead of Codex\'s preferred WebSocket', () => {
    expect(pairs).toContain(`model_providers.${CODEX_MODEL_PROVIDER_ID}.supports_websockets=false`);
    expect(pairs).toContain(`model_providers.${CODEX_MODEL_PROVIDER_ID}.wire_api=responses`);
  });

  it('keeps ChatGPT authentication on the request', () => {
    expect(pairs).toContain(`model_providers.${CODEX_MODEL_PROVIDER_ID}.requires_openai_auth=true`);
  });

  it('passes every override through -c so no config file is written', () => {
    expect(args.filter((_value, index) => index % 2 === 0)).toEqual(Array(6).fill('-c'));
  });

  it('puts routing first and forwards user arguments verbatim', () => {
    const command = buildCodexCommandArgs('http://127.0.0.1:47821/providers/codex', [
      'exec', '--skip-git-repo-check', '-c', 'model=gpt-5.6-sol', 'do the thing',
    ]);
    expect(command.slice(0, args.length)).toEqual(args);
    expect(command.slice(args.length)).toEqual([
      'exec', '--skip-git-repo-check', '-c', 'model=gpt-5.6-sol', 'do the thing',
    ]);
  });
});

describe('parseCodexInvocation', () => {
  it('defaults to the codex executable with no arguments', () => {
    expect(parseCodexInvocation(['codex'], {})).toEqual({
      binary: 'codex', direct: false, args: [],
    });
  });

  it('selects an alternate executable', () => {
    expect(parseCodexInvocation(['codex', '--binary', 'codex-ar'], {})).toEqual({
      binary: 'codex-ar', direct: false, args: [],
    });
    expect(parseCodexInvocation(['codex', '--binary=codex-ar'], {})).toEqual({
      binary: 'codex-ar', direct: false, args: [],
    });
  });

  it('forwards Codex arguments after the wrapper flags', () => {
    expect(parseCodexInvocation(
      ['codex', '--binary', 'codex-ar', 'exec', '--skip-git-repo-check', 'hi'],
      {},
    )).toEqual({
      binary: 'codex-ar',
      direct: false,
      args: ['exec', '--skip-git-repo-check', 'hi'],
    });
  });

  it('stops consuming wrapper flags at the first Codex token', () => {
    // `--binary` after a Codex token belongs to Codex, not to pxpipe.
    expect(parseCodexInvocation(['codex', 'exec', '--binary', 'x'], {})).toEqual({
      binary: 'codex', direct: false, args: ['exec', '--binary', 'x'],
    });
  });

  it('treats everything after -- as Codex arguments', () => {
    expect(parseCodexInvocation(['codex', '--', '--direct', '--binary', 'x'], {})).toEqual({
      binary: 'codex', direct: false, args: ['--direct', '--binary', 'x'],
    });
  });

  it('supports an explicit direct (no-PXPipe) launch', () => {
    expect(parseCodexInvocation(['codex', '--direct', 'exec', 'hi'], {})).toEqual({
      binary: 'codex', direct: true, args: ['exec', 'hi'],
    });
  });

  it('honors PXPIPE_CODEX_BINARY as the default, with --binary winning', () => {
    expect(parseCodexInvocation(['codex'], { PXPIPE_CODEX_BINARY: 'codex-ar' }).binary)
      .toBe('codex-ar');
    expect(parseCodexInvocation(['codex', '--binary', 'codex'], { PXPIPE_CODEX_BINARY: 'codex-ar' }).binary)
      .toBe('codex');
  });

  it('rejects --binary without a value', () => {
    expect(() => parseCodexInvocation(['codex', '--binary'], {})).toThrow(/--binary/);
    expect(() => parseCodexInvocation(['codex', '--binary', '--direct'], {})).toThrow(/--binary/);
  });
});

describe('buildCodexEnvironment', () => {
  it('never touches CODEX_HOME, so an alternate executable keeps its own account', () => {
    const env = buildCodexEnvironment({ CODEX_HOME: '/home/dev/.codex-ar', PATH: '/usr/bin' });
    expect(env.CODEX_HOME).toBe('/home/dev/.codex-ar');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('drops an inherited endpoint override that would compete with the provider table', () => {
    const env = buildCodexEnvironment({ OPENAI_BASE_URL: 'http://example.invalid/v1' });
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it('drops a warp shell\'s loopback proxy so the child reaches PXPipe directly', () => {
    const env = buildCodexEnvironment({
      HTTPS_PROXY: 'http://127.0.0.1:44267',
      https_proxy: 'http://127.0.0.1:44267',
      HTTP_PROXY: 'http://127.0.0.1:44267',
      http_proxy: 'http://127.0.0.1:44267',
    });
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
  });

  it('keeps a genuine corporate proxy that is not our own loopback listener', () => {
    const env = buildCodexEnvironment({ HTTPS_PROXY: 'http://proxy.corp.example:3128' });
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp.example:3128');
  });

  it('exempts loopback from any surviving proxy configuration', () => {
    const env = buildCodexEnvironment({ NO_PROXY: 'example.com' });
    expect(env.NO_PROXY?.split(',')).toEqual(['example.com', '127.0.0.1', 'localhost', '::1']);
    expect(env.no_proxy).toContain('127.0.0.1');
  });

  it('removes a PXPipe-only CA bundle that would hide the system roots from Codex', () => {
    const env = buildCodexEnvironment(
      {
        SSL_CERT_FILE: '/home/dev/.pxpipe/warp-ca.pem',
        CURL_CA_BUNDLE: '/home/dev/.pxpipe/warp-ca.pem',
        REQUESTS_CA_BUNDLE: '/home/dev/.pxpipe/warp-ca.pem',
        NODE_EXTRA_CA_CERTS: '/home/dev/.pxpipe/warp-ca.pem',
      },
      { caCertPath: '/home/dev/.pxpipe/warp-ca.pem' },
    );
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('leaves an unrelated CA bundle alone', () => {
    const env = buildCodexEnvironment(
      { SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' },
      { caCertPath: '/home/dev/.pxpipe/warp-ca.pem' },
    );
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/certs/ca-certificates.crt');
  });
});

describe('persistent listener reuse', () => {
  it('reuses the running listener and binds nothing itself', async () => {
    const seen: string[] = [];
    const proxy = await resolveCodexPersistentProxy({}, (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return okResponse({ requests: 0 });
    }) as typeof fetch);
    expect(seen).toEqual(['http://127.0.0.1:47821/proxy-stats']);
    expect(proxy).toEqual({ baseUrl: 'http://127.0.0.1:47821/providers/codex', port: 47821 });
  });

  it('honors PORT so a non-default listener is reused, not duplicated', async () => {
    const proxy = await resolveCodexPersistentProxy(
      { PORT: '48000' },
      (async () => okResponse()) as typeof fetch,
    );
    expect(proxy?.port).toBe(48000);
    expect(proxy?.baseUrl).toBe('http://127.0.0.1:48000/providers/codex');
  });

  it('falls back to direct mode when the listener is down, instead of starting one', async () => {
    const proxy = await resolveCodexPersistentProxy({}, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    expect(proxy).toBeNull();
  });

  it('falls back to direct mode when the listener answers unhealthy', async () => {
    const proxy = await resolveCodexPersistentProxy(
      {},
      (async () => new Response('nope', { status: 503 })) as typeof fetch,
    );
    expect(proxy).toBeNull();
  });

  it('ignores an unparseable PORT rather than picking a random one', () => {
    expect(resolveCodexPort({ PORT: 'nonsense' })).toBe(47821);
    expect(resolveCodexPort({ PORT: '-1' })).toBe(47821);
    expect(resolveCodexPort({})).toBe(47821);
  });
});

describe('route readiness', () => {
  it('reports ready when the listener serves the codex provider', async () => {
    const readiness = await inspectCodexRoute(47821, (async () => okResponse({
      profile: 'coding-safe',
      providers: [{ id: 'anthropic' }, { id: 'codex' }, { id: 'google' }],
    })) as typeof fetch);
    expect(readiness).toEqual({
      reachable: true,
      codexRouteReady: true,
      providers: ['anthropic', 'codex', 'google'],
      profile: 'coding-safe',
    });
  });

  it('reports not-ready against an older listener without the codex route', async () => {
    const readiness = await inspectCodexRoute(47821, (async () => okResponse({
      providers: [{ id: 'anthropic' }, { id: 'openai' }],
    })) as typeof fetch);
    expect(readiness.reachable).toBe(true);
    expect(readiness.codexRouteReady).toBe(false);
  });

  it('reports not-ready when the listener cannot be reached', async () => {
    const readiness = await inspectCodexRoute(47821, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    expect(readiness).toEqual({ reachable: false, codexRouteReady: false, providers: [] });
  });

  it('reads the profile from the listener, not from the doctor\'s own shell', async () => {
    const readiness = await inspectCodexRoute(47821, (async () => okResponse({
      profile: 'coding-safe',
      providers: [{ id: 'codex' }],
    })) as typeof fetch);
    expect(readiness.profile).toBe('coding-safe');
  });
});

describe('codex compression gate reporting', () => {
  // Routing and compression are separate: doctor must not imply savings that
  // the active safety scope will not deliver.
  it('reports compression active when daemon allowedModelBases includes gpt-5.6-sol under coding-safe', () => {
    const gate = codexCompressionGate(
      'coding-safe',
      CODEX_REFERENCE_MODEL,
      isPxpipeSupportedModelForScope,
      ['claude-sonnet-5', 'gpt-5.6-sol'],
    );
    expect(gate).toEqual({ profile: 'coding-safe', model: 'gpt-5.6-sol', compresses: true });
  });

  it('reports compression inactive when daemon allowedModelBases excludes gpt-5.6-sol', () => {
    const gate = codexCompressionGate(
      'coding-safe',
      CODEX_REFERENCE_MODEL,
      isPxpipeSupportedModelForScope,
      ['claude-sonnet-5'],
    );
    expect(gate).toEqual({ profile: 'coding-safe', model: 'gpt-5.6-sol', compresses: false });
  });

  it('caller shell env cannot make doctor disagree with daemon when allowedModelBases is returned', () => {
    const previous = process.env.PXPIPE_MODELS;
    process.env.PXPIPE_MODELS = 'unrelated-model';
    try {
      // Daemon environment has gpt-5.6-sol, caller shell environment does not.
      const gate = codexCompressionGate(
        'coding-safe',
        CODEX_REFERENCE_MODEL,
        isPxpipeSupportedModelForScope,
        ['claude-sonnet-5', 'gpt-5.6-sol'],
      );
      expect(gate.compresses).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = previous;
    }
  });

  it('reports compression active once an operator selects a scope that admits GPT', () => {
    const previous = process.env.PXPIPE_MODELS;
    process.env.PXPIPE_MODELS = 'gpt-5.6-sol';
    try {
      const gate = codexCompressionGate('aggressive', CODEX_REFERENCE_MODEL, isPxpipeSupportedModelForScope);
      expect(gate.compresses).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = previous;
    }
  });

  it('assumes the default profile when the listener does not report one', () => {
    expect(codexCompressionGate(undefined, CODEX_REFERENCE_MODEL, isPxpipeSupportedModelForScope).profile)
      .toBe('coding-safe');
  });
});
