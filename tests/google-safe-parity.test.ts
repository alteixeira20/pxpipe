import { describe, expect, it } from 'vitest';
import {
  parseGoogleModelFromPath,
  transformGoogleGenerateContent,
} from '../src/core/google.js';
import { resolveCompressionProfile } from '../src/core/safety-policy.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('Google reliability-profile parity', () => {
  it('recognizes the native Google API path used after provider-prefix stripping', () => {
    expect(parseGoogleModelFromPath(
      '/v1beta/models/gemini-3.6-flash:generateContent',
    )).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath(
      '/v1/models/gemini-3.6-flash:streamGenerateContent',
    )).toBe('gemini-3.6-flash');
  });

  it('keeps system authority and tool documentation native under coding-safe', async () => {
    const profile = resolveCompressionProfile('coding-safe');
    const request = {
      systemInstruction: {
        parts: [{ text: 'Critical system authority. '.repeat(1500) }],
      },
      tools: [{ functionDeclarations: [{
        name: 'read',
        description: 'Read exact source from disk. '.repeat(400),
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string', description: 'Exact path.' } },
          required: ['filePath'],
        },
      }] }],
      contents: [{ role: 'user', parts: [{ text: 'Inspect the repository.' }] }],
    };
    const raw = JSON.stringify(request);
    const result = await transformGoogleGenerateContent(
      enc.encode(raw),
      'gemini-3.6-flash',
      profile.transform,
    );

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toBe('below_threshold');
    expect(dec.decode(result.body)).toBe(raw);
  });

  it('rejects archival history images when the renderer reports a dropped character', async () => {
    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: 'LIVE TASK: keep exact state.' }] },
    ];
    for (let index = 0; index < 24; index += 1) {
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: 'read', args: { filePath: `/tmp/file-${index}.ts` } } }],
      });
      contents.push({
        role: 'user',
        parts: [{ functionResponse: {
          name: 'read',
          response: {
            content: `${index === 0 ? '\ufe0f' : ''} result-${index} `.repeat(220),
          },
        } }],
      });
    }
    const request = { contents };
    const raw = JSON.stringify(request);
    const result = await transformGoogleGenerateContent(
      enc.encode(raw),
      'gemini-3.6-flash',
      {
        compress: true,
        compressTools: false,
        compressToolResults: false,
        minCompressChars: Number.MAX_SAFE_INTEGER,
        collapseHistory: true,
        requireLosslessRender: true,
      },
    );

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toBe('render_lossy');
    expect(result.info.droppedChars ?? 0).toBeGreaterThan(0);
    expect(dec.decode(result.body)).toBe(raw);
  });

  it('retains the historical lossy Google behavior only when explicitly allowed', async () => {
    const request = {
      systemInstruction: { parts: [{ text: 'System instruction. '.repeat(500) }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    };
    const result = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(request)),
      'gemini-3.6-flash',
      { compress: true, minCompressChars: 1, requireLosslessRender: false },
    );
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
  });
});
