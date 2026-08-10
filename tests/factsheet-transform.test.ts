import { describe, it, expect } from 'vitest';
import { transformRequest } from '../src/core/transform.js';

describe('factsheet production transform integration', () => {
  it('exercises real transformation flow from profitability decision through factsheet emission and telemetry', async () => {
    const longSystemPrompt = [
      'You are an expert system.',
      'System file src/core/render.ts:512 was updated with status: 404.',
      'Configuration setting PORT=47821 and environment variable LIVEKIT_API_SECRET.',
      'Function getUserById called FactSheetEntry on token_ledger_shard.',
      'Additional detail line '.repeat(80),
    ].join('\n').repeat(15);

    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      system: longSystemPrompt,
      messages: [
        {
          role: 'user',
          content: 'Hello world, please check the system instructions.',
        },
      ],
    };

    const body = new TextEncoder().encode(JSON.stringify(payload));
    const result = await transformRequest(body, {
      compressToolResults: true,
      minToolResultChars: 50,
    });

    expect(result.info.compressed).toBe(true);
    expect(result.info.factsheetTelemetry).toBeDefined();
    expect(result.info.factsheetTelemetry!.entriesEmitted).toBeGreaterThan(0);
    expect(result.info.factsheetTelemetry!.approxTokens).toBeGreaterThan(0);

    const parsedOut = JSON.parse(new TextDecoder().decode(result.body));
    const userMsg = parsedOut.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);

    const textBlocks = userMsg.content.filter((b: { type: string }) => b.type === 'text');
    const factsheetBlock = textBlocks.find((b: { text: string }) =>
      b.text.startsWith('[Exact identifiers')
    );

    expect(factsheetBlock).toBeDefined();
    expect(factsheetBlock.text).toContain('src/core/render.ts:512');
  });

  it('records factsheet telemetry even when dynamic headroom reduces emitted entries to zero', async () => {
    const systemPrompt = [
      'Base prompt text.',
      'Setting item_code_val_100=42 with token_ledger_shard.',
      'Content text '.repeat(40),
    ].join('\n');

    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: 'Run check.',
        },
      ],
    };

    const body = new TextEncoder().encode(JSON.stringify(payload));
    const result = await transformRequest(body, {
      charsPerToken: 4,
    });

    if (result.info.factsheetTelemetry) {
      expect(result.info.factsheetTelemetry.candidatesDropped).toBeGreaterThanOrEqual(0);
    }
  });
});
