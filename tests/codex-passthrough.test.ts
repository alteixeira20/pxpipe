import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCodexConfigArgs,
  CODEX_MODEL_PROVIDER_ID,
  CODEX_PASSTHROUGH_HEADER,
  parseCodexInvocation,
} from '../src/core/codex.js';
import { createFailOpenProxy } from '../src/core/fail-open.js';
import type { ProxyEvent } from '../src/core/proxy.js';

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function mockFetch(handler: (request: Request) => Response | Promise<Response>): void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return Promise.resolve(handler(request));
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; };
}

describe('Codex routed passthrough launch', () => {
  it('parses --passthrough as a PXPipe wrapper flag without leaking it to Codex', () => {
    expect(parseCodexInvocation(['codex', '--passthrough', 'exec', 'check'])).toEqual({
      binary: 'codex',
      direct: false,
      passthrough: true,
      args: ['exec', 'check'],
    });
  });

  it('rejects contradictory direct and routed-passthrough modes', () => {
    expect(() => parseCodexInvocation(['codex', '--direct', '--passthrough']))
      .toThrow(/mutually exclusive/);
  });

  it('adds the internal control only to the child-scoped custom provider', () => {
    const args = buildCodexConfigArgs('http://127.0.0.1:47821/providers/codex', {
      passthrough: true,
    });
    const values = args.filter((_value, index) => index % 2 === 1);
    expect(values).toContain(
      `model_providers.${CODEX_MODEL_PROVIDER_ID}.http_headers={ ${CODEX_PASSTHROUGH_HEADER} = "off" }`,
    );
    expect(values).toContain(`model_provider=${CODEX_MODEL_PROVIDER_ID}`);
  });
});

describe('PXPipe per-process compression control', () => {
  it('keeps the same OpenAI route and authoritative usage while forwarding the body byte-identical', async () => {
    const upstream: Request[] = [];
    mockFetch((request) => {
      upstream.push(request.clone());
      return new Response(JSON.stringify({
        id: 'resp_1',
        object: 'response',
        output: [],
        usage: {
          input_tokens: 1234,
          input_tokens_details: { cached_tokens: 1000 },
          output_tokens: 12,
          total_tokens: 1246,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    let event: ProxyEvent | undefined;
    const proxy = createFailOpenProxy({
      openAIUpstream: 'https://chatgpt.test/backend-api/codex',
      transform: { minCompressChars: 1 },
      onRequest: (e) => { event = e; },
    });
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'baseline request' }],
      stream: false,
    });
    const response = await proxy(new Request('http://127.0.0.1:47821/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CODEX_PASSTHROUGH_HEADER]: 'off',
      },
      body,
    }));
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get(CODEX_PASSTHROUGH_HEADER)).toBeNull();
    expect(await upstream[0]!.text()).toBe(body);
    expect(event?.accountingProvider).toBe('openai');
    expect(event?.model).toBe('gpt-5.6-sol');
    expect(event?.info?.compressed).toBe(false);
    expect(event?.info?.reason).toBe('compress=false');
    expect(event?.usage?.input_tokens).toBe(1234);
    expect(event?.usage?.cached_tokens).toBe(1000);
    expect(event?.usage?.output_tokens).toBe(12);
  });
});
