import { describe, expect, it } from 'vitest';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { transformAntigravityGenerateContent } from '../src/core/antigravity.js';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
} from '../src/core/safety-policy.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function request(turns: number, charsPerTurn: number) {
  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: 'CRITICAL: keep this system authority native. ' + 'RULE '.repeat(3000) }],
    },
    contents: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn-${i} ` + String.fromCharCode(65 + (i % 20)).repeat(charsPerTurn) }],
    })),
  };
}

describe('Google coding-safe history policy', () => {
  it('keeps authority + eight recent contents native while imaging a profitable old closed prefix', async () => {
    const original = request(12, 5000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(4);
    expect(out.info.bucketChars?.static_slab ?? 0).toBe(0);
    expect(out.info.bucketChars?.history).toBeGreaterThan(0);
    expect(out.info.imageCount).toBeGreaterThan(0);

    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);
    const tailTexts = parsed.contents.slice(-8).map((c: any) => c.parts?.[0]?.text);
    expect(tailTexts).toEqual(original.contents.slice(-8).map((c) => c.parts[0]!.text));
  });

  it('does not image a fresh one-turn coding-safe request and explains the lack of old history', async () => {
    const original = request(1, 1000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(false);
    expect(out.info.historyReason).toBe('no_history');
    expect(dec.decode(out.body)).toBe(JSON.stringify(original));
  });

  it('balanced keeps six recent contents native but can collapse two sufficiently large old units', async () => {
    const original = request(8, 6500);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('balanced'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(2);
    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);
    expect(parsed.contents.slice(-6).map((c: any) => c.parts?.[0]?.text)).toEqual(
      original.contents.slice(-6).map((c) => c.parts[0]!.text),
    );
  });

  it('correctly integrates precision ledger with secret filtering and telemetry in old closed history prefix under coding-safe', async () => {
    const original = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'CRITICAL SYSTEM AUTHORITY: keep native. ' + 'AUTHORITY '.repeat(2000) }],
      },
      contents: [
        {
          role: 'user',
          parts: [{
            text: 'Here is the setup for src/core/google.ts:123 with version v2.4.1 and secret API key sk-proj-1234567890abcdef1234567890abcdef. ' +
              'CONFIG_ID=MAX_HISTORY_TURNS '.repeat(200),
          }],
        },
        {
          role: 'model',
          parts: [{
            text: 'I parsed processUserPayload from src/core/factsheet.ts:55. Secret token sk-proj-9876543210fedcba9876543210fedcba was noted. ' +
              'LOG_ENTRY_OK '.repeat(200),
          }],
        },
        {
          role: 'user',
          parts: [{ text: 'Updating database schema v3.1.0 in db/migrations/001_init.sql:42. ' + 'FILL '.repeat(200) }],
        },
        {
          role: 'model',
          parts: [{ text: 'Migration completed for DB_HOST=localhost:5432. ' + 'OK '.repeat(200) }],
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'model',
          parts: [{ text: `tail-turn-${i} ` + 'TAIL_DATA '.repeat(100) }],
        })),
      ],
    };

    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );

    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(4);
    expect(out.info.imageCount).toBeGreaterThan(0);

    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);

    const tailTexts = parsed.contents.slice(-8).map((c: any) => c.parts?.[0]?.text);
    expect(tailTexts).toEqual(original.contents.slice(-8).map((c) => c.parts[0]!.text));

    const syntheticTurn = parsed.contents[0];
    const ledgerTextPart = syntheticTurn.parts.find(
      (p: any) => typeof p.text === 'string' && p.text.includes('Exact identifiers'),
    );
    expect(ledgerTextPart).toBeDefined();
    const ledgerText = ledgerTextPart.text;

    expect(ledgerText).not.toContain('sk-proj-1234567890abcdef1234567890abcdef');
    expect(ledgerText).not.toContain('sk-proj-9876543210fedcba9876543210fedcba');

    expect(ledgerText).toContain('src/core/google.ts:123');
    expect(ledgerText).toContain('v2.4.1');

    expect(out.info.factsheetTelemetry).toBeDefined();
    expect(out.info.factsheetTelemetry!.entriesEmitted).toBeGreaterThan(0);
    expect(out.info.factsheetTelemetry!.approxTokens).toBeGreaterThan(0);

    expect(out.info.imageTokens + out.info.nativeInjectedTokens).toBeLessThan(
      out.info.baselineImagedTokens,
    );
  });

  it('proves ledger reduction when image-only clears ratio but full ledger would exceed margin', async () => {
    const identifiers = Array.from(
      { length: 50 },
      (_, i) => `src/core/module_${i}.ts:${10 + i}: export_symbol_${i} = ${1000 + i};`,
    ).join('\n');

    const original = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'CRITICAL SYSTEM AUTHORITY: keep native. ' + 'AUTHORITY '.repeat(2000) }],
      },
      contents: [
        { role: 'user', parts: [{ text: `Setup identifiers turn 0:\n${identifiers}\n` + 'PROSE '.repeat(350) }] },
        { role: 'model', parts: [{ text: `Response turn 1:\n${identifiers}\n` + 'PROSE '.repeat(350) }] },
        { role: 'user', parts: [{ text: `Turn 2 data:\n${identifiers}\n` + 'PROSE '.repeat(350) }] },
        { role: 'model', parts: [{ text: `Turn 3 response:\n${identifiers}\n` + 'PROSE '.repeat(350) }] },
        ...Array.from({ length: 8 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'model',
          parts: [{ text: `tail-turn-${i} ` + 'TAIL_DATA '.repeat(100) }],
        })),
      ],
    };

    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const selectedRatio = 0.28;
    opts.googleMaxImageToTextRatio = selectedRatio;

    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );

    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(4);
    expect(out.info.factsheetTelemetry).toBeDefined();
    expect(out.info.factsheetTelemetry!.budgetDynamicallyReduced).toBe(true);

    const maxAllowedTokens = Math.floor(out.info.baselineImagedTokens * selectedRatio);
    const totalCost = out.info.imageTokens + out.info.nativeInjectedTokens;
    expect(totalCost).toBeLessThan(maxAllowedTokens);
  });

  it('proves abstention when history image cost itself exceeds the selected profitability ratio', async () => {
    const original = request(12, 1000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    opts.googleMaxImageToTextRatio = 0.05;

    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );

    expect(out.info.compressed).toBe(false);
    expect(out.info.historyReason).toBe('not_profitable');
  });

  it('exercises nested Antigravity envelope for safe history collapse with precision ledger', async () => {
    const innerRequest = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'CRITICAL SYSTEM AUTHORITY: keep native. ' + 'AUTHORITY '.repeat(2000) }],
      },
      contents: Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'model',
        parts: [{ text: `turn-${i} identifier-path/src/file_${i}.ts:${i * 10} ` + 'DATA '.repeat(400) }],
      })),
    };
    const outerEnvelope = {
      project: 'projects/test-project-123',
      model: 'gemini-3.6-flash-high',
      userAgent: 'antigravity/2.0',
      requestType: 'agent',
      requestId: 'req-uuid-999',
      request: innerRequest,
    };

    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const result = await transformAntigravityGenerateContent(
      enc.encode(JSON.stringify(outerEnvelope)),
      opts,
    );

    expect(result.info.compressed).toBe(true);
    expect(result.info.collapsedTurns).toBe(4);
    expect(result.info.factsheetTelemetry).toBeDefined();

    const parsedEnvelope = JSON.parse(dec.decode(result.body));
    expect(parsedEnvelope.project).toBe('projects/test-project-123');
    expect(parsedEnvelope.model).toBe('gemini-3.6-flash-high');
    expect(parsedEnvelope.request.systemInstruction).toEqual(innerRequest.systemInstruction);
  });
});
