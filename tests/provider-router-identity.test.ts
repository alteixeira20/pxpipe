import { describe, expect, it } from 'vitest';

import { createFailOpenProxy } from '../src/core/fail-open.js';
import { createProviderRouter } from '../src/core/provider-router.js';
import type { ProxyEvent } from '../src/core/proxy.js';

function responseBody(): Response {
  return new Response(JSON.stringify({
    id: 'resp_1',
    object: 'response',
    output: [],
    usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function router(observed: ProxyEvent[]) {
  return createProviderRouter({
    defaultProxy: { upstream: 'https://anthropic.test' },
    handlerFactory: createFailOpenProxy,
    providers: [{
      id: 'codex',
      protocol: 'openai',
      proxy: {
        openAIUpstream: 'https://chatgpt.test/backend-api/codex',
        customFetch: (async () => responseBody()) as typeof fetch,
        transform: { compress: false },
        onRequest: (event) => { observed.push(event); },
      },
    }],
  });
}

async function send(r: ReturnType<typeof router>, headers: Record<string, string> = {}): Promise<void> {
  const response = await r(new Request('http://127.0.0.1/providers/codex/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'test', stream: false }),
  }));
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('explicit provider telemetry identity', () => {
  it('records the Codex route as provider=codex instead of generic openai', async () => {
    const observed: ProxyEvent[] = [];
    await send(router(observed));
    expect(observed).toHaveLength(1);
    expect(observed[0]!.provider).toBe('codex');
    expect(observed[0]!.accountingProvider).toBe('openai');
  });

  it('preserves the more-specific codex-passthrough A/B identity', async () => {
    const observed: ProxyEvent[] = [];
    await send(router(observed), { 'x-pxpipe-compression': 'codex-passthrough' });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.provider).toBe('codex-passthrough');
    expect(observed[0]!.accountingProvider).toBe('openai');
  });
});
