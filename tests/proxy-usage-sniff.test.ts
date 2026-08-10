/**
 * Usage accounting when the provider declares no content-type.
 *
 * The ChatGPT backend the Codex CLI talks to streams its Responses SSE with NO
 * `content-type` response header. The usage scanner was gated purely on that
 * header, so every live Codex event was written with no token accounting at
 * all — the provider's own terminal `response.completed` usage block was read
 * past and discarded. These fixtures reproduce the captured wire shape.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

let ambientModels: string | undefined;
beforeAll(() => {
  ambientModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'gpt-5.6-sol';
});
afterAll(() => {
  if (ambientModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientModels;
});

function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const request = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(request));
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

/** The captured Codex stream shape: `event:` + `data:` lines, usage nested
 *  under `response` on the terminal event. */
function codexResponsesSse(): string {
  const response = { id: 'resp_1', model: 'gpt-5.6-sol', status: 'in_progress' };
  return [
    ['response.created', { response }],
    ['response.output_text.delta', { delta: 'PXPIPE' }],
    ['response.output_text.delta', { delta: '_OK' }],
    ['response.completed', {
      response: {
        ...response,
        status: 'completed',
        usage: {
          input_tokens: 11_837,
          input_tokens_details: { cache_write_tokens: 0, cached_tokens: 64 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 11_847,
        },
      },
    }],
  ].map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`,
  ).join('');
}

async function runCodexTurn(responseInit: ResponseInit): Promise<ProxyEvent | undefined> {
  const restore = mockUpstream(() => new Response(codexResponsesSse(), responseInit));
  let event: ProxyEvent | undefined;
  const proxy = createProxy({
    openAIUpstream: 'https://chatgpt.test',
    openAIModels: ['gpt-5.6-sol'],
    transform: { compress: false },
    onRequest: (e) => { event = e; },
  });
  await (await proxy(new Request('http://localhost/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, input: 'go' }),
  }))).text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  restore();
  return event;
}

describe('usage extraction without a declared content-type', () => {
  it('reads the provider usage block from an SSE stream that declares no content-type', async () => {
    const event = await runCodexTurn({});
    expect(event?.usage?.input_tokens).toBe(11_837);
    expect(event?.usage?.output_tokens).toBe(10);
    expect(event?.usage?.cached_tokens).toBe(64);
    expect(event?.stopReason).toBe('stop');
  });

  it('reads it identically when the header IS present, so nothing regressed', async () => {
    const event = await runCodexTurn({ headers: { 'content-type': 'text/event-stream' } });
    expect(event?.usage?.input_tokens).toBe(11_837);
    expect(event?.usage?.output_tokens).toBe(10);
  });

  it('reports no usage rather than an estimate when the provider ships none', async () => {
    const restore = mockUpstream(() => new Response(
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      {},
    ));
    let event: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://chatgpt.test',
      openAIModels: ['gpt-5.6-sol'],
      transform: { compress: false },
      onRequest: (e) => { event = e; },
    });
    await (await proxy(new Request('http://localhost/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, input: 'go' }),
    }))).text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();
    expect(event?.usage?.input_tokens).toBeUndefined();
    expect(event?.usage?.output_tokens).toBeUndefined();
  });

  it('still reads a JSON body that declares no content-type', async () => {
    const restore = mockUpstream(() => new Response(JSON.stringify({
      id: 'resp_2',
      object: 'response',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 21, output_tokens: 3 },
    }), {}));
    let event: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://chatgpt.test',
      openAIModels: ['gpt-5.6-sol'],
      transform: { compress: false },
      onRequest: (e) => { event = e; },
    });
    await (await proxy(new Request('http://localhost/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'go' }),
    }))).text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();
    expect(event?.usage?.input_tokens).toBe(21);
    expect(event?.usage?.output_tokens).toBe(3);
  });

  it('passes the body through to the client byte for byte', async () => {
    const restore = mockUpstream(() => new Response(codexResponsesSse(), {}));
    const proxy = createProxy({
      openAIUpstream: 'https://chatgpt.test',
      openAIModels: ['gpt-5.6-sol'],
      transform: { compress: false },
    });
    const out = await (await proxy(new Request('http://localhost/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, input: 'go' }),
    }))).text();
    restore();
    expect(out).toBe(codexResponsesSse());
  });
});
