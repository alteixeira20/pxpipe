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
    return new Response(JSON.stringify({ url: request.url, body }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-upstream': new URL(request.url).hostname,
      },
    });
  });
}

describe('provider route parsing', () => {
  it('accepts explicit provider paths and strips only the internal prefix', () => {
    expect(parseProviderRoute('/providers/featherless/v1/chat/completions')).toEqual({
      providerId: 'featherless',
      upstreamPath: '/v1/chat/completions',
    });
    expect(parseProviderRoute('/providers/anthropic/v1/messages')).toEqual({
      providerId: 'anthropic',
      upstreamPath: '/v1/messages',
    });
  });

  it('does not treat incomplete or malformed paths as explicit provider routes', () => {
    expect(parseProviderRoute('/v1/messages')).toBeNull();
    expect(parseProviderRoute('/providers/')).toBeNull();
    expect(parseProviderRoute('/providers/Featherless/v1/chat/completions')).toBeNull();
    expect(parseProviderRoute('/providers/featherless')).toBeNull();
    expect(parseProviderRoute('/providers/featherless//v1/chat/completions')).toBeNull();
  });

  it('validates provider identifiers', () => {
    expect(() => assertProviderId('featherless')).not.toThrow();
    expect(() => assertProviderId('openai-compatible')).not.toThrow();
    expect(() => assertProviderId('Bad_Id')).toThrow(/invalid provider id/);
    expect(() => assertProviderId('')).toThrow(/invalid provider id/);
  });
});

describe('provider router', () => {
  it('routes explicit providers while preserving query, body and response headers', async () => {
    const defaultCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const featherlessCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const observed: string[] = [];

    const router = createProviderRouter({
      defaultProxy: {
        upstream: 'https://legacy.example',
        customFetch: echoFetch(defaultCalls),
      },
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        proxy: {
          provider: 'featherless',
          openAIUpstream: 'https://api.featherless.example',
          featherlessTransformMode: 'off',
          customFetch: echoFetch(featherlessCalls),
          onRequest: (event) => observed.push(`provider:${event.provider}`),
        },
      }],
      onRequest: (providerId, event) => {
        observed.push(`router:${providerId}:${event.provider}`);
      },
    });

    const raw = '{"model":"moonshotai/Kimi-K3","messages":[],"spacing":"  preserved  "}';
    const response = await router(new Request(
      'http://127.0.0.1:47821/providers/featherless/v1/chat/completions?trace=one',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer incoming-token',
          'content-type': 'application/json',
        },
        body: raw,
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream')).toBe('api.featherless.example');
    expect(featherlessCalls).toHaveLength(1);
    expect(featherlessCalls[0]!.url).toBe('https://api.featherless.example/v1/chat/completions?trace=one');
    expect(featherlessCalls[0]!.authorization).toBe('Bearer incoming-token');
    expect(featherlessCalls[0]!.body).toBe(raw);
    await response.text();

    await vi.waitFor(() => {
      expect(observed).toEqual([
        'provider:featherless',
        'router:featherless:featherless',
      ]);
    });
  });

  it('keeps legacy unprefixed routes on the default proxy', async () => {
    const calls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const router = createProviderRouter({
      defaultProxy: {
        upstream: 'https://legacy-anthropic.example',
        customFetch: echoFetch(calls),
      },
      providers: [],
    });

    const response = await router(new Request('http://127.0.0.1:47821/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'unsupported-test-model',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://legacy-anthropic.example/v1/messages');
  });

  it('fails unknown explicit providers closed without contacting any upstream', async () => {
    const calls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const router = createProviderRouter({
      defaultProxy: {
        upstream: 'https://legacy.example',
        customFetch: echoFetch(calls),
      },
      providers: [],
    });

    const response = await router(new Request(
      'http://127.0.0.1:47821/providers/not-configured/v1/messages',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'unknown_provider',
      provider: 'not-configured',
    });
    expect(calls).toHaveLength(0);
  });

  it('does not let query/header/body provider hints change the selected route', async () => {
    const defaultCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const explicitCalls: Array<{ url: string; body: string; authorization: string | null }> = [];
    const router = createProviderRouter({
      defaultProxy: {
        upstream: 'https://legacy.example',
        customFetch: echoFetch(defaultCalls),
      },
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        proxy: {
          provider: 'featherless',
          openAIUpstream: 'https://api.featherless.example',
          featherlessTransformMode: 'off',
          customFetch: echoFetch(explicitCalls),
        },
      }],
    });

    const response = await router(new Request(
      'http://127.0.0.1:47821/v1/messages?provider=featherless',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pxpipe-provider': 'featherless',
        },
        body: JSON.stringify({ provider: 'featherless', messages: [] }),
      },
    ));
    expect(response.status).toBe(200);
    expect(defaultCalls).toHaveLength(1);
    expect(explicitCalls).toHaveLength(0);
  });

  it('exposes only credential-free provider metadata', () => {
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example', apiKey: 'default-secret' },
      providers: [{
        id: 'featherless',
        protocol: 'openai',
        proxy: {
          provider: 'featherless',
          openAIUpstream: 'https://api.featherless.example',
          openAIApiKey: 'provider-secret',
        },
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

  it('rejects duplicate provider ids', () => {
    expect(() => createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example' },
      providers: [
        { id: 'same', protocol: 'anthropic', proxy: { upstream: 'https://a.example' } },
        { id: 'same', protocol: 'openai', proxy: { openAIUpstream: 'https://b.example' } },
      ],
    })).toThrow(/duplicate provider id/);
  });
});
