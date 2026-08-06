import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

const dense = (size: number): string => Array.from(
  { length: Math.ceil(size / 22) },
  (_, index) => `entry_${index}=value_${index * 65537}`,
).join('\n').slice(0, size);

let previousModels: string | undefined;
beforeEach(() => {
  previousModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'moonshotai/Kimi-K3';
});
afterEach(() => {
  if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = previousModels;
});

describe('Featherless OpenAI-compatible contracts', () => {
  it('preserves structured output, tools, native images and unsupported media parts', async () => {
    let capturedBody: any;
    const exactSse = [
      'data: {"id":"chunk-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{\\"id\\":\\"abc\\"}"}}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":321,"completion_tokens":9,"total_tokens":330},"provider_extension":{"keep":true}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    let event: ProxyEvent | undefined;

    const customFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url.includes('/v1/models/')) {
        return new Response(JSON.stringify({
          id: 'moonshotai/Kimi-K3',
          input_modalities: ['text', 'image'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      capturedBody = JSON.parse(await request.text());
      return new Response(exactSse, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-featherless-field': 'preserve-me',
        },
      });
    };

    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    const toolParameters = {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z]+$' } },
      required: ['id'],
      additionalProperties: false,
    };
    const imageOne = 'data:image/png;base64,AAAA';
    const imageTwo = 'data:image/jpeg;base64,BBBB';
    const audioPart = { type: 'input_audio', input_audio: { data: 'CCCC', format: 'wav' } };

    const proxy = createProxy({
      provider: 'featherless',
      openAIUpstream: 'https://api.featherless.ai',
      openAIApiKey: 'secret-test-key',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      customFetch,
      onRequest: (value) => { event = value; },
    });
    const response = await proxy(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-test-key' },
      body: JSON.stringify({
        model: 'moonshotai/Kimi-K3',
        stream: true,
        messages: [
          { role: 'system', content: dense(70_000) },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageOne, detail: 'auto' } },
              { type: 'image_url', image_url: { url: imageTwo, detail: 'low' } },
              audioPart,
              { type: 'text', text: 'Use all supported inputs and call the tool.' },
            ],
          },
        ],
        tools: [{
          type: 'function',
          function: { name: 'lookup', description: 'Lookup one value.', parameters: toolParameters },
        }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', strict: true, schema },
        },
      }),
    }));

    expect(await response.text()).toBe(exactSse);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const wire = JSON.stringify(capturedBody);
    expect(wire.match(/data:image\/png;base64,AAAA/g)).toHaveLength(1);
    expect(wire.match(/data:image\/jpeg;base64,BBBB/g)).toHaveLength(1);
    expect(wire).toContain(JSON.stringify(audioPart));
    expect(capturedBody.tools[0].function.parameters).toEqual(toolParameters);
    expect(capturedBody.response_format.json_schema.schema).toEqual(schema);
    expect(response.headers.get('x-featherless-field')).toBe('preserve-me');
    expect(event?.usage).toMatchObject({ input_tokens: 321, output_tokens: 9 });
    expect(event?.accountingProvider).toBe('openai');
  });

  it('preserves a slash-qualified model identifier end to end', async () => {
    const seen: string[] = [];
    const customFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      seen.push(request.url);
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ vision_supported: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(await request.text());
      expect(body.model).toBe('moonshotai/Kimi-K3');
      return new Response('{"choices":[{"message":{"content":"ok"}}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const proxy = createProxy({
      provider: 'featherless',
      openAIUpstream: 'https://api.featherless.ai/v1',
      openAIApiKey: 'test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      customFetch,
    });
    const response = await proxy(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'moonshotai/Kimi-K3',
        messages: [{ role: 'user', content: 'Reply with ok.' }],
      }),
    }));
    await response.text();

    expect(seen[0]).toContain('/v1/models/moonshotai/Kimi-K3');
    expect(seen[1]).toBe('https://api.featherless.ai/v1/chat/completions');
  });
});
