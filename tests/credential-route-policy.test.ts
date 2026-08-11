import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyInboundCredential,
  createProxy,
  resolveOpenAIRouteAuth,
  type InboundCredential,
} from '../src/core/proxy.js';

const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2ln';
const HOST_KEY = 'sk-host-configured';
let restoreFetch: (() => void) | undefined;
afterEach(() => { restoreFetch?.(); restoreFetch = undefined; });

function mockUpstream(assertion: (req: Request) => void): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    assertion(req);
    return new Response(JSON.stringify({ id: 'resp_1', output: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; };
}

describe('OpenAI route credential policy', () => {
  const matrix: Array<[InboundCredential, boolean, 'keep-inbound' | 'replace' | 'drop']> = [
    ['none', false, 'drop'], ['none', true, 'replace'],
    ['anthropic-key', false, 'drop'], ['anthropic-key', true, 'replace'],
    ['anthropic-bearer', false, 'drop'], ['anthropic-bearer', true, 'replace'],
    ['oauth-jwt', false, 'keep-inbound'], ['oauth-jwt', true, 'keep-inbound'],
    ['api-key-bearer', false, 'keep-inbound'], ['api-key-bearer', true, 'replace'],
    ['opaque-bearer', false, 'keep-inbound'], ['opaque-bearer', true, 'replace'],
  ];

  it.each(matrix)('%s / configured=%s => %s', (kind, configured, expected) => {
    expect(resolveOpenAIRouteAuth(kind, configured).action).toBe(expected);
  });

  it('classifies credentials by shape without reading a token store', () => {
    expect(classifyInboundCredential(new Headers())).toBe('none');
    expect(classifyInboundCredential(new Headers({ 'x-api-key': 'sk-ant-api03-x' }))).toBe('anthropic-key');
    expect(classifyInboundCredential(new Headers({ authorization: 'Bearer sk-ant-oat01-x' }))).toBe('anthropic-bearer');
    expect(classifyInboundCredential(new Headers({ authorization: `Bearer ${JWT}` }))).toBe('oauth-jwt');
    expect(classifyInboundCredential(new Headers({ authorization: 'Bearer sk-proj-x' }))).toBe('api-key-bearer');
  });

  it('preserves caller subscription OAuth even when a host OpenAI key exists', async () => {
    mockUpstream((req) => expect(req.headers.get('authorization')).toBe(`Bearer ${JWT}`));
    const proxy = createProxy({
      openAIUpstream: 'https://openai.test',
      openAIApiKey: HOST_KEY,
      transform: { compress: false },
    });
    const res = await proxy(new Request('http://pxpipe/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${JWT}` },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
    }));
    expect(res.status).toBe(200);
  });

  it('never forwards an Anthropic-shaped bearer to an OpenAI upstream', async () => {
    mockUpstream((req) => expect(req.headers.has('authorization')).toBe(false));
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', transform: { compress: false } });
    const res = await proxy(new Request('http://pxpipe/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat01-secret' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
    }));
    expect(res.status).toBe(200);
  });
});
