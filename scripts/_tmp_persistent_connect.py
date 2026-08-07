from pathlib import Path

node = Path('src/node.ts')
text = node.read_text()

old = "import { createWarpRuntime } from './warp/index.js';\n"
new = old + "import { CertificateAuthority } from './warp/ca.js';\nimport { createWarpHandlers } from './warp/connect.js';\nimport { buildPersistentWarpRoutes, parsePersistentWarpRouteEnv } from './warp/persistent.js';\n"
if old not in text:
    raise SystemExit('warp import insertion point not found')
text = text.replace(old, new, 1)

old = """  const handle = providerRouter;

  const server = createServer((req, res) => {
"""
new = """  const handle = providerRouter;

  // The same persistent listener also acts as a loopback-only forward proxy.
  // Unknown hosts are tunneled without TLS termination; only hosts with an
  // inference route are MITM'd, and unmatched paths on those hosts still go to
  // the real origin. This lets agents keep first-party provider URLs while
  // inference requests enter the explicit provider router above.
  const connectRouteSpecs = parsePersistentWarpRouteEnv(process.env.PXPIPE_CONNECT_ROUTES);
  const connectRoutes = buildPersistentWarpRoutes(opts.port, connectRouteSpecs);
  const connectCa = CertificateAuthority.loadOrCreate(path.join(os.homedir(), '.pxpipe'));
  const connectHandlers = createWarpHandlers({
    routes: connectRoutes,
    ca: connectCa,
    onDivert: (host, requestPath, target) => {
      console.log(`[pxpipe] CONNECT divert ${host}${requestPath} → ${target}`);
    },
  });

  const server = createServer((req, res) => {
"""
if old not in text:
    raise SystemExit('persistent CONNECT setup insertion point not found')
text = text.replace(old, new, 1)

old = """      .then(async () => {
        // Local dashboard routes — handled BEFORE the proxy so they never hit
"""
new = """      .then(async () => {
        // Forward proxies use absolute-form request targets for plain HTTP. TLS
        // arrives through the server's CONNECT event below.
        if (/^https?:\\/\\//i.test(req.url ?? '')) {
          connectHandlers.handleAbsoluteForm(req, res);
          return;
        }
        // Local dashboard routes — handled BEFORE the proxy so they never hit
"""
if old not in text:
    raise SystemExit('absolute-form dispatch insertion point not found')
text = text.replace(old, new, 1)

old = """  // IPv6 literals need bracket notation to form a valid URL (http://[::1]:47821).
"""
new = """  // CONNECT is a separate event from ordinary HTTP requests, so it can share
  // the exact same TCP listener and port without another PXPipe service.
  server.on('connect', connectHandlers.handleConnect);

  // IPv6 literals need bracket notation to form a valid URL (http://[::1]:47821).
"""
if old not in text:
    raise SystemExit('server CONNECT listener insertion point not found')
text = text.replace(old, new, 1)

old = """    console.log(`[pxpipe] tracking events → ${opts.eventsFile}`);
"""
new = """    console.log(`[pxpipe] tracking events → ${opts.eventsFile}`);
    console.log(`[pxpipe] CONNECT proxy → http://127.0.0.1:${opts.port} (${connectRoutes.length} inference route(s))`);
    console.log(`[pxpipe] CONNECT CA → ${connectCa.certPath}`);
"""
if old not in text:
    raise SystemExit('CONNECT announce insertion point not found')
node.write_text(text.replace(old, new, 1))

# Export persistent route construction for tests/embedders.
index = Path('src/core/index.ts')
text = index.read_text()
append = """export {
  buildPersistentWarpRoutes,
  parsePersistentWarpRouteEnv,
  persistentWarpRouteSpecs,
} from '../warp/persistent.js';
"""
if "persistentWarpRouteSpecs" not in text:
    text += append
index.write_text(text)
