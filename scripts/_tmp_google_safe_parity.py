from pathlib import Path

path = Path('src/core/google.ts')
text = path.read_text()

old = "const GOOGLE_ROUTE = /^\\/google-ai-studio\\/(?:v1|v1beta)\\/models\\/([^/:]+):(generateContent|streamGenerateContent)$/;\n"
new = """// Accept both the historical gateway-prefixed form and the native Google API
// pathname used by the explicit single-listener `/providers/google` route.
const GOOGLE_ROUTE = /^\\/(?:google-ai-studio\\/)?(?:v1|v1beta)\\/models\\/([^/:]+):(generateContent|streamGenerateContent)$/;
"""
if old not in text:
    raise SystemExit('GOOGLE_ROUTE replacement point not found')
text = text.replace(old, new, 1)

old = """    maxImagesPerToolResult?: number;
    cols?: number;
    reflow?: boolean;
  } = {},
"""
new = """    maxImagesPerToolResult?: number;
    cols?: number;
    reflow?: boolean;
    /** Same static-context eligibility threshold used by the cross-provider
     * reliability profiles. coding-safe/balanced set this to MAX_SAFE_INTEGER
     * so system/developer authority remains native. */
    minCompressChars?: number;
    /** Refuse any candidate for which the renderer reports dropped characters. */
    requireLosslessRender?: boolean;
  } = {},
"""
if old not in text:
    raise SystemExit('Google options replacement point not found')
text = text.replace(old, new, 1)

old = """  let renderedText = '';

  if (combinedRaw) {
"""
new = """  let renderedText = '';
  let staticDroppedChars = 0;
  const staticDroppedCodepoints = new Map<number, number>();
  const staticEligible = combinedRaw.length >= (options.minCompressChars ?? 1);

  if (combinedRaw && staticEligible) {
"""
if old not in text:
    raise SystemExit('static eligibility insertion point not found')
text = text.replace(old, new, 1)

old = """    staticImages = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    imageTokens = staticImages.reduce(
"""
new = """    staticImages = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    for (const image of staticImages) {
      staticDroppedChars += image.droppedChars;
      for (const [codepoint, count] of image.droppedCodepoints) {
        staticDroppedCodepoints.set(
          codepoint,
          (staticDroppedCodepoints.get(codepoint) ?? 0) + count,
        );
      }
    }
    imageTokens = staticImages.reduce(
"""
if old not in text:
    raise SystemExit('static dropped-char insertion point not found')
text = text.replace(old, new, 1)

old = """    staticProfitable = info.gateEval.profitable;
  }

  // Build static image parts if static slab is profitable
"""
new = """    staticProfitable = info.gateEval.profitable
      && !(options.requireLosslessRender && staticDroppedChars > 0);
  }

  // Build static image parts if static slab is profitable
"""
if old not in text:
    raise SystemExit('staticProfitable replacement point not found')
text = text.replace(old, new, 1)

old = """  const historyPlan = options.collapseHistory === false
    ? null
    : await planGoogleHistory(originalContents, modelName, options.reflow !== false);
  let contents = originalContents;
  if (historyPlan) {
"""
new = """  const plannedHistory = options.collapseHistory === false
    ? null
    : await planGoogleHistory(originalContents, modelName, options.reflow !== false);
  const historyRenderLossy = Boolean(
    plannedHistory
      && options.requireLosslessRender
      && plannedHistory.droppedChars > 0,
  );
  const historyPlan = historyRenderLossy ? null : plannedHistory;
  let contents = originalContents;
  if (historyPlan) {
"""
if old not in text:
    raise SystemExit('history plan replacement point not found')
text = text.replace(old, new, 1)

old = """  if (!hasStaticCompression && !hasHistoryCompression && !hasToolCompression) {
    if (!combinedRaw) {
      info.reason = 'no_static_context';
    } else if (!staticProfitable) {
      info.reason = 'not_profitable';
    }
    return { body: bodyBytes, info };
  }
"""
new = """  if (!hasStaticCompression && !hasHistoryCompression && !hasToolCompression) {
    if (historyRenderLossy || (options.requireLosslessRender && staticDroppedChars > 0)) {
      info.reason = 'render_lossy';
      info.droppedChars = staticDroppedChars + (plannedHistory?.droppedChars ?? 0);
      const combinedDropped = new Map<number, number>(staticDroppedCodepoints);
      for (const [codepoint, count] of plannedHistory?.droppedCodepoints ?? []) {
        combinedDropped.set(codepoint, (combinedDropped.get(codepoint) ?? 0) + count);
      }
      info.droppedCodepointsTop = droppedCodepointsTop(combinedDropped) ?? info.droppedCodepointsTop;
    } else if (!combinedRaw) {
      info.reason = 'no_static_context';
    } else if (!staticEligible) {
      info.reason = 'below_threshold';
    } else if (!staticProfitable) {
      info.reason = 'not_profitable';
    }
    return { body: bodyBytes, info };
  }
"""
if old not in text:
    raise SystemExit('no-compression reason replacement point not found')
text = text.replace(old, new, 1)

old = """  const effectiveStaticImages = hasStaticCompression ? staticImages : [];
  info.compressed = true;
"""
new = """  const effectiveStaticImages = hasStaticCompression ? staticImages : [];
  if (hasStaticCompression && staticDroppedChars > 0) {
    info.droppedChars = (info.droppedChars ?? 0) + staticDroppedChars;
    info.droppedCodepointsTop = droppedCodepointsTop(staticDroppedCodepoints)
      ?? info.droppedCodepointsTop;
  }
  info.compressed = true;
"""
if old not in text:
    raise SystemExit('static info insertion point not found')
path.write_text(text.replace(old, new, 1))

# Focused tests: direct provider path recognition, native authority under safe
# threshold, renderer-loss rollback for archival history.
test = Path('tests/google-safe-parity.test.ts')
test.write_text(r'''import { describe, expect, it } from 'vitest';
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
''')

# Existing parser expectation changes: native public paths are now intentionally supported.
test = Path('tests/google.test.ts')
text = test.read_text()
old = "    expect(parseGoogleModelFromPath('/v1beta/models/gemini-3.6-flash:streamGenerateContent')).toBeNull();\n"
new = "    expect(parseGoogleModelFromPath('/v1beta/models/gemini-3.6-flash:streamGenerateContent')).toBe('gemini-3.6-flash');\n"
if old not in text:
    raise SystemExit('google parser expectation replacement point not found')
test.write_text(text.replace(old, new, 1))
