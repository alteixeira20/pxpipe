from pathlib import Path

path = Path('scripts/materialize-agy-dashboard-fix.mjs')
text = path.read_text()
start = text.index('    const binaryBlock = `')
end_marker = '    return `async function runAgyProcess(args: readonly string[], routeSpecs: readonly string[]): Promise<void> {${binaryBlock}\\n}\\n\\nfunction isNonModelInvocation`;'
end = text.index(end_marker, start)

lines = [
    '',
    "  const binary = findExecutable('agy');",
    '  if (!binary) {',
    "    console.error('[pxpipe] agy: executable not found on PATH');",
    '    process.exit(127);',
    '  }',
    '',
    "  const debug = /^(?:1|true|yes|on)$/i.test(process.env.PXPIPE_AGY_DEBUG ?? '');",
    '',
    '  if (routeSpecs.length === 0) {',
    '    const persistent = await resolveAgyPersistentProxy(process.env);',
    '    if (persistent) {',
    '      if (debug) console.error(`[pxpipe] agy: ${safeAgyCommandLabel(args)} via persistent ${persistent.proxyUrl}`);',
    '      spawnWithTransparentLifecycle(',
    '        binary,',
    '        args,',
    '        buildAgyEnvironment(process.env, persistent.proxyUrl, persistent.caCertPath),',
    '      );',
    '    } else {',
    "      if (debug) console.error('[pxpipe] agy: persistent proxy unavailable/disabled; running direct');",
    '      spawnWithTransparentLifecycle(binary, args, buildAgyEnvironment(process.env));',
    '    }',
    '    return;',
    '  }',
    '',
    '  let routes: Route[];',
    '  try {',
    '    routes = routeSpecs.map((spec) => parseRoute(spec));',
    '  } catch (error) {',
    '    console.error(`[pxpipe] agy: invalid route: ${(error as Error).message}`);',
    '    process.exit(2);',
    '  }',
    '',
    "  const ca = CertificateAuthority.loadOrCreate(join(homedir(), '.pxpipe'));",
    '  const handlers = createWarpHandlers({',
    '    routes,',
    '    ca,',
    '    onDivert: (host, path, target) => {',
    '      if (debug) console.error(`[pxpipe] agy route: ${host}${path} -> ${target}`);',
    '    },',
    '  });',
    '  const proxy = createServer(handlers.handleAbsoluteForm);',
    "  proxy.on('connect', handlers.handleConnect);",
    "  proxy.on('error', (error) => {",
    '    console.error(`[pxpipe] agy: proxy listener failed: ${error.message}`);',
    '    process.exit(1);',
    '  });',
    "  proxy.listen(0, '127.0.0.1', () => {",
    '    const address = proxy.address();',
    "    const port = typeof address === 'object' && address ? address.port : 0;",
    '    const proxyUrl = `http://127.0.0.1:${port}`;',
    '    if (debug) console.error(`[pxpipe] agy: ${safeAgyCommandLabel(args)} via ${routeSpecs.length} route(s)`);',
    '    spawnWithTransparentLifecycle(binary, args, buildAgyEnvironment(process.env, proxyUrl, ca.certPath));',
    '  });',
]

replacement = '    const binaryBlock = ' + repr('\n'.join(lines)) + ';\n'
replacement = replacement.replace('\\x60', '`')
text = text[:start] + replacement + text[end:]

# The proxy forwards transformed JSON as Uint8Array. The first regression test
# accidentally stringified the typed array itself ("123,34,...") and made its
# own mock fetch throw, which correctly surfaced as a 502 transport error. Decode
# the body bytes like a real HTTP peer before JSON.parse.
old = "        outgoing = JSON.parse(String(init?.body));"
new = "        const rawBody = init?.body instanceof Uint8Array\\n          ? new TextDecoder().decode(init.body)\\n          : String(init?.body ?? '');\\n        outgoing = JSON.parse(rawBody);"
if old not in text:
    raise RuntimeError('missing Antigravity test body-decoding fixture')
text = text.replace(old, new, 1)

path.write_text(text)
