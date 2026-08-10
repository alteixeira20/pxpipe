import { afterEach, describe, expect, it } from 'vitest';

import { createFailOpenProxy } from '../src/core/fail-open.js';
import { createProviderRouter } from '../src/core/provider-router.js';
import {
  CODEX_PROVIDER_ID,
  DEFAULT_CODEX_UPSTREAM,
  codexProviderBaseUrl,
} from '../src/core/codex.js';
import type { ProxyEvent } from '../src/core/proxy.js';

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function mockUpstream(handler: (request: Request) => Response | Promise<Response>): void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return Promise.resolve(handler(request));
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; };
}

function router(onRequest: (event: ProxyEvent) => void) {
  return createProviderRouter({
    defaultProxy: { upstream: 'https://api.anthropic.invalid' },
    handlerFactory: createFailOpenProxy,
    providers: [{
      id: CODEX_PROVIDER_ID,
      protocol: 'openai',
      proxy: {
        upstream: DEFAULT_CODEX_UPSTREAM,
        openAIUpstream: DEFAULT_CODEX_UPSTREAM,
        apiKey: undefined,
        authToken: undefined,
        openAIApiKey: undefined,
        transform: { compress: true },
        onRequest,
      },
    }],
  });
}

describe('Codex native remote-compaction parity', () => {
  it('forwards /responses/compact byte-identically with ChatGPT auth and OpenAI accounting', async () => {
    const upstream: Request[] = [];
    mockUpstream((request) => {
      upstream.push(request.clone());
      return new Response(JSON.stringify({
        id: 'compact_1',
        object: 'response.compaction',
        output: [{ type: 'compaction', encrypted_content: 'opaque' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    let event: ProxyEvent | undefined;
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'compact this native Codex history' }] },
      ],
    });
    const response = await router((next) => { event = next; })(new Request(
      `${codexProviderBaseUrl(47821)}/responses/compact`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer chatgpt-access-token',
          'chatgpt-account-id': 'acct_native',
          originator: 'codex_cli_rs',
        },
        body,
      },
    ));
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(upstream).toHaveLength(1);
    const sent = upstream[0]!;
    expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(sent.headers.get('authorization')).toBe('Bearer chatgpt-access-token');
    expect(sent.headers.get('chatgpt-account-id')).toBe('acct_native');
    expect(sent.headers.get('originator')).toBe('codex_cli_rs');
    expect(await sent.text()).toBe(body);

    // Native compaction is a Codex route but is intentionally not a PXPipe
    // compression target. The explicit route table still supplies authoritative
    // provider/accounting identity for observability.
    expect(event?.provider).toBe('codex');
    expect(event?.accountingProvider).toBe('openai');
    expect(event?.path).toBe('/responses/compact');
    expect(event?.status).toBe(200);
    expect(event?.info).toBeUndefined();
  });
});
