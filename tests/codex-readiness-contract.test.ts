import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFailOpenProxy } from '../src/core/fail-open.js';
import { createProviderRouter } from '../src/core/provider-router.js';
import { CODEX_PROVIDER_ID, DEFAULT_CODEX_UPSTREAM, codexProviderBaseUrl } from '../src/core/codex.js';
import { resolveCompressionProfile } from '../src/core/safety-policy.js';
import type { ProxyEvent } from '../src/core/proxy.js';

const enc = new TextEncoder();

let originalFetch: typeof fetch;
let previousModels: string | undefined;
let previousProfile: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousModels = process.env.PXPIPE_MODELS;
  previousProfile = process.env.PXPIPE_PROFILE;
  process.env.PXPIPE_MODELS = 'gpt-5.6-sol,gemini-3.6-flash,claude-fable-5';
  process.env.PXPIPE_PROFILE = 'coding-safe';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = previousModels;
  if (previousProfile === undefined) delete process.env.PXPIPE_PROFILE;
  else process.env.PXPIPE_PROFILE = previousProfile;
});

const tools = [{
  type: 'function',
  name: 'shell',
  description: 'Run a shell command in the current workspace.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { cmd: { type: 'array', items: { type: 'string' } } },
    required: ['cmd'],
  },
}];

function longCodexRequest(): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [
    {
      role: 'developer',
      content: 'Project rules: never edit dist/. Keep exact paths, symbols and diagnostics. Run pnpm test.',
    },
  ];
  for (let i = 0; i < 30; i += 1) {
    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: `Round ${i}: inspect src/core/openai.ts:${100 + i}.` }],
    });
    input.push({
      type: 'function_call',
      call_id: `call_${i}`,
      name: 'shell',
      arguments: JSON.stringify({ cmd: ['rg', '-n', `symbol_${i}`, 'src/core/openai.ts'] }),
    });
    input.push({
      type: 'function_call_output',
      call_id: `call_${i}`,
      output: `src/core/openai.ts:${100 + i}: export function symbol_${i}(arg: string): void {}\n`
        + `diagnostic ${i} `.repeat(140),
    });
    input.push({
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: `Round ${i}: symbol_${i} was found at src/core/openai.ts:${100 + i}. `
          + 'Archived analysis prose. '.repeat(90),
      }],
    });
  }
  input.push({
    role: 'user',
    content: [{
      type: 'input_text',
      text: 'CURRENT TASK: report the package name only. Do not modify anything.',
    }],
  });
  return {
    model: 'gpt-5.6-sol',
    instructions: 'You are Codex. Follow AGENTS.md and preserve the current task exactly.',
    tools,
    input,
    stream: true,
  };
}

function terminalSse(): string {
  const response = { id: 'resp_pxpipe', model: 'gpt-5.6-sol', status: 'in_progress' };
  return [
    ['response.created', { response }],
    ['response.output_text.delta', { delta: 'pxpipe-proxy' }],
    ['response.completed', {
      response: {
        ...response,
        status: 'completed',
        usage: {
          input_tokens: 18_400,
          input_tokens_details: { cached_tokens: 12_800, cache_write_tokens: 0 },
          output_tokens: 14,
          total_tokens: 18_414,
        },
      },
    }],
  ].map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`,
  ).join('');
}

function makeRouter(onRequest: (event: ProxyEvent) => void) {
  return createProviderRouter({
    defaultProxy: { upstream: 'https://api.anthropic.invalid' },
    handlerFactory: createFailOpenProxy,
    providers: [{
      id: CODEX_PROVIDER_ID,
      protocol: 'openai',
      proxy: {
        upstream: DEFAULT_CODEX_UPSTREAM,
        apiKey: undefined,
        authToken: undefined,
        openAIApiKey: undefined,
        transform: { ...resolveCompressionProfile('coding-safe').transform },
        onRequest,
      },
    }],
  });
}

function findCurrentTask(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some((item) => {
    if (!item || typeof item !== 'object' || (item as { role?: unknown }).role !== 'user') return false;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some((part) =>
      part && typeof part === 'object'
      && (part as { type?: unknown }).type === 'input_text'
      && (part as { text?: unknown }).text === 'CURRENT TASK: report the package name only. Do not modify anything.',
    );
  });
}

describe('Codex installed-route contract', () => {
  it('routes, safely compresses eligible Sol history, and accounts terminal Responses usage', async () => {
    const upstream: Request[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      upstream.push(request.clone());
      return new Response(terminalSse(), { status: 200 });
    }) as typeof fetch;

    let event: ProxyEvent | undefined;
    const router = makeRouter((next) => { event = next; });
    const original = longCodexRequest();
    const response = await router(new Request(`${codexProviderBaseUrl(47821)}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer chatgpt-access-token',
        'chatgpt-account-id': 'acct_test',
        originator: 'codex_cli_rs',
        'session-id': 'sess_contract',
      },
      body: enc.encode(JSON.stringify(original)),
    }));

    expect(await response.text()).toBe(terminalSse());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(upstream).toHaveLength(1);
    const sent = upstream[0]!;
    expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(sent.headers.get('authorization')).toBe('Bearer chatgpt-access-token');
    expect(sent.headers.get('chatgpt-account-id')).toBe('acct_test');
    expect(sent.headers.get('originator')).toBe('codex_cli_rs');

    const transformed = JSON.parse(await sent.text()) as {
      instructions?: unknown;
      tools?: unknown;
      input?: unknown;
    };
    expect(transformed.instructions).toBe(original.instructions);
    expect(transformed.tools).toEqual(original.tools);
    expect(findCurrentTask(transformed.input)).toBe(true);
    expect(JSON.stringify(transformed.input)).toContain('"type":"input_image"');

    expect(event?.provider).toBe('openai');
    expect(event?.accountingProvider).toBe('openai');
    expect(event?.path).toBe('/responses');
    expect(event?.model).toBe('gpt-5.6-sol');
    expect(event?.status).toBe(200);
    expect(event?.info?.compressed).toBe(true);
    expect(event?.info?.historyReason).toBe('collapsed');
    expect(event?.info?.imageCount ?? 0).toBeGreaterThan(0);
    expect(event?.info?.droppedChars ?? 0).toBe(0);
    expect(event?.usage?.input_tokens).toBe(18_400);
    expect(event?.usage?.cached_tokens).toBe(12_800);
    expect(event?.usage?.output_tokens).toBe(14);
    expect(event?.streamTermination).toBe('response_terminal');
  });
});
