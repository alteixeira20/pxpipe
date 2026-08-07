from pathlib import Path

node = Path('src/node.ts')
text = node.read_text()

old = "import { createFailOpenProxy } from './core/fail-open.js';\n"
new = old + "import { createProviderRouter } from './core/provider-router.js';\n"
if old not in text:
    raise SystemExit('provider router import insertion point not found')
text = text.replace(old, new, 1)

old = """  openAIUpstream: string;
  openAIApiKey?: string;
  /** Independent Cloudflare OpenAI-compatible endpoint. */
"""
new = """  openAIUpstream: string;
  openAIApiKey?: string;
  /** Dedicated upstreams for the single-listener explicit provider registry. */
  featherlessUpstream: string;
  featherlessApiKey?: string;
  googleUpstream: string;
  /** Independent Cloudflare OpenAI-compatible endpoint. */
"""
if old not in text:
    raise SystemExit('RuntimeConfig provider fields insertion point not found')
text = text.replace(old, new, 1)

old = """    openAIUpstream: process.env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com',
    openAIApiKey: process.env.OPENAI_API_KEY,
    cloudflareUpstream,
"""
new = """    openAIUpstream: process.env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com',
    openAIApiKey: process.env.OPENAI_API_KEY,
    featherlessUpstream: process.env.FEATHERLESS_UPSTREAM ?? 'https://api.featherless.ai',
    featherlessApiKey: process.env.FEATHERLESS_API_KEY
      ?? (process.env.PXPIPE_PROVIDER === 'featherless' ? process.env.OPENAI_API_KEY : undefined),
    googleUpstream: process.env.GOOGLE_UPSTREAM ?? 'https://generativelanguage.googleapis.com',
    cloudflareUpstream,
"""
if old not in text:
    raise SystemExit('parseCli provider defaults insertion point not found')
text = text.replace(old, new, 1)

old = """  const handle = createFailOpenProxy(config);

  const server = createServer((req, res) => {
"""
new = """  // One persistent listener now owns legacy routes and explicit provider routes.
  // Each provider still gets an isolated createProxy instance (capability cache,
  // circuit breaker and upstream config), but every instance is wrapped in the
  // same transform-only fail-open policy before the router sees it.
  const providerRouter = createProviderRouter({
    defaultProxy: config,
    handlerFactory: createFailOpenProxy,
    providers: [
      {
        id: 'anthropic',
        protocol: 'anthropic',
        proxy: {
          ...config,
          provider: undefined,
          upstream: opts.upstream,
          openAIModels: [],
          cloudflareModels: [],
        },
      },
      {
        id: 'openai',
        protocol: 'openai',
        proxy: {
          ...config,
          provider: undefined,
          upstream: opts.upstream,
          apiKey: undefined,
          authToken: undefined,
          openAIUpstream: opts.openAIUpstream,
          openAIApiKey: opts.openAIApiKey,
          cloudflareModels: [],
        },
      },
      {
        id: 'featherless',
        protocol: 'openai',
        proxy: {
          ...config,
          provider: 'featherless',
          upstream: opts.upstream,
          apiKey: undefined,
          authToken: undefined,
          openAIUpstream: opts.featherlessUpstream,
          openAIApiKey: opts.featherlessApiKey,
          openAIModels: undefined,
          cloudflareModels: [],
        },
      },
      {
        id: 'google',
        protocol: 'google',
        proxy: {
          ...config,
          provider: undefined,
          upstream: opts.googleUpstream,
          apiKey: undefined,
          authToken: undefined,
          openAIApiKey: undefined,
          openAIModels: [],
          cloudflareModels: [],
        },
      },
    ],
  });
  const handle = providerRouter;

  const server = createServer((req, res) => {
"""
if old not in text:
    raise SystemExit('provider router host wiring insertion point not found')
text = text.replace(old, new, 1)

old = """    console.log(`[pxpipe] openai upstream → ${routes.openai}`);
    if (opts.cloudflareUpstream !== undefined) {
"""
new = """    console.log(`[pxpipe] openai upstream → ${routes.openai}`);
    console.log(`[pxpipe] featherless provider route → ${opts.featherlessUpstream}`);
    console.log(`[pxpipe] google provider route → ${opts.googleUpstream}`);
    console.log(
      `[pxpipe] provider routes → ${providerRouter.inspect().providers.map((provider) => provider.prefix).join(', ')}`,
    );
    if (opts.cloudflareUpstream !== undefined) {
"""
if old not in text:
    raise SystemExit('announce provider routes insertion point not found')
node.write_text(text.replace(old, new, 1))

# Export the host-factory types for library consumers that build their own single listener.
index = Path('src/core/index.ts')
text = index.read_text()
old = """  type ProviderProtocol,
  type ProviderRouteDefinition,
  type ProviderRouterConfig,
  type ProviderRouterInspection,
} from './provider-router.js';
"""
new = """  type ProviderProtocol,
  type ProviderProxyHandler,
  type ProviderHandlerFactory,
  type ProviderRouteDefinition,
  type ProviderRouterConfig,
  type ProviderRouterInspection,
} from './provider-router.js';
"""
if old not in text:
    raise SystemExit('provider router export insertion point not found')
index.write_text(text.replace(old, new, 1))

# Add a focused unit test proving a product host can wrap every route without
# changing router semantics.
test = Path('tests/provider-router.test.ts')
text = test.read_text()
marker = "\n});\n"
pos = text.rfind(marker)
if pos < 0:
    raise SystemExit('provider-router describe terminator not found')
addition = r'''

  it('uses a host handler factory for legacy and explicit provider routes', async () => {
    const built: string[] = [];
    const factory = (proxy: ProxyConfig) => {
      built.push(proxy.upstream ?? proxy.openAIUpstream ?? 'default');
      const lowLevel = createProxy(proxy);
      return (request: Request) => lowLevel(request);
    };
    const fetcher = vi.fn(async (request: Request | string | URL) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      return new Response(JSON.stringify({ url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example', customFetch: fetcher as typeof fetch },
      providers: [{
        id: 'anthropic',
        protocol: 'anthropic',
        proxy: { upstream: 'https://anthropic.example', customFetch: fetcher as typeof fetch },
      }],
      handlerFactory: factory,
    });

    expect(built).toEqual(['https://legacy.example', 'https://anthropic.example']);
    const legacy = await router(new Request('http://local/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unsupported-test-model', messages: [] }),
    }));
    expect(legacy.status).toBe(200);
    const explicit = await router(new Request('http://local/providers/anthropic/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unsupported-test-model', messages: [] }),
    }));
    expect(explicit.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
'''
test.write_text(text[:pos] + addition + text[pos:])
