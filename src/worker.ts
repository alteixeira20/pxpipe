/**
 * Cloudflare Workers entrypoint. Identical proxy logic to the Node build,
 * just wired up through the Worker `fetch` export.
 *
 * Deploy:
 *   npx wrangler deploy
 *
 * Dev:
 *   npx wrangler dev
 *
 * Config lives in wrangler.toml.
 */

import { type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';
import { createFailOpenProxy } from './core/fail-open.js';
import { resolveCompressionProfile } from './core/safety-policy.js';
import { toTrackEvent, JsonLogTracker, noopTracker, type Tracker } from './core/tracker.js';
import { setAllowedModelBases, setCompressionSafetyScope } from './core/applicability.js';

export interface Env {
  /** Optional single upstream base for every API family. Family-specific env vars override it. */
  PXPIPE_UPSTREAM?: string;
  ANTHROPIC_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever x-api-key the client sent. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever Authorization the client sent. */
  OPENAI_API_KEY?: string;
  OPENAI_MODELS?: string;
  CLOUDFLARE_MODELS?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** Semantic compression policy. Defaults to coding-safe. */
  PXPIPE_PROFILE?: string;
  COMPRESS?: string;
  /** Legacy aggressive-mode tuning knobs. Ignored by coding-safe/balanced so a
   * deployment cannot accidentally weaken the semantic safety boundary. */
  COMPRESS_TOOLS?: string;
  COMPRESS_TOOL_RESULTS?: string;
  MIN_COMPRESS_CHARS?: string;
  MIN_TOOL_RESULT_CHARS?: string;
  COLS?: string;
  /** Comma-separated model bases eligible for compression. */
  PXPIPE_MODELS?: string;
  /** When "0" / "false", disable per-request event JSON logs. Default-on.
   *  Cloudflare ingests console.log as Workers Logs; pipe via Logpush to
   *  R2/S3 for the same JSONL shape Node writes to disk. */
  PXPIPE_TRACK?: string;
  /** Shared secret callers must present via the `x-pxpipe-secret` header
   *  whenever an API-key override is configured. Without this gate a
   *  discovered workers.dev URL is an open key-spender: the Worker would
   *  attach your key to any stranger's request. Set with:
   *    npx wrangler secret put PXPIPE_WORKER_SECRET */
  PXPIPE_WORKER_SECRET?: string;
  /** Optional inbound body ceiling in bytes. Invalid values fail closed to the
   *  core default rather than disabling the bound. */
  PXPIPE_MAX_REQUEST_BYTES?: string;
}

/** Compare SHA-256 digests instead of the raw strings so the comparison
 *  can't leak a prefix-match timing signal. */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

const truthy = (v: string | undefined, fallback: boolean): boolean =>
  v == null ? fallback : v === '1' || v.toLowerCase() === 'true';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const profile = resolveCompressionProfile(env.PXPIPE_PROFILE);
    // Workers do not have process.env, so explicitly install the host safety scope
    // before model applicability is checked. Safe/balanced can never be weakened
    // by a stale PXPIPE_MODELS setting; aggressive remains an explicit opt-in.
    setCompressionSafetyScope(profile.name);
    const configuredModels = env.PXPIPE_MODELS?.trim();
    setAllowedModelBases(
      configuredModels === undefined || configuredModels === ''
        ? null
        : /^(0|false|no|off|none)$/i.test(configuredModels)
          ? []
          : configuredModels.split(',').map((model) => model.trim()).filter(Boolean),
    );
    // ── Caller auth ────────────────────────────────────────────────────
    // If this deployment injects API keys, never serve anonymous callers:
    // workers.dev URLs are discoverable, and without this gate anyone who
    // finds the URL spends this deployment's API credits.
    if (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.CLOUDFLARE_API_TOKEN) {
      if (!env.PXPIPE_WORKER_SECRET) {
        return new Response(
          JSON.stringify({
            error:
              'refusing to proxy: an API key override is configured but PXPIPE_WORKER_SECRET is not, ' +
              'which would let anyone who finds this URL spend the configured key. ' +
              'Run `npx wrangler secret put PXPIPE_WORKER_SECRET` and send the value as the x-pxpipe-secret header.',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      const presented = req.headers.get('x-pxpipe-secret') ?? '';
      if (!(await secretsMatch(presented, env.PXPIPE_WORKER_SECRET))) {
        return new Response(
          JSON.stringify({ error: 'missing or invalid x-pxpipe-secret header' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      // Don't forward the shared secret upstream.
      req = new Request(req);
      req.headers.delete('x-pxpipe-secret');
    }

    const transform: TransformOptions = {
      ...profile.transform,
      // Global COMPRESS remains a one-way emergency kill switch. It cannot turn
      // compression back on when the selected profile is passthrough.
      compress: (profile.transform.compress ?? true) && truthy(env.COMPRESS, true),
      // Geometry is not a semantic-risk switch and remains safe to override.
      ...(env.COLS ? { cols: Number(env.COLS) } : {}),
      // Legacy fine-grained imaging controls are accepted only under the explicit
      // aggressive profile. Safe profiles cannot be weakened accidentally by old
      // wrangler variables left behind from a previous deployment.
      ...(profile.name === 'aggressive'
        ? {
            compressTools: truthy(env.COMPRESS_TOOLS, profile.transform.compressTools ?? true),
            compressToolResults: truthy(
              env.COMPRESS_TOOL_RESULTS,
              profile.transform.compressToolResults ?? true,
            ),
            minCompressChars: env.MIN_COMPRESS_CHARS
              ? Number(env.MIN_COMPRESS_CHARS)
              : profile.transform.minCompressChars,
            minToolResultChars: env.MIN_TOOL_RESULT_CHARS
              ? Number(env.MIN_TOOL_RESULT_CHARS)
              : profile.transform.minToolResultChars,
          }
        : {}),
    };
    const trackingOn = truthy(env.PXPIPE_TRACK, true);
    // Workers Logs ingests stdout as separate log lines. Emit one JSON line
    // per event so downstream (Logpush → R2/S3) reads the same JSONL shape
    // the Node host writes to disk.
    const tracker: Tracker = trackingOn ? new JsonLogTracker((s) => console.log(s)) : noopTracker;

    const sharedUpstream = env.PXPIPE_UPSTREAM;
    const parseModels = (value: string | undefined): string[] | undefined =>
      value === undefined ? undefined : value.split(',').map((model) => model.trim()).filter(Boolean);
    const cfAccount = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const cfToken = env.CLOUDFLARE_API_TOKEN?.trim();
    const cloudflareUpstream = cfAccount && cfToken
      ? `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/v1`
      : undefined;
    const config: ProxyConfig = {
      upstream: env.ANTHROPIC_UPSTREAM ?? sharedUpstream ?? 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      openAIUpstream: env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com',
      openAIApiKey: env.OPENAI_API_KEY,
      cloudflareUpstream,
      cloudflareApiKey: cfToken,
      openAIModels: parseModels(env.OPENAI_MODELS),
      cloudflareModels: parseModels(env.CLOUDFLARE_MODELS),
      maxRequestBytes: env.PXPIPE_MAX_REQUEST_BYTES === undefined
        ? undefined
        : Number(env.PXPIPE_MAX_REQUEST_BYTES),
      transform,
      onRequest: (e) => {
        // Terse human-readable line (separate from the JSON event below;
        // shows up in `wrangler tail`).
        const tag = e.info?.compressed
          ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B`
          : e.info?.reason
            ? e.info.reason === 'unsupported_model' && e.model
              ? `skip(unsupported=${e.model})`
              : `skip(${e.info.reason})`
            : '';
        const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
        console.log(
          `${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ` +
          `profile=${profile.name} ${tag} cache_read=${cacheRead}`,
        );

        if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
          console.warn(
            `[pxpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}`,
          );
        }

        tracker.emit(toTrackEvent(e));
      },
    };
    // Pass the already-resolved Worker policy explicitly. Vitest and some
    // bundlers provide a process shim; relying on process.env here would
    // silently downgrade an aggressive Worker request to Node's safe default.
    const handle = createFailOpenProxy(config, { safetyScope: profile.name });
    return handle(req);
  },
};
