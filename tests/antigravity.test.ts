import { describe, expect, it } from 'vitest';
import {
  inspectAntigravityEnvelope,
  isAntigravityInferencePath,
  transformAntigravityGenerateContent,
} from '../src/core/antigravity.js';
import { resolveCompressionProfile } from '../src/core/safety-policy.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'project-opaque-123',
    model: 'gemini-3.6-flash-high',
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: 'request-opaque-456',
    request: {
      systemInstruction: {
        parts: [{ text: 'Critical coding authority. '.repeat(1000) }],
      },
      contents: [{ role: 'user', parts: [{ text: 'Inspect the repository.' }] }],
      tools: [{ functionDeclarations: [{
        name: 'read_file',
        description: 'Read exact source. '.repeat(250),
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
        },
      }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      sessionId: 'session-opaque-789',
    },
    ...overrides,
  };
}

describe('Antigravity inference envelope', () => {
  it.each([
    '/v1internal:generateContent',
    '/v1internal:streamGenerateContent',
  ])('recognizes the grounded inference path %s', (path) => {
    expect(isAntigravityInferencePath(path)).toBe(true);
  });

  it.each([
    '/v1internal:countTokens',
    '/v1/models',
    '/v1internal:loadCodeAssist',
    '/v1beta/models/gemini-3.6-flash:generateContent',
  ])('does not claim non-grounded/control-plane path %s', (path) => {
    expect(isAntigravityInferencePath(path)).toBe(false);
  });

  it('extracts only safe routing metadata', () => {
    const body = enc.encode(JSON.stringify(envelope()));
    const metadata = inspectAntigravityEnvelope(body);
    expect(metadata).toEqual({
      model: 'gemini-3.6-flash-high',
      projectPresent: true,
      requestType: 'agent',
      userAgent: 'antigravity',
    });
    expect(JSON.stringify(metadata)).not.toContain('project-opaque-123');
    expect(JSON.stringify(metadata)).not.toContain('request-opaque-456');
    expect(JSON.stringify(metadata)).not.toContain('session-opaque-789');
  });

  it('returns exact original outer bytes when coding-safe leaves live authority native', async () => {
    const source = `{  "project":"p", "model":"gemini-3.6-flash-high", "request":${JSON.stringify({
      systemInstruction: { parts: [{ text: 'Critical authority. '.repeat(1000) }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })}, "requestId":"opaque"  }`;
    const body = enc.encode(source);
    const result = await transformAntigravityGenerateContent(
      body,
      resolveCompressionProfile('coding-safe').transform,
    );
    expect(result.info.compressed).toBe(false);
    expect(dec.decode(result.body)).toBe(source);
  });

  it('rewrites only the nested request when an explicit aggressive transform applies', async () => {
    const original = envelope();
    const body = enc.encode(JSON.stringify(original));
    const result = await transformAntigravityGenerateContent(body, {
      compress: true,
      compressTools: true,
      compressToolResults: true,
      minCompressChars: 1,
      collapseHistory: true,
      requireLosslessRender: false,
      charsPerToken: 1,
    });
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    for (const key of ['project', 'model', 'userAgent', 'requestType', 'requestId']) {
      expect(out[key]).toEqual(original[key]);
    }
    const beforeRequest = original.request as Record<string, unknown>;
    const afterRequest = out.request as Record<string, unknown>;
    expect(afterRequest.generationConfig).toEqual(beforeRequest.generationConfig);
    expect(afterRequest.sessionId).toEqual(beforeRequest.sessionId);
    expect(JSON.stringify(afterRequest)).toContain('inlineData');
  });

  it('fails closed and byte-exact on malformed or incomplete envelopes', async () => {
    for (const source of [
      '{not-json',
      JSON.stringify({ model: 'gemini-3.6-flash-high' }),
      JSON.stringify({ request: { contents: [] } }),
    ]) {
      const body = enc.encode(source);
      const result = await transformAntigravityGenerateContent(body, { compress: true });
      expect(result.info.compressed).toBe(false);
      expect(dec.decode(result.body)).toBe(source);
    }
  });
});
