import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPxpipeSupportedModelForScope } from '../src/core/applicability.js';
import {
  CODEX_PASSTHROUGH_HEADER,
  CODEX_PASSTHROUGH_HEADER_VALUE,
  CODEX_PROVIDER_ID,
  DEFAULT_CODEX_UPSTREAM,
  codexProviderBaseUrl,
} from '../src/core/codex.js';
import { createFailOpenProxy } from '../src/core/fail-open.js';
import { createProviderRouter } from '../src/core/provider-router.js';
import type { ProxyEvent } from '../src/core/proxy.js';
import { toTrackEvent } from '../src/core/tracker.js';

const enc = new TextEncoder();

let originalFetch: typeof fetch;
let previousModels: string | undefined;
let previousProfile: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousModels = process.env.PXPIPE_MODELS;
  previousProfile = process.env.PXPIPE_PROFILE;
  process.env.PXPIPE_MODELS = 'gpt-5.6-sol';
  process.env.PXPIPE_PROFILE = 'coding-safe';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = previousModels;
  if (previousProfile === undefined) delete process.env.PXPIPE_PROFILE;
  else process.env.PXPIPE_PROFILE = previousProfile;
});

/** Build a standards-compliant zstd frame containing raw blocks. Codex uses
 * compressed blocks in production; raw blocks exercise the same content-
 * encoding contract without requiring a platform-specific test compressor. */
function zstdJson(value: unknown): Uint8Array {
  const input = enc.encode(JSON.stringify(value));
  const bytes: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  if (input.byteLength < 256) {
    bytes.push(0x20, input.byteLength);
  } else if (input.byteLength < 65_792) {
    const encodedSize = input.byteLength - 256;
    bytes.push(0x60, encodedSize & 0xff, (encodedSize >>> 8) & 0xff);
  } else {
    bytes.push(
      0xa0,
      input.byteLength & 0xff,
      (input.byteLength >>> 8) & 0xff,
      (input.byteLength >>> 16) & 0xff,
      (input.byteLength >>> 24) & 0xff,
    );
  }

  for (let offset = 0; offset < input.byteLength;) {
    const size = Math.min(131_071, input.byteLength - offset);
    const last = offset + size === input.byteLength;
    const header = (size << 3) | (last ? 1 : 0);
    bytes.push(header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff);
    for (const byte of input.subarray(offset, offset + size)) bytes.push(byte);
    offset += size;
  }
  return Uint8Array.from(bytes);
}

function response(): Response {
  return Response.json({
    id: 'resp_runtime_model',
    object: 'response',
    output: [],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 5,
      total_tokens: 105,
    },
  });
}

function makeRouter(events: ProxyEvent[]) {
  return createProviderRouter({
    defaultProxy: { upstream: 'https://api.anthropic.invalid' },
    handlerFactory: createFailOpenProxy,
    providers: [
      {
        id: CODEX_PROVIDER_ID,
        protocol: 'openai',
        proxy: {
          upstream: DEFAULT_CODEX_UPSTREAM,
          decodeZstdRequests: true,
          transform: { charsPerToken: 1, minCompressChars: 1 },
          onRequest: (event) => { events.push(event); },
        },
      },
      {
        id: 'openai',
        protocol: 'openai',
        proxy: {
          openAIUpstream: 'https://api.openai.invalid',
          transform: { charsPerToken: 1, minCompressChars: 1 },
          onRequest: (event) => { events.push(event); },
        },
      },
    ],
  });
}

function request(
  route: 'codex' | 'openai',
  body: Uint8Array,
  path = '/responses',
  headers: Record<string, string> = {},
): Request {
  const base = route === 'codex'
    ? codexProviderBaseUrl(47_821)
    : 'http://127.0.0.1:47821/providers/openai';
  return new Request(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'zstd',
      authorization: 'Bearer fixture-token',
      ...headers,
    },
    body,
  });
}

function turn(model: string | undefined, long = false): Record<string, unknown> {
  return {
    ...(model ? { model } : {}),
    instructions: long ? 'Preserve exact coding constraints. '.repeat(700) : 'Be precise.',
    input: [{ role: 'user', content: 'Report the package name.' }],
    stream: false,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ChatGPT-authenticated Codex runtime model identity', () => {
  it('decodes the native request model for admission and persisted telemetry', async () => {
    const upstream: Request[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const next = input instanceof Request ? input : new Request(String(input), init);
      upstream.push(next.clone());
      return response();
    }) as typeof fetch;
    const events: ProxyEvent[] = [];

    const res = await makeRouter(events)(request('codex', zstdJson(turn('gpt-5.6-sol', true))));
    await res.text();
    await settle();

    expect(isPxpipeSupportedModelForScope('gpt-5.6-sol', 'coding-safe')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.model).toBe('gpt-5.6-sol');
    expect(events[0]?.provider).toBe('codex');
    expect(events[0]?.accountingProvider).toBe('openai');
    expect(events[0]?.info?.reason).not.toBe('unsupported_model');
    expect(toTrackEvent(events[0]!).model).toBe('gpt-5.6-sol');
    expect(upstream[0]?.headers.get('content-encoding')).toBeNull();
    expect(JSON.parse(await upstream[0]!.text())).toMatchObject({ model: 'gpt-5.6-sol' });
  });

  it('persists an unsupported model exactly and abstains from compression', async () => {
    globalThis.fetch = (async () => response()) as typeof fetch;
    const events: ProxyEvent[] = [];

    await (await makeRouter(events)(request(
      'codex',
      zstdJson(turn('gpt-5.6-terra', true)),
    ))).text();
    await settle();

    expect(events[0]?.model).toBe('gpt-5.6-terra');
    expect(events[0]?.info?.compressed).toBe(false);
    expect(events[0]?.info?.reason).toBe('unsupported_model');
    expect(toTrackEvent(events[0]!).model).toBe('gpt-5.6-terra');
  });

  it('retains model identity in the controlled passthrough cohort', async () => {
    globalThis.fetch = (async () => response()) as typeof fetch;
    const events: ProxyEvent[] = [];

    await (await makeRouter(events)(request(
      'codex',
      zstdJson(turn('gpt-5.6-sol', true)),
      '/responses',
      { [CODEX_PASSTHROUGH_HEADER]: CODEX_PASSTHROUGH_HEADER_VALUE },
    ))).text();
    await settle();

    expect(events[0]?.model).toBe('gpt-5.6-sol');
    expect(events[0]?.provider).toBe('codex-passthrough');
    expect(events[0]?.accountingProvider).toBe('openai');
    expect(events[0]?.info?.compressed).toBe(false);
  });

  it('does not change generic OpenAI Responses content-encoding behavior', async () => {
    const upstream: Request[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const next = input instanceof Request ? input : new Request(String(input), init);
      upstream.push(next.clone());
      return response();
    }) as typeof fetch;
    const events: ProxyEvent[] = [];
    const wire = zstdJson(turn('gpt-5.6-sol'));

    await (await makeRouter(events)(request('openai', wire))).text();
    await settle();

    expect(upstream[0]?.headers.get('content-encoding')).toBe('zstd');
    expect(new Uint8Array(await upstream[0]!.arrayBuffer())).toEqual(wire);
    expect(events[0]?.provider).toBe('openai');
    expect(events[0]?.model).toBeUndefined();
  });

  it('keeps /responses/compact native and byte-identical', async () => {
    const upstream: Request[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const next = input instanceof Request ? input : new Request(String(input), init);
      upstream.push(next.clone());
      return response();
    }) as typeof fetch;
    const events: ProxyEvent[] = [];
    const wire = zstdJson(turn('gpt-5.6-sol'));

    await (await makeRouter(events)(request('codex', wire, '/responses/compact'))).text();
    await settle();

    expect(upstream[0]?.url).toBe(`${DEFAULT_CODEX_UPSTREAM}/responses/compact`);
    expect(upstream[0]?.headers.get('content-encoding')).toBe('zstd');
    expect(new Uint8Array(await upstream[0]!.arrayBuffer())).toEqual(wire);
    expect(events[0]?.provider).toBe('codex');
    expect(events[0]?.info).toBeUndefined();
  });

  it('isolates concurrent Codex request models without shared launch state', async () => {
    globalThis.fetch = (async () => response()) as typeof fetch;
    const events: ProxyEvent[] = [];
    const router = makeRouter(events);

    const responses = await Promise.all([
      router(request('codex', zstdJson(turn('gpt-5.6-sol')))),
      router(request('codex', zstdJson(turn('gpt-5.6-terra')))),
    ]);
    await Promise.all(responses.map((item) => item.text()));
    await settle();

    expect(events.map((event) => event.model).sort()).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]);
  });

  it('does not manufacture a model when the decoded request omits it', async () => {
    globalThis.fetch = (async () => response()) as typeof fetch;
    const events: ProxyEvent[] = [];

    await (await makeRouter(events)(request('codex', zstdJson(turn(undefined))))).text();
    await settle();

    expect(events[0]?.model).toBeUndefined();
    expect(events[0]?.info?.compressed).toBe(false);
    expect(events[0]?.info?.reason).toBe('unsupported_model');
    expect(toTrackEvent(events[0]!)).not.toHaveProperty('model');
  });
});
