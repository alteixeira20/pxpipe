import { parseRoute, type Route } from './route.js';

/**
 * Inference-only routes served by the persistent PXPipe listener. Each target
 * lands on an explicit provider prefix, so the single Node port can safely
 * distinguish otherwise ambiguous OpenAI-compatible traffic.
 *
 * CONNECT is still host-scoped: hosts not listed here are never decrypted and
 * are tunneled byte-for-byte by createWarpHandlers. On a listed host, unmatched
 * paths are re-originated to the real host unchanged.
 */
export function persistentWarpRouteSpecs(port: number): string[] {
  const local = `http://127.0.0.1:${port}`;
  return [
    `api.anthropic.com/v1/messages*=${local}/providers/anthropic`,
    `api.openai.com/v1/chat/completions*=${local}/providers/openai`,
    `api.openai.com/v1/responses*=${local}/providers/openai`,
    `api.featherless.ai/v1/chat/completions*=${local}/providers/featherless`,
    `api.featherless.ai/v1/responses*=${local}/providers/featherless`,
    `generativelanguage.googleapis.com/v1beta/models/*:generateContent*=${local}/providers/google`,
    `generativelanguage.googleapis.com/v1beta/models/*:streamGenerateContent*=${local}/providers/google`,
    `generativelanguage.googleapis.com/v1/models/*:generateContent*=${local}/providers/google`,
    `generativelanguage.googleapis.com/v1/models/*:streamGenerateContent*=${local}/providers/google`,
  ];
}

/** Extra operator routes are intentionally first-match-wins ahead of the built-ins. */
export function buildPersistentWarpRoutes(
  port: number,
  extraSpecs: readonly string[] = [],
): Route[] {
  return [
    ...extraSpecs.map((spec) => parseRoute(spec)),
    ...persistentWarpRouteSpecs(port).map((spec) => parseRoute(spec)),
  ];
}

export function parsePersistentWarpRouteEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
