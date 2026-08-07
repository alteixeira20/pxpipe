import { transformGoogleGenerateContent } from './google.js';
import type { TransformInfo, TransformOptions } from './transform.js';

const ANTIGRAVITY_PATH = /^\/v1internal:(generateContent|streamGenerateContent)$/;

interface AntigravityEnvelope {
  project?: unknown;
  model?: unknown;
  request?: unknown;
  [key: string]: unknown;
}

export interface AntigravityEnvelopeMetadata {
  model: string;
  projectPresent: boolean;
  requestType?: string;
  userAgent?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function passthroughInfo(model: string | undefined, reason: string): TransformInfo {
  return {
    compressed: false,
    reason,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    ...(model ? { systemSha8: undefined } : {}),
  };
}

export function isAntigravityInferencePath(pathname: string): boolean {
  return ANTIGRAVITY_PATH.test(pathname);
}

/**
 * Parse only non-sensitive routing metadata from the Antigravity outer envelope.
 * Prompt/tool/request contents are deliberately not returned by this helper.
 */
export function inspectAntigravityEnvelope(body: Uint8Array): AntigravityEnvelopeMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const envelope = record(parsed) as AntigravityEnvelope | null;
  const request = record(envelope?.request);
  if (!envelope || !request || typeof envelope.model !== 'string' || envelope.model.length === 0) {
    return null;
  }
  return {
    model: envelope.model,
    projectPresent: typeof envelope.project === 'string' && envelope.project.length > 0,
    ...(typeof envelope.requestType === 'string' ? { requestType: envelope.requestType } : {}),
    ...(typeof envelope.userAgent === 'string' ? { userAgent: envelope.userAgent } : {}),
  };
}

/**
 * Transform the nested Google GenerateContent request used by Antigravity/AGY
 * while preserving the provider-owned outer envelope.
 *
 * Grounded wire observations show the provider expects fields such as project,
 * model, userAgent, requestType, requestId and a nested `request` object. PXPipe
 * must never flatten that shape or guess a public Gemini endpoint. Only the
 * nested request enters the existing Google transformer.
 *
 * If the nested request is not transformed, the original outer UTF-8 bytes are
 * returned exactly. This preserves unknown provider fields, ordering and client
 * serialization on every fail-closed/pass-through path.
 */
export async function transformAntigravityGenerateContent(
  bodyBytes: Uint8Array,
  options: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo; metadata?: AntigravityEnvelopeMetadata }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return { body: bodyBytes, info: passthroughInfo(undefined, 'invalid_antigravity_json') };
  }

  const envelope = record(parsed) as AntigravityEnvelope | null;
  const nested = record(envelope?.request);
  const model = typeof envelope?.model === 'string' ? envelope.model : undefined;
  if (!envelope || !nested || !model) {
    return {
      body: bodyBytes,
      info: passthroughInfo(model, 'invalid_antigravity_envelope'),
    };
  }

  const metadata: AntigravityEnvelopeMetadata = {
    model,
    projectPresent: typeof envelope.project === 'string' && envelope.project.length > 0,
    ...(typeof envelope.requestType === 'string' ? { requestType: envelope.requestType } : {}),
    ...(typeof envelope.userAgent === 'string' ? { userAgent: envelope.userAgent } : {}),
  };

  const nestedBytes = new TextEncoder().encode(JSON.stringify(nested));
  const transformed = await transformGoogleGenerateContent(nestedBytes, model, options);
  if (!transformed.info.compressed) {
    // Exact outer byte preservation is a stronger contract than reserializing a
    // semantically equivalent envelope, especially for an undocumented provider.
    return { body: bodyBytes, info: transformed.info, metadata };
  }

  let transformedNested: unknown;
  try {
    transformedNested = JSON.parse(new TextDecoder().decode(transformed.body));
  } catch {
    // The nested transformer only emits JSON, but fail closed if that invariant
    // ever regresses rather than corrupting an authenticated provider request.
    return {
      body: bodyBytes,
      info: passthroughInfo(model, 'antigravity_nested_transform_invalid'),
      metadata,
    };
  }
  if (!record(transformedNested)) {
    return {
      body: bodyBytes,
      info: passthroughInfo(model, 'antigravity_nested_transform_invalid'),
      metadata,
    };
  }

  const out: AntigravityEnvelope = {
    ...envelope,
    request: transformedNested,
  };
  return {
    body: new TextEncoder().encode(JSON.stringify(out)),
    info: transformed.info,
    metadata,
  };
}
