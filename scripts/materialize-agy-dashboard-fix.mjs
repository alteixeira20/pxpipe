import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, text) { fs.writeFileSync(path, text); }
function replaceOnce(path, needle, replacement) {
  const text = read(path);
  if (!text.includes(needle)) throw new Error(`missing needle in ${path}: ${needle.slice(0, 120)}`);
  write(path, text.replace(needle, replacement));
}
function replaceRegex(path, pattern, replacement) {
  const text = read(path);
  if (!pattern.test(text)) throw new Error(`missing pattern in ${path}: ${pattern}`);
  write(path, text.replace(pattern, replacement));
}
function appendIfMissing(path, marker, addition) {
  const text = read(path);
  if (!text.includes(marker)) write(path, text + addition);
}

// ---------------------------------------------------------------------------
// 1. Separate requested dashboard model scope from effective safe scope.
//    Gemini 3.6 Flash is now validated by the provider-specific coding-safe path.
// ---------------------------------------------------------------------------
replaceOnce(
  'src/core/applicability.ts',
  "const SAFE_VALIDATED_MODEL_BASES = ['claude-fable-5'];",
  "const SAFE_VALIDATED_MODEL_BASES = ['claude-fable-5', 'gemini-3.6-flash'];",
);
replaceOnce(
  'src/core/applicability.ts',
  "/** Current effective allowed-model scope after host semantic safety filtering. */\nexport function getAllowedModelBases(): string[] {\n  return allowedModelBases();\n}\n\n/** PXPIPE_MODELS env / historical default scope, independent of runtime override and safety filtering. */\nexport function getConfiguredModelBases(): string[] {\n  return envOrDefaultBases();\n}\n",
  "/** Current effective allowed-model scope after host semantic safety filtering. */\nexport function getAllowedModelBases(): string[] {\n  return allowedModelBases();\n}\n\n/** User-requested runtime scope before semantic safety filtering. Dashboard\n * controls must mutate this set rather than the filtered set or a blocked model\n * click can silently erase other requested models. */\nexport function getRequestedModelBases(): string[] {\n  return configuredModelBases();\n}\n\n/** PXPIPE_MODELS env / historical default scope, independent of runtime override and safety filtering. */\nexport function getConfiguredModelBases(): string[] {\n  return envOrDefaultBases();\n}\n",
);
replaceOnce(
  'src/core/index.ts',
  '  getConfiguredModelBases,\n',
  '  getConfiguredModelBases,\n  getRequestedModelBases,\n',
);

replaceOnce(
  'src/dashboard.ts',
  '  getAllowedModelBases,\n  getConfiguredModelBases,\n',
  '  getAllowedModelBases,\n  getRequestedModelBases,\n',
);
replaceOnce(
  'src/dashboard.ts',
  "   *  Defaults to TRUE since 2026-06-09: scope is Fable 5 only, which reads\n   *  renders at 100/100 (no Opus read tax) with the same image billing, and\n",
  "   *  Defaults to TRUE. The coding-safe scope currently validates Fable 5 and\n   *  Gemini 3.6 Flash (including AGY effort aliases); other requested families\n   *  remain configured but inactive until their safe provider path is validated.\n",
);
replaceOnce(
  'src/dashboard.ts',
  '            getAllowedModelBases(),\n            getConfiguredModelBases(),\n            this.compressionEnabled,\n',
  '            getAllowedModelBases(),\n            getRequestedModelBases(),\n            this.compressionEnabled,\n',
);
replaceOnce(
  'src/dashboard.ts',
  '  handleModelsToggle(model: string, on: boolean): void {\n    const next = new Set(getAllowedModelBases());\n',
  '  handleModelsToggle(model: string, on: boolean): void {\n    const next = new Set(getRequestedModelBases());\n',
);

replaceOnce(
  'src/dashboard/fragments.ts',
  '  const on = new Set(active);\n',
  '  const effective = new Set(active);\n  const requested = new Set(configured);\n',
);
replaceOnce(
  'src/dashboard/fragments.ts',
  "  const chipFor = (id: string): string => {\n    const lit = on.has(id);\n    const label = labelOf.get(id) ?? id;\n    return (\n      `<button class=\"chip${lit ? ' on' : ''}\" type=\"button\" ` +\n      `hx-post=\"/fragments/models\" hx-target=\"#frag-models\" ` +\n      `hx-vals='${escapeHtml(`{\"model\":${JSON.stringify(id)},\"on\":${!lit}}`)}'>${escapeHtml(label)}${lit ? ' ✓' : ''}</button>`\n    );\n  };\n",
  "  const chipFor = (id: string): string => {\n    const lit = effective.has(id);\n    const wanted = requested.has(id);\n    const label = labelOf.get(id) ?? id;\n    const state = lit ? ' ✓' : wanted ? ' · configured' : '';\n    const title = wanted && !lit\n      ? 'Configured in PXPIPE_MODELS, but blocked by the current semantic safety profile.'\n      : lit ? 'Configured and active.' : 'Not configured.';\n    return (\n      `<button class=\"chip${lit ? ' on' : wanted ? ' configured' : ''}\" type=\"button\" ` +\n      `title=\"${escapeHtml(title)}\" hx-post=\"/fragments/models\" hx-target=\"#frag-models\" ` +\n      `hx-vals='${escapeHtml(`{\"model\":${JSON.stringify(id)},\"on\":${!wanted}}`)}'>${escapeHtml(label + state)}</button>`\n    );\n  };\n",
);
replaceOnce(
  'src/dashboard/fragments.ts',
  '    `value="${escapeHtml(active.join(\',\'))}" spellcheck="false" autocomplete="off" ` +\n',
  '    `value="${escapeHtml(configured.join(\',\'))}" spellcheck="false" autocomplete="off" ` +\n',
);
replaceOnce(
  'src/dashboard/fragments.ts',
  '    `<span class="hint">enabled by default · 100/100 vision reader</span>` +\n',
  '    `<span class="hint">validated for coding-safe · AGY high/medium/low aliases share this profile</span>` +\n',
);
replaceOnce(
  'src/dashboard/fragments.ts',
  '    `<span class="hint">CSV of bases, or off · applies on enter/blur · export to persist</span>` +\n',
  '    `<span class="hint">requested CSV scope · applies on enter/blur · persisted to config; safety profile may block experimental families</span>` +\n',
);

replaceOnce(
  'src/node.ts',
  '  PXPIPE_MODELS           comma-separated model bases to image (Claude/Gemini/GPT/Grok);\n                          default claude-fable-5 only; other families are explicit opt-in\n',
  '  PXPIPE_MODELS           comma-separated model bases to image (Claude/Gemini/GPT/Grok);\n                          default claude-fable-5 + gemini-3.6-flash; other families are explicit opt-in\n',
);

// ---------------------------------------------------------------------------
// 2. Wire the Antigravity/AGY nested envelope into the generic proxy without
//    flattening or reserializing passthrough requests.
// ---------------------------------------------------------------------------
replaceOnce(
  'src/core/proxy.ts',
  "import { parseGoogleModelFromPath, transformGoogleGenerateContent } from './google.js';\n",
  "import { parseGoogleModelFromPath, transformGoogleGenerateContent } from './google.js';\nimport {\n  inspectAntigravityEnvelope,\n  isAntigravityInferencePath,\n  transformAntigravityGenerateContent,\n} from './antigravity.js';\n",
);
replaceOnce(
  'src/core/proxy.ts',
  '  featherlessTransformMode?: FeatherlessTransformMode;\n',
  "  featherlessTransformMode?: FeatherlessTransformMode;\n  /** Provider-specific Google wire envelope. Antigravity keeps model/project\n   * metadata outside the nested GenerateContent request. */\n  googleEnvelope?: 'antigravity';\n",
);

// Nested Antigravity response envelopes carry Google usage/candidates under response.
replaceOnce(
  'src/core/proxy.ts',
  "  // Google AI Studio streaming chunks: usageMetadata object.\n  if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {\n    const gUsage = normalizeUsage(obj.usageMetadata);\n    if (gUsage) state.usage = gUsage;\n  }\n  measureGoogleCandidates(obj, m, state);\n",
  "  // Google AI Studio streams usage at top level. Antigravity wraps the same\n  // payload under `response`; accept both without rewriting the provider response.\n  const nestedGoogleResponse = objectRecord(obj.response);\n  const googleUsageRaw = obj.usageMetadata ?? nestedGoogleResponse?.usageMetadata;\n  if (googleUsageRaw && typeof googleUsageRaw === 'object') {\n    const gUsage = normalizeUsage(googleUsageRaw);\n    if (gUsage) state.usage = gUsage;\n  }\n  measureGoogleCandidates(obj, m, state);\n  if (nestedGoogleResponse) measureGoogleCandidates(nestedGoogleResponse, m, state);\n",
);
replaceOnce(
  'src/core/proxy.ts',
  "          for (const object of objects) {\n            const nextUsage = normalizeUsage(object.usage ?? object.usageMetadata);\n            if (nextUsage) usage = nextUsage;\n            recognizedGoogle = measureGoogleCandidates(object, measurement, state) || recognizedGoogle;\n          }\n",
  "          for (const object of objects) {\n            const nestedGoogleResponse = objectRecord(object.response);\n            const nextUsage = normalizeUsage(\n              object.usage ?? object.usageMetadata ?? nestedGoogleResponse?.usageMetadata,\n            );\n            if (nextUsage) usage = nextUsage;\n            recognizedGoogle = measureGoogleCandidates(object, measurement, state) || recognizedGoogle;\n            if (nestedGoogleResponse) {\n              recognizedGoogle = measureGoogleCandidates(nestedGoogleResponse, measurement, state) || recognizedGoogle;\n            }\n          }\n",
);

replaceOnce(
  'src/core/proxy.ts',
  "    const googleModel = req.method === 'POST'\n      ? parseGoogleModelFromPath(url.pathname)\n      : null;\n    const isGoogleRoute = googleModel !== null;\n    const isGoogle = isGoogleRoute && !bypass;\n",
  "    const googleModel = req.method === 'POST'\n      ? parseGoogleModelFromPath(url.pathname)\n      : null;\n    const isAntigravityRoute = req.method === 'POST'\n      && config.googleEnvelope === 'antigravity'\n      && isAntigravityInferencePath(url.pathname);\n    const isGoogleRoute = googleModel !== null || isAntigravityRoute;\n    const isGoogle = isGoogleRoute && !bypass;\n",
);
replaceOnce(
  'src/core/proxy.ts',
  "        // Fail-closed: unreadable model → no compression, not a risky guess.\n        const model = googleModel ?? readModelField(bodyIn);\n",
  "        // Fail-closed: unreadable model → no compression, not a risky guess.\n        // Antigravity owns model metadata in the outer envelope; its nested\n        // GenerateContent request intentionally has no public-API model field.\n        const antigravityMeta = isAntigravityRoute ? inspectAntigravityEnvelope(bodyIn) : null;\n        const model = googleModel ?? antigravityMeta?.model ?? readModelField(bodyIn);\n",
);
replaceOnce(
  'src/core/proxy.ts',
  "        let r = isGoogle\n          ? await transformGoogleGenerateContent(bodyIn, model!, effectiveOpts)\n",
  "        let r = isAntigravityRoute && isGoogle\n          ? await transformAntigravityGenerateContent(bodyIn, effectiveOpts)\n          : isGoogle\n            ? await transformGoogleGenerateContent(bodyIn, model!, effectiveOpts)\n",
);
replaceOnce(
  'src/core/proxy.ts',
  '        if (isGoogle && r.info.compressed) {\n',
  '        if (isGoogle && !isAntigravityRoute && r.info.compressed) {\n',
);

// ---------------------------------------------------------------------------
// 3. Ground only Antigravity inference endpoints into the persistent CONNECT
//    listener. Control-plane endpoints on the same hosts continue to origin.
// ---------------------------------------------------------------------------
replaceOnce(
  'src/warp/persistent.ts',
  '    `generativelanguage.googleapis.com/v1/models/*:streamGenerateContent=${local}/providers/google`,\n',
  '    `generativelanguage.googleapis.com/v1/models/*:streamGenerateContent=${local}/providers/google`,\n' +
  '    `cloudcode-pa.googleapis.com/v1internal:generateContent=${local}/providers/antigravity-cloudcode`,\n' +
  '    `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent=${local}/providers/antigravity-cloudcode`,\n' +
  '    `daily-cloudcode-pa.googleapis.com/v1internal:generateContent=${local}/providers/antigravity-daily`,\n' +
  '    `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent=${local}/providers/antigravity-daily`,\n' +
  '    `daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent=${local}/providers/antigravity-sandbox`,\n' +
  '    `daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent=${local}/providers/antigravity-sandbox`,\n',
);

// Isolate explicit provider routes from gateway-only credentials and register
// three grounded Antigravity origins with their native outer-envelope mode.
replaceRegex(
  'src/node.ts',
  /providers: \[\n([\s\S]*?)\n    \],\n  \}\);\n  const handle = providerRouter;/,
  (match, body) => {
    let isolated = body.replace(/(provider: (?:undefined|'featherless'),\n)/g, '$1          gatewayBaseUrl: undefined,\n          gatewayHeaders: {},\n');
    const addition = `\n      {\n        id: 'antigravity-cloudcode',\n        protocol: 'google',\n        proxy: {\n          ...config,\n          provider: undefined,\n          googleEnvelope: 'antigravity',\n          gatewayBaseUrl: undefined,\n          gatewayHeaders: {},\n          upstream: 'https://cloudcode-pa.googleapis.com',\n          apiKey: undefined,\n          authToken: undefined,\n          openAIApiKey: undefined,\n          openAIModels: [],\n          cloudflareModels: [],\n        },\n      },\n      {\n        id: 'antigravity-daily',\n        protocol: 'google',\n        proxy: {\n          ...config,\n          provider: undefined,\n          googleEnvelope: 'antigravity',\n          gatewayBaseUrl: undefined,\n          gatewayHeaders: {},\n          upstream: 'https://daily-cloudcode-pa.googleapis.com',\n          apiKey: undefined,\n          authToken: undefined,\n          openAIApiKey: undefined,\n          openAIModels: [],\n          cloudflareModels: [],\n        },\n      },\n      {\n        id: 'antigravity-sandbox',\n        protocol: 'google',\n        proxy: {\n          ...config,\n          provider: undefined,\n          googleEnvelope: 'antigravity',\n          gatewayBaseUrl: undefined,\n          gatewayHeaders: {},\n          upstream: 'https://daily-cloudcode-pa.sandbox.googleapis.com',\n          apiKey: undefined,\n          authToken: undefined,\n          openAIApiKey: undefined,\n          openAIModels: [],\n          cloudflareModels: [],\n        },\n      },`;
    return `providers: [\n${isolated}${addition}\n    ],\n  });\n  const handle = providerRouter;`;
  },
);

// ---------------------------------------------------------------------------
// 4. Make `pxpipe agy` use the persistent listener automatically when healthy.
//    Explicit legacy routes keep their temporary-proxy behavior; if PXPipe is
//    down, AGY fails open to direct native networking.
// ---------------------------------------------------------------------------
replaceOnce(
  'src/agy.ts',
  "function routeSpecsFromEnvironment(): string[] {\n  return splitRouteEnv(process.env.PXPIPE_AGY_ROUTES ?? process.env.PXPIPE_AGY_ROUTE);\n}\n",
  "function routeSpecsFromEnvironment(): string[] {\n  return splitRouteEnv(process.env.PXPIPE_AGY_ROUTES ?? process.env.PXPIPE_AGY_ROUTE);\n}\n\nexport interface AgyPersistentProxy {\n  proxyUrl: string;\n  caCertPath: string;\n}\n\nfunction envFalse(value: string | undefined): boolean {\n  return value !== undefined && /^(?:0|false|no|off|none)$/i.test(value.trim());\n}\n\n/** Resolve the already-running PXPipe listener for AGY. A health failure is a\n * direct-mode fallback, not an AGY failure: compression is an optimization. */\nexport async function resolveAgyPersistentProxy(\n  env: NodeJS.ProcessEnv = process.env,\n  fetchFn: typeof fetch = fetch,\n  caLoader: (dir: string) => { certPath: string } = (dir) => CertificateAuthority.loadOrCreate(dir),\n): Promise<AgyPersistentProxy | null> {\n  if (envFalse(env.PXPIPE_AGY_AUTO_PROXY)) return null;\n  const requestedPort = Number(env.PORT ?? DEFAULT_PORT);\n  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;\n  const proxyUrl = `http://127.0.0.1:${port}`;\n  try {\n    const response = await fetchFn(`${proxyUrl}/proxy-stats`, { signal: AbortSignal.timeout(1_000) });\n    if (!response.ok) return null;\n  } catch {\n    return null;\n  }\n  const home = env.HOME?.trim() || homedir();\n  const ca = caLoader(join(home, '.pxpipe'));\n  return { proxyUrl, caCertPath: ca.certPath };\n}\n",
);
replaceRegex(
  'src/agy.ts',
  /function runAgyProcess\(args: readonly string\[\], routeSpecs: readonly string\[\]\): void \{([\s\S]*?)\n\}\n\nfunction isNonModelInvocation/,
  (match, inner) => {
    const binaryBlock = `\n  const binary = findExecutable('agy');\n  if (!binary) {\n    console.error('[pxpipe] agy: executable not found on PATH');\n    process.exit(127);\n  }\n\n  const debug = /^(?:1|true|yes|on)$/i.test(process.env.PXPIPE_AGY_DEBUG ?? '');\n\n  if (routeSpecs.length === 0) {\n    const persistent = await resolveAgyPersistentProxy(process.env);\n    if (persistent) {\n      if (debug) console.error(`[pxpipe] agy: ${safeAgyCommandLabel(args)} via persistent ${persistent.proxyUrl}`);\n      spawnWithTransparentLifecycle(\n        binary,\n        args,\n        buildAgyEnvironment(process.env, persistent.proxyUrl, persistent.caCertPath),\n      );\n    } else {\n      if (debug) console.error('[pxpipe] agy: persistent proxy unavailable/disabled; running direct');\n      spawnWithTransparentLifecycle(binary, args, buildAgyEnvironment(process.env));\n    }\n    return;\n  }\n\n  let routes: Route[];\n  try {\n    routes = routeSpecs.map((spec) => parseRoute(spec));\n  } catch (error) {\n    console.error(`[pxpipe] agy: invalid route: ${(error as Error).message}`);\n    process.exit(2);\n  }\n\n  const ca = CertificateAuthority.loadOrCreate(join(homedir(), '.pxpipe'));\n  const handlers = createWarpHandlers({\n    routes,\n    ca,\n    onDivert: (host, path, target) => {\n      if (debug) console.error(`[pxpipe] agy route: ${host}${path} -> ${target}`);\n    },\n  });\n  const proxy = createServer(handlers.handleAbsoluteForm);\n  proxy.on('connect', handlers.handleConnect);\n  proxy.on('error', (error) => {\n    console.error(`[pxpipe] agy: proxy listener failed: ${error.message}`);\n    process.exit(1);\n  });\n  proxy.listen(0, '127.0.0.1', () => {\n    const address = proxy.address();\n    const port = typeof address === 'object' && address ? address.port : 0;\n    const proxyUrl = `http://127.0.0.1:${port}`;\n    if (debug) console.error(`[pxpipe] agy: ${safeAgyCommandLabel(args)} via ${routeSpecs.length} route(s)`);\n    spawnWithTransparentLifecycle(binary, args, buildAgyEnvironment(process.env, proxyUrl, ca.certPath));\n  });`;
    return `async function runAgyProcess(args: readonly string[], routeSpecs: readonly string[]): Promise<void> {${binaryBlock}\n}\n\nfunction isNonModelInvocation`;
  },
);
replaceOnce('src/agy.ts', '      runAgyProcess(parsed.args, parsed.routes);\n', '      await runAgyProcess(parsed.args, parsed.routes);\n');
replaceOnce('src/agy.ts', '    runAgyProcess(args, routeSpecsFromEnvironment());\n', '    await runAgyProcess(args, routeSpecsFromEnvironment());\n');
replaceOnce(
  'src/agy.ts',
  'AGY is kept on its native provider endpoint by default. No provider route is\ninjected unless PXPIPE_AGY_ROUTE or PXPIPE_AGY_ROUTES is configured, or a\n--route is supplied to pxpipe warp. This preserves authentication, projects,\nagents, plugins, model selection and Remote Control behavior.\n\nEnvironment:\n',
  'By default pxpipe agy keeps AGY on its native provider URLs but injects the\nrunning persistent PXPipe listener as HTTP(S)_PROXY. Unrelated/control-plane\ntraffic tunnels unchanged; only grounded inference paths are diverted. If the\nlistener is unavailable AGY runs direct. Explicit PXPIPE_AGY_ROUTE(S) or warp\n--route retains the legacy per-process override proxy.\n\nEnvironment:\n  PXPIPE_AGY_AUTO_PROXY   set to off/0/false to force direct AGY networking\n',
);

// Doctor reports and uses the same auto-proxy path as a normal AGY invocation.
replaceOnce(
  'src/agy-entry.ts',
  '  parseAgyWarpInvocation,\n  runAgyEntry,\n',
  '  parseAgyWarpInvocation,\n  resolveAgyPersistentProxy,\n  runAgyEntry,\n',
);
replaceOnce(
  'src/agy-entry.ts',
  "import { discoverAgyModels } from './agy-models.js';\n",
  "import { discoverAgyModels } from './agy-models.js';\nimport { isGeminiModel } from './core/gemini-model-profiles.js';\n",
);
replaceOnce(
  'src/agy-entry.ts',
  '  route: {\n    configured: boolean;\n    count: number;\n    compressionReady: boolean;\n  };\n',
  "  route: {\n    configured: boolean;\n    count: number;\n    compressionReady: boolean;\n    mode: 'persistent' | 'explicit' | 'direct';\n    proxyUrl?: string;\n  };\n",
);
replaceOnce(
  'src/agy-entry.ts',
  '  const server = await serverReachable();\n  const routes = routeSpecs();\n  const cooldown = readAgyCooldown(options.model);\n',
  "  const server = await serverReachable();\n  const routes = routeSpecs();\n  const persistentProxy = routes.length === 0 ? await resolveAgyPersistentProxy(process.env) : null;\n  const routeMode = routes.length > 0 ? 'explicit' as const\n    : persistentProxy ? 'persistent' as const : 'direct' as const;\n  const cooldown = readAgyCooldown(options.model);\n",
);
replaceOnce(
  'src/agy-entry.ts',
  '    route: {\n      configured: routes.length > 0,\n      count: routes.length,\n      compressionReady: routes.length > 0 && server.reachable,\n    },\n',
  "    route: {\n      configured: routes.length > 0 || persistentProxy !== null,\n      count: routes.length > 0 ? routes.length : persistentProxy ? 1 : 0,\n      compressionReady: routes.length > 0\n        ? server.reachable\n        : Boolean(persistentProxy && options.model && isGeminiModel(options.model)),\n      mode: routeMode,\n      ...(persistentProxy ? { proxyUrl: persistentProxy.proxyUrl } : {}),\n    },\n",
);
replaceOnce(
  'src/agy-entry.ts',
  "      env: buildAgyEnvironment(process.env),\n      stdio: ['ignore', 'pipe', 'pipe'],\n",
  "      env: persistentProxy\n        ? buildAgyEnvironment(process.env, persistentProxy.proxyUrl, persistentProxy.caCertPath)\n        : buildAgyEnvironment(process.env),\n      stdio: ['ignore', 'pipe', 'pipe'],\n",
);
replaceOnce(
  'src/agy-entry.ts',
  "  console.log(`PXPipe AGY route: ${report.route.configured ? `${report.route.count} configured` : 'not configured (AGY runs direct)'}`);\n",
  "  console.log(`PXPipe AGY route: ${report.route.mode}${report.route.proxyUrl ? ` via ${report.route.proxyUrl}` : ''}`);\n",
);

// Public core exports for integration tests/embedders.
appendIfMissing(
  'src/core/index.ts',
  "from './antigravity.js'",
  "\nexport {\n  inspectAntigravityEnvelope,\n  isAntigravityInferencePath,\n  transformAntigravityGenerateContent,\n  type AntigravityEnvelopeMetadata,\n} from './antigravity.js';\n",
);

// ---------------------------------------------------------------------------
// 5. Reconcile tests with the new safety boundary and add end-to-end regressions.
// ---------------------------------------------------------------------------
replaceOnce(
  'tests/safety-scope.test.ts',
  "    expect(getAllowedModelBases()).toEqual(['claude-fable-5']);\n    expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);\n    expect(isPxpipeSupportedModel('gemini-3.6-flash')).toBe(false);\n",
  "    expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);\n    expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);\n    expect(isPxpipeSupportedModel('gemini-3.6-flash')).toBe(true);\n",
);
replaceOnce(
  'tests/safety-scope.test.ts',
  "    expect(getAllowedModelBases()).toEqual(['claude-fable-5']);\n  });\n\n  it('aggressive allows explicit experimental model opt-ins'",
  "    expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);\n  });\n\n  it('aggressive allows explicit experimental model opt-ins'",
);

replaceOnce(
  'tests/persistent-warp.test.ts',
  "    [\n      'generativelanguage.googleapis.com:443',\n      '/v1/models/gemini-3.6-flash-high:streamGenerateContent',\n      '/providers/google/v1/models/gemini-3.6-flash-high:streamGenerateContent',\n    ],\n",
  "    [\n      'generativelanguage.googleapis.com:443',\n      '/v1/models/gemini-3.6-flash-high:streamGenerateContent',\n      '/providers/google/v1/models/gemini-3.6-flash-high:streamGenerateContent',\n    ],\n    [\n      'cloudcode-pa.googleapis.com:443',\n      '/v1internal:generateContent',\n      '/providers/antigravity-cloudcode/v1internal:generateContent',\n    ],\n    [\n      'daily-cloudcode-pa.googleapis.com:443',\n      '/v1internal:streamGenerateContent',\n      '/providers/antigravity-daily/v1internal:streamGenerateContent',\n    ],\n    [\n      'daily-cloudcode-pa.sandbox.googleapis.com:443',\n      '/v1internal:generateContent',\n      '/providers/antigravity-sandbox/v1internal:generateContent',\n    ],\n",
);
appendIfMissing(
  'tests/persistent-warp.test.ts',
  "does not divert Antigravity control-plane endpoints",
  "\n// Control-plane calls on an intercepted host must still re-origin unchanged.\ndescribe('Antigravity persistent route safety', () => {\n  const routes = buildPersistentWarpRoutes(47821);\n  it('does not divert Antigravity control-plane endpoints', () => {\n    expect(matchRoute(routes, 'cloudcode-pa.googleapis.com:443', '/v1internal:fetchAvailableModels')).toBeNull();\n    expect(matchRoute(routes, 'cloudcode-pa.googleapis.com:443', '/v1internal:loadCodeAssist')).toBeNull();\n  });\n});\n",
);

write('tests/dashboard-model-scope-safe.test.ts', `import { afterEach, describe, expect, it } from 'vitest';\nimport { DashboardState } from '../src/dashboard.js';\nimport {\n  getAllowedModelBases,\n  getRequestedModelBases,\n  setAllowedModelBases,\n  setCompressionSafetyScope,\n} from '../src/core/applicability.js';\n\nconst originalModels = process.env.PXPIPE_MODELS;\n\nafterEach(() => {\n  setAllowedModelBases(null);\n  setCompressionSafetyScope(null);\n  if (originalModels === undefined) delete process.env.PXPIPE_MODELS;\n  else process.env.PXPIPE_MODELS = originalModels;\n});\n\ndescribe('dashboard model scope under coding-safe', () => {\n  it('activates validated Gemini and preserves configured-but-blocked experimental models', async () => {\n    delete process.env.PXPIPE_MODELS;\n    setCompressionSafetyScope('coding-safe');\n    setAllowedModelBases(null);\n    const saved = [];\n    const dash = new DashboardState(undefined, async () => new Map(), (bases) => saved.push([...bases]));\n\n    expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);\n    dash.handleModelsToggle('gpt-5.6-sol', true);\n    expect(getRequestedModelBases()).toContain('gpt-5.6-sol');\n    expect(getAllowedModelBases()).not.toContain('gpt-5.6-sol');\n\n    const html = await (await dash.serveFragment('models', new URL('http://localhost/fragments/models'), 47821)).text();\n    expect(html).toContain('Gemini 3.6 Flash ✓');\n    expect(html).toContain('GPT 5.6 Sol · configured');\n    expect(html).toContain('claude-fable-5,gemini-3.6-flash,gpt-5.6-sol');\n\n    dash.handleModelsToggle('gpt-5.6-sol', false);\n    expect(getRequestedModelBases()).toEqual(['claude-fable-5', 'gemini-3.6-flash']);\n    expect(saved.at(-1)).toEqual(['claude-fable-5', 'gemini-3.6-flash']);\n  });\n});\n`);

write('tests/antigravity-proxy.test.ts', `import { afterEach, describe, expect, it, vi } from 'vitest';\nimport { createProxy, type ProxyEvent } from '../src/core/proxy.js';\nimport { setAllowedModelBases, setCompressionSafetyScope } from '../src/core/applicability.js';\n\nconst enc = new TextEncoder();\n\nafterEach(() => {\n  setAllowedModelBases(null);\n  setCompressionSafetyScope(null);\n  vi.restoreAllMocks();\n});\n\nfunction envelope(systemText = '') {\n  return {\n    project: 'projects/example',\n    model: 'gemini-3.6-flash-high',\n    userAgent: 'antigravity',\n    requestType: 'agent',\n    requestId: 'req-1',\n    request: {\n      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),\n      contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],\n    },\n  };\n}\n\ndescribe('Antigravity provider proxy', () => {\n  it('preserves the outer provider envelope and transforms only the nested request', async () => {\n    setCompressionSafetyScope('aggressive');\n    setAllowedModelBases(['gemini-3.6-flash']);\n    let outgoing = null;\n    const events = [];\n    const proxy = createProxy({\n      googleEnvelope: 'antigravity',\n      upstream: 'https://cloudcode-pa.googleapis.com',\n      transform: { compress: true, compressTools: false, compressToolResults: false, collapseHistory: false, minCompressChars: 1 },\n      customFetch: vi.fn(async (_input, init) => {\n        outgoing = JSON.parse(String(init?.body));\n        return new Response(JSON.stringify({\n          response: {\n            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }],\n            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3, cachedContentTokenCount: 20 },\n          },\n        }), { status: 200, headers: { 'content-type': 'application/json' } });\n      }),\n      onRequest: (event) => events.push(event),\n    });\n\n    const response = await proxy(new Request('http://localhost/v1internal:generateContent', {\n      method: 'POST', headers: { 'content-type': 'application/json' },\n      body: JSON.stringify(envelope('Static context. '.repeat(2000))),\n    }));\n    expect(response.status).toBe(200);\n    await response.text();\n    await vi.waitFor(() => expect(events).toHaveLength(1));\n    expect(outgoing.project).toBe('projects/example');\n    expect(outgoing.model).toBe('gemini-3.6-flash-high');\n    expect(outgoing.requestId).toBe('req-1');\n    expect(JSON.stringify(outgoing.request)).toContain('inlineData');\n    expect(events[0].model).toBe('gemini-3.6-flash-high');\n    expect(events[0].accountingProvider).toBe('google');\n    expect(events[0].usage).toMatchObject({ input_tokens: 100, output_tokens: 10, cached_tokens: 20 });\n  });\n\n  it('parses nested Antigravity SSE usage without changing the response stream', async () => {\n    setCompressionSafetyScope('coding-safe');\n    setAllowedModelBases(['gemini-3.6-flash']);\n    const events = [];\n    const payload = 'data: ' + JSON.stringify({ response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 40 } } }) + '\\n\\n';\n    const proxy = createProxy({\n      googleEnvelope: 'antigravity', upstream: 'https://cloudcode-pa.googleapis.com',\n      transform: { compress: false },\n      customFetch: vi.fn(async () => new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })),\n      onRequest: (event) => events.push(event),\n    });\n    const response = await proxy(new Request('http://localhost/v1internal:streamGenerateContent?alt=sse', {\n      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope()),\n    }));\n    expect(await response.text()).toBe(payload);\n    await vi.waitFor(() => expect(events).toHaveLength(1));\n    expect(events[0].usage).toMatchObject({ input_tokens: 90, output_tokens: 7, cached_tokens: 40 });\n    expect(events[0].stopReason).toBe('STOP');\n  });\n});\n`);

write('tests/agy-persistent-proxy.test.ts', `import { describe, expect, it, vi } from 'vitest';\nimport { resolveAgyPersistentProxy } from '../src/agy.js';\n\ndescribe('AGY persistent PXPipe resolver', () => {\n  it('uses the running loopback listener and matching CA when healthy', async () => {\n    const fetchFn = vi.fn(async (input) => {\n      expect(String(input)).toBe('http://127.0.0.1:49001/proxy-stats');\n      return new Response('{}', { status: 200 });\n    });\n    const proxy = await resolveAgyPersistentProxy(\n      { PORT: '49001', HOME: '/tmp/agy-home' },\n      fetchFn,\n      (dir) => { expect(dir).toBe('/tmp/agy-home/.pxpipe'); return { certPath: '/tmp/pxpipe-ca.pem' }; },\n    );\n    expect(proxy).toEqual({ proxyUrl: 'http://127.0.0.1:49001', caCertPath: '/tmp/pxpipe-ca.pem' });\n  });\n\n  it('fails open to direct mode when disabled or unhealthy', async () => {\n    const fetchFn = vi.fn(async () => { throw new Error('offline'); });\n    expect(await resolveAgyPersistentProxy({ PXPIPE_AGY_AUTO_PROXY: 'off' }, fetchFn)).toBeNull();\n    expect(fetchFn).not.toHaveBeenCalled();\n    expect(await resolveAgyPersistentProxy({ PORT: '47821' }, fetchFn)).toBeNull();\n  });\n});\n`);

// Provider route config must expose the adapter publicly for Node builds.
console.log('materialized AGY/dashboard end-to-end reliability patch');
