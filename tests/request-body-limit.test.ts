import { afterEach, describe, expect, it } from 'vitest';
import { createProxy, DEFAULT_MAX_REQUEST_BYTES } from '../src/core/proxy.js';

let restoreFetch: (() => void) | undefined;
afterEach(() => { restoreFetch?.(); restoreFetch = undefined; });

function mockUpstream(handler: (req: Request) => Promise<Response> | Response): void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return Promise.resolve(handler(req));
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; };
}

describe('bounded inbound request bodies', () => {
  it('exports a finite conservative default', () => {
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(16 * 1024 * 1024);
  });

  it('returns 413 before upstream when a transformable body exceeds the configured cap', async () => {
    let upstreamCalls = 0;
    mockUpstream(() => { upstreamCalls++; return new Response('{}'); });
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', maxRequestBytes: 32, transform: { compress: false } });
    const body = JSON.stringify({ model: 'gpt-5.6-sol', input: 'x'.repeat(100) });
    const res = await proxy(new Request('http://pxpipe/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    expect(res.status).toBe(413);
    expect(upstreamCalls).toBe(0);
    expect(await res.json()).toMatchObject({ error: { type: 'request_too_large' } });
  });

  it('enforces the streamed size even without content-length', async () => {
    let upstreamCalls = 0;
    mockUpstream(() => { upstreamCalls++; return new Response('{}'); });
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', maxRequestBytes: 16, transform: { compress: false } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"gpt-5.6-sol","input":"'));
        controller.enqueue(new TextEncoder().encode('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'));
        controller.close();
      },
    });
    const res = await proxy(new Request('http://pxpipe/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    expect(res.status).toBe(413);
    expect(upstreamCalls).toBe(0);
  });

  it('bounds model sniffing while preserving a label-only upload byte-for-byte', async () => {
    const payload = new Uint8Array(128 * 1024).fill(65);
    mockUpstream(async (req) => {
      expect(new Uint8Array(await req.arrayBuffer())).toEqual(payload);
      return new Response('ok', { status: 200 });
    });
    const proxy = createProxy({ maxRequestBytes: 1024 });
    const res = await proxy(new Request('http://pxpipe/v1/files', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload,
    }));
    expect(res.status).toBe(200);
  });
});
