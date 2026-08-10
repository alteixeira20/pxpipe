from pathlib import Path

p = Path('tests/antigravity-proxy.test.ts')
text = p.read_text()
old = """import { createProxy, type ProxyEvent } from '../src/core/proxy.js';\nimport { setAllowedModelBases, setCompressionSafetyScope } from '../src/core/applicability.js';\n"""
new = """import { createProxy, type ProxyEvent } from '../src/core/proxy.js';\nimport { setAllowedModelBases, setCompressionSafetyScope } from '../src/core/applicability.js';\nimport { mergeCompressionProfileOptions, resolveCompressionProfile } from '../src/core/safety-policy.js';\n"""
if old not in text:
    raise SystemExit('antigravity imports not found')
text = text.replace(old, new, 1)
old = """    const proxy = createProxy({\n      googleEnvelope: 'antigravity',\n      upstream: 'https://cloudcode-pa.googleapis.com',\n      customFetch: vi.fn(async (_input, init) => {\n"""
# Replace the second occurrence: the first test intentionally uses its explicit
# aggressive transform. The coding-safe history case is after that block.
pos1 = text.find(old)
if pos1 < 0:
    raise SystemExit('first antigravity proxy block not found')
pos2 = text.find(old, pos1 + len(old))
if pos2 < 0:
    raise SystemExit('coding-safe antigravity proxy block not found')
new = """    const proxy = createProxy({\n      googleEnvelope: 'antigravity',\n      upstream: 'https://cloudcode-pa.googleapis.com',\n      transform: mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe')),\n      customFetch: vi.fn(async (_input, init) => {\n"""
text = text[:pos2] + text[pos2:].replace(old, new, 1)
p.write_text(text)
print('production coding-safe Antigravity integration test fixed')
