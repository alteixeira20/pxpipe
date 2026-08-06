import { describe, expect, it, vi } from 'vitest';

import {
  assertProviderId,
  createProviderRouter,
  parseProviderRoute,
} from '../src/core/provider-router.js';

function echoFetch(calls: Array<{ url: string; body: string; authorization: string | null }>): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request
      ? input
      : new Request(String(input), {
          ...init,
          // Node requires duplex when a streamed body is forwarded.
          ...(init?.body ? { duplex: 'half' as const } : {}),
        });
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? ''
      : await request.text();
    calls.push({
      url: request.url,
      body,
      authorization: request.headers.get('authorization'),
    });
    return new Response(JSON.stringify({
      url: request.url,
      body,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-upstream': new URL(request.url).host,
      },
    });
  });
}

describe('provider route parsing', () => {
  it('extracts a provider id and preserves the complete upstream path', () => {
    expect(parseProviderRoute('/providers/featherless/v1/chat/completions')).toEqual({
      providerId: 'featherless',
      upstreamPath: '/v1/chat/completions',
    });
  });

  it.each([
    '/v1/chat/completions',
    '/providers/',
    '/providers/featherless',
    '/providers/Featherless/v1/chat/completions',
    '/providers/featherless//v1/chat/completions',
  ])('does not accept malformed explicit route %s', (path) => {
    expect(parseProviderRoute(path)).toBeNull();
  });

  it('rejects unsafe or ambiguous provider identifiers', () => {
    expect(() => assertProviderId('Featherless')).toThrow(/invalid provider id/);
    expect(() => assertProviderId('../openai')).toThrow(/invalid provider id/);
    expect(() => assertProviderId('')).toThrow(/invalid provider id/);
  });
});

describe('single-listener provider router', () => {
  it('routes explicit providers while preserving query, body and response headers', async () => {
    const legacyCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const featherlessCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const observed: string[] = [];

    const router = createProviderRouter({
      defaultProxy: {
        openAIUpstream: 'https://api.openai.example',
        customFetch: echoFetch(legacyCalls),
      },
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        proxy: {
          provider: 'featherless',
          featherlessTransformMode: 'off',
          openAIUpstream: 'https://api.featherless.example',
          openAIApiKey: 'provider-key',
          customFetch: echoFetch(featherlessCalls),
          onRequest: (event) => observed.push(`provider:${event.provider}`),
        },
      }],
      onRequest: (providerId, event) => observed.push(`router:${providerId}:${event.provider}`),
    });

    const payload = {
      model: 'moonshotai/Kimi-K3',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
    };

    const response = await router(new Request(
      'http://127.0.0.1:47821/providers/featherless/v1/chat/completions?trace=one',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer client-key',
        },
        body: JSON.stringify(payload),
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream')).toBe('api.featherless.example');
    expect(legacyCalls).toHaveLength(0);
    expect(featherlessCalls).toHaveLength(1);
    expect(featherlessCalls[0]).toMatchObject({
      url: 'https://api.featherless.example/v1/chat/completions?trace=one',
      authorization: 'Bearer provider-key',
    });
    expect(JSON.parse(featherlessCalls[0]!.body)).toEqual(payload);

    // Request telemetry is finalized when the streamed upstream response
    // reaches EOF. Consume the body before asserting completion observers.
    expect(await response.json()).toEqual({
      url: 'https://api.featherless.example/v1/chat/completions?trace=one',
      body: JSON.stringify(payload),
    });

    await vi.waitFor(() => {
      expect(observed).toEqual([
        'provider:featherless',
        'router:featherless:featherless',
      ]);
    });
  });

  it('keeps legacy unprefixed routes on the default proxy', async () => {
    const legacyCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const providerCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const router = createProviderRouter({
      defaultProxy: {
        openAIUpstream: 'https://api.openai.example',
        customFetch: echoFetch(legacyCalls),
      },
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        proxy: {
          provider: 'featherless',
          featherlessTransformMode: 'off',
          openAIUpstream: 'https://api.featherless.example',
          customFetch: echoFetch(providerCalls),
        },
      }],
    });

    const response = await router(new Request('http://127.0.0.1:47821/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'OK' }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(legacyCalls).toHaveLength(1);
    expect(legacyCalls[0]!.url).toBe('https://api.openai.example/v1/chat/completions');
    expect(providerCalls).toHaveLength(0);
  });

  it('rejects an unknown explicit provider without contacting any upstream', async () => {
    const calls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const router = createProviderRouter({
      defaultProxy: {
        openAIUpstream: 'https://api.openai.example',
        customFetch: echoFetch(calls),
      },
      providers: [],
    });

    const response = await router(new Request(
      'http://127.0.0.1:47821/providers/missing/v1/chat/completions',
      { method: 'POST', body: '{}' },
    ));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'unknown_provider',
      provider: 'missing',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects duplicate provider ids during construction', () => {
    expect(() => createProviderRouter({
      defaultProxy: {},
      providers: [
        { id: 'same', protocol: 'openai', proxy: {} },
        { id: 'same', protocol: 'anthropic', proxy: {} },
      ],
    })).toThrow(/duplicate provider id/);
  });

  it('exposes a credential-free route inspection snapshot', () => {
    const router = createProviderRouter({
      defaultProxy: { openAIApiKey: 'default-secret' },
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        proxy: { openAIApiKey: 'provider-secret' },
      }],
    });

    expect(router.inspect()).toEqual({
      defaultRoute: 'legacy',
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        prefix: '/providers/featherless',
      }],
    });
    expect(JSON.stringify(router.inspect())).not.toContain('secret');
  });
});
