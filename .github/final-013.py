from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected snippet not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


replace(
    'src/core/trajectory.ts',
    """  const model = typeof explicitModel === 'string' && explicitModel\n    ? explicitModel\n    : typeof outer.model === 'string'\n      ? outer.model\n      : '';\n  const sessionSha8 = await sha256Prefix(`${model}\\n${googleFirstUserMaterial(contents)}`, 8);\n""",
    """  const model = typeof explicitModel === 'string' && explicitModel\n    ? explicitModel\n    : typeof outer.model === 'string'\n      ? outer.model\n      : '';\n  // Antigravity exposes a provider-owned nested sessionId. Prefer it over\n  // prompt material so separate AGY sessions with identical opening prompts\n  // cannot share breaker state. Only its digest leaves this function. Public\n  // Google often has no session id, so fall back to the first textual user\n  // request; if neither exists, skip trajectory mutation rather than grouping\n  // unrelated requests under a model-only pseudo-session.\n  const providerSessionId = typeof request.sessionId === 'string'\n    ? request.sessionId.trim()\n    : '';\n  const firstUser = googleFirstUserMaterial(contents);\n  const sessionMaterial = providerSessionId || firstUser;\n  if (!sessionMaterial) return undefined;\n  const sessionSha8 = await sha256Prefix(`${model}\\n${sessionMaterial}`, 8);\n""",
)

# Extend the focused trajectory test with session-collision and empty-session cases.
p = Path('tests/google-trajectory.test.ts')
text = p.read_text()
needle = """  it('understands the nested Antigravity request without hashing provider metadata into the task', async () => {\n"""
if needle not in text:
    raise SystemExit('google trajectory test insertion point missing')
extra = r'''  it('isolates identical AGY prompts by the provider session id', async () => {
    const base = JSON.parse(new TextDecoder().decode(googleBody(1, true)));
    base.request.sessionId = 'agy-session-a';
    const a = await observeGoogleTrajectory(
      enc.encode(JSON.stringify(base)), 'gemini-3.6-flash-high', true,
    );
    base.request.sessionId = 'agy-session-b';
    const b = await observeGoogleTrajectory(
      enc.encode(JSON.stringify(base)), 'gemini-3.6-flash-high', true,
    );
    expect(a?.sessionSha8).not.toBe(b?.sessionSha8);
    expect(a?.newReadLikeCalls).toBe(1);
    expect(b?.newReadLikeCalls).toBe(1);
  });

  it('does not create a model-wide breaker bucket when no session or user material exists', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gemini-3.6-flash-high',
      request: {
        contents: [{ role: 'model', parts: [{ functionCall: { name: 'Read', args: { file_path: '/x' } } }] }],
      },
    }));
    expect(await observeGoogleTrajectory(body, 'gemini-3.6-flash-high', true)).toBeUndefined();
  });

'''
p.write_text(text.replace(needle, extra + needle, 1))

# Add a full proxy-level coding-safe Antigravity history test. This guards the
# exact path the user will deploy, not only the Google transformer in isolation.
p = Path('tests/antigravity-proxy.test.ts')
text = p.read_text()
marker = """  it('parses nested Antigravity SSE usage without changing the response stream', async () => {\n"""
if marker not in text:
    raise SystemExit('antigravity proxy insertion point missing')
case = r'''  it('coding-safe images only old profitable Antigravity history and keeps recent turns native', async () => {
    setCompressionSafetyScope('coding-safe');
    setAllowedModelBases(['gemini-3.6-flash']);
    let outgoing: any = null;
    const events: ProxyEvent[] = [];
    const longHistory = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn-${i} ` + 'archival context '.repeat(800) }],
    }));
    const body = {
      project: 'projects/example',
      model: 'gemini-3.6-flash-high',
      userAgent: 'antigravity',
      requestType: 'agent',
      requestId: 'req-safe-history',
      request: {
        sessionId: 'safe-history-session',
        systemInstruction: { parts: [{ text: 'SYSTEM AUTHORITY MUST STAY NATIVE' }] },
        contents: longHistory,
      },
    };
    const proxy = createProxy({
      googleEnvelope: 'antigravity',
      upstream: 'https://cloudcode-pa.googleapis.com',
      customFetch: vi.fn(async (_input, init) => {
        const rawBody = init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? '');
        outgoing = JSON.parse(rawBody);
        return new Response(JSON.stringify({ response: {
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }],
          usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 7 },
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      onRequest: (event) => events.push(event),
    });

    const response = await proxy(new Request('http://localhost/v1internal:generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(outgoing.request.systemInstruction).toEqual(body.request.systemInstruction);
    expect(JSON.stringify(outgoing.request.contents)).toContain('inlineData');
    const recentText = JSON.stringify(outgoing.request.contents.slice(-8));
    for (const turn of longHistory.slice(-8)) {
      expect(recentText).toContain(turn.parts[0]!.text);
    }
    expect(events[0]!.info?.compressed).toBe(true);
    expect(events[0]!.info?.collapsedTurns).toBeGreaterThanOrEqual(4);
    expect(events[0]!.trajectory?.sessionSha8).toBeTruthy();
  });

'''
p.write_text(text.replace(marker, case + marker, 1))

print('final 0.13 session-isolation hardening materialized')
