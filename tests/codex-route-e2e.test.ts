import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';

import { createFailOpenProxy } from '../src/core/fail-open.js';
import { createProviderRouter } from '../src/core/provider-router.js';
import { type ProxyConfig, type ProxyEvent } from '../src/core/proxy.js';
import { CODEX_PROVIDER_ID, DEFAULT_CODEX_UPSTREAM, codexProviderBaseUrl } from '../src/core/codex.js';

/** Pin the model scope so these route-contract tests are independent of the
 *  developer shell (a PXPipe user has PXPIPE_MODELS exported). */
let ambientModels: string | undefined;
let ambientProfile: string | undefined;
beforeAll(() => {
  ambientModels = process.env.PXPIPE_MODELS;
  ambientProfile = process.env.PXPIPE_PROFILE;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,gemini-3.6-flash';
  delete process.env.PXPIPE_PROFILE;
});
afterAll(() => {
  if (ambientModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientModels;
  if (ambientProfile === undefined) delete process.env.PXPIPE_PROFILE;
  else process.env.PXPIPE_PROFILE = ambientProfile;
});

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function mockUpstream(handler: (req: Request) => Promise<Response> | Response): void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return Promise.resolve(handler(request));
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
}

const responsesReply = () => new Response(
  JSON.stringify({
    id: 'resp_1',
    object: 'response',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pxpipe-proxy' }] }],
    usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

/**
 * The provider registry node.ts installs, reduced to the Codex route.
 *
 * `createFailOpenProxy` is the same handler factory the persistent listener
 * uses, and it is not incidental here: it installs the host safety scope, which
 * is what actually decides whether a GPT request is compressible.
 */
function codexRouter(onRequest: (event: ProxyEvent) => void, transform?: ProxyConfig['transform']) {
  return createProviderRouter({
    defaultProxy: { upstream: 'https://api.anthropic.test' },
    handlerFactory: createFailOpenProxy,
    providers: [
      {
        id: CODEX_PROVIDER_ID,
        protocol: 'openai',
        proxy: {
          upstream: DEFAULT_CODEX_UPSTREAM,
          apiKey: undefined,
          authToken: undefined,
          openAIApiKey: undefined,
          transform: transform ?? { charsPerToken: 1, minCompressChars: 1 },
          onRequest,
        },
      },
    ],
  });
}

/** A Codex turn: the real client sends `model` + `instructions` + `input`. */
function codexTurn(instructionChars = 18_000): string {
  return JSON.stringify({
    model: 'gpt-5.6-sol',
    instructions: 'You are Codex, a coding agent. '.repeat(Math.ceil(instructionChars / 31)),
    input: [{ role: 'user', content: 'Read package.json and tell me the package name.' }],
    stream: false,
  });
}

/** The URL Codex builds from the base PXPipe hands it. */
function codexRequest(body: string): Request {
  return new Request(`${codexProviderBaseUrl(47821)}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Codex's real ChatGPT-auth header set.
      authorization: 'Bearer chatgpt-access-token',
      'chatgpt-account-id': 'acct_123',
      originator: 'codex_cli_rs',
      'session-id': 'sess_1',
      'x-codex-turn-metadata': '{}',
    },
    body,
  });
}

describe('codex provider route', () => {
  it('forwards Codex inference to the ChatGPT backend, not api.openai.com', async () => {
    const upstream: Request[] = [];
    mockUpstream((request) => {
      upstream.push(request.clone());
      return responsesReply();
    });

    let event: ProxyEvent | undefined;
    const router = codexRouter((e) => { event = e; });
    const res = await router(codexRequest(codexTurn()));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(event?.status).toBe(200);
  });

  it('passes the caller\'s ChatGPT credential and Codex headers through untouched', async () => {
    const upstream: Request[] = [];
    mockUpstream((request) => {
      upstream.push(request.clone());
      return responsesReply();
    });

    const router = codexRouter(() => {});
    await (await router(codexRequest(codexTurn()))).text();

    const sent = upstream[0]!;
    // PXPipe configures no key on this route, so it neither reads nor replaces
    // the user's bearer — it forwards exactly what Codex sent.
    expect(sent.headers.get('authorization')).toBe('Bearer chatgpt-access-token');
    expect(sent.headers.get('chatgpt-account-id')).toBe('acct_123');
    expect(sent.headers.get('originator')).toBe('codex_cli_rs');
    expect(sent.headers.get('session-id')).toBe('sess_1');
  });

  it('records a Codex turn as provider=openai — the event a partner looks for', async () => {
    mockUpstream(() => responsesReply());

    let event: ProxyEvent | undefined;
    const router = codexRouter((e) => { event = e; });
    await (await router(codexRequest(codexTurn()))).text();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(event?.provider).toBe('openai');
    expect(event?.accountingProvider).toBe('openai');
    expect(event?.model).toBe('gpt-5.6-sol');
    expect(event?.path).toBe('/responses');
    expect(event?.status).toBe(200);
  });

  it('fails open: an unrecognised Codex endpoint is forwarded untransformed', async () => {
    const upstream: Request[] = [];
    mockUpstream((request) => {
      upstream.push(request.clone());
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const router = codexRouter(() => {});
    // Codex refreshes its model catalogue on startup over the same base.
    const res = await router(new Request(`${codexProviderBaseUrl(47821)}/models?client_version=0.147.0`, {
      headers: { authorization: 'Bearer chatgpt-access-token' },
    }));
    await res.text();

    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.147.0');
    expect(upstream[0]!.headers.get('authorization')).toBe('Bearer chatgpt-access-token');
  });

  it('leaves the request byte-identical when compression is disabled', async () => {
    const upstream: Request[] = [];
    mockUpstream((request) => {
      upstream.push(request.clone());
      return responsesReply();
    });

    const body = codexTurn();
    const router = codexRouter(() => {}, { compress: false });
    await (await router(codexRequest(body))).text();

    expect(await upstream[0]!.text()).toBe(body);
  });
});

describe('codex compression gate under the shipped safety scopes', () => {
  /**
   * Documents the policy a Codex user actually meets. `coding-safe` restricts
   * compression to model families that have passed the coding non-inferiority
   * suite. `gpt-5.6-sol` is now one of them (see
   * tests/coding-safe-model-scope.test.ts), so Codex's own default model is
   * transformed rather than merely measured — while every sibling variant that
   * has NOT been validated is still forwarded untouched.
   */
  const runUnderProfile = async (
    profile: string,
  ): Promise<{ event: ProxyEvent | undefined; upstream: Request[] }> => {
    const previous = process.env.PXPIPE_PROFILE;
    process.env.PXPIPE_PROFILE = profile;
    try {
      const upstream: Request[] = [];
      mockUpstream((request) => {
        upstream.push(request.clone());
        return responsesReply();
      });
      let event: ProxyEvent | undefined;
      const router = codexRouter((e) => { event = e; });
      await (await router(codexRequest(codexTurn()))).text();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { event, upstream };
    } finally {
      restoreFetch?.();
      restoreFetch = undefined;
      if (previous === undefined) delete process.env.PXPIPE_PROFILE;
      else process.env.PXPIPE_PROFILE = previous;
    }
  };

  it('reaches the OpenAI Responses transformer once a scope admits the model', async () => {
    const { event, upstream } = await runUnderProfile('aggressive');
    expect(event?.info?.compressed).toBe(true);
    const sent = JSON.parse(await upstream[0]!.text()) as {
      input: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
    };
    const imaged = sent.input.some((item) => item.content?.some(
      (part) => part.type === 'input_image' && part.image_url?.startsWith('data:image/png;base64,'),
    ));
    expect(imaged).toBe(true);
  });

  it('admits Codex\'s own gpt-5.6-sol under the default coding-safe scope', async () => {
    const { event } = await runUnderProfile('coding-safe');
    expect(event?.model).toBe('gpt-5.6-sol');
    expect(event?.info?.reason).not.toBe('unsupported_model');
  });

  it('still declines an unvalidated sibling variant under coding-safe', async () => {
    // The scope is per validated contract, not per version number: gpt-5.6-terra
    // shares a release with Sol and is still forwarded untransformed.
    const previous = process.env.PXPIPE_PROFILE;
    process.env.PXPIPE_PROFILE = 'coding-safe';
    const body = codexTurn().replace(/gpt-5\.6-sol/g, 'gpt-5.6-terra');
    try {
      const upstream: Request[] = [];
      mockUpstream((request) => {
        upstream.push(request.clone());
        return responsesReply();
      });
      let event: ProxyEvent | undefined;
      const router = codexRouter((e) => { event = e; });
      await (await router(codexRequest(body))).text();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(event?.info?.compressed).toBe(false);
      expect(event?.info?.reason).toBe('unsupported_model');
      expect(await upstream[0]!.text()).toBe(body);
    } finally {
      restoreFetch?.();
      restoreFetch = undefined;
      if (previous === undefined) delete process.env.PXPIPE_PROFILE;
      else process.env.PXPIPE_PROFILE = previous;
    }
  });
});
