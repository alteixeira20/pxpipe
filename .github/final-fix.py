from pathlib import Path

p = Path('tests/antigravity-proxy.test.ts')
text = p.read_text()
old = """import { createProxy, type ProxyEvent } from '../src/core/proxy.js';\nimport { setAllowedModelBases, setCompressionSafetyScope } from '../src/core/applicability.js';\n"""
new = """import { createProxy, type ProxyEvent } from '../src/core/proxy.js';\nimport { setAllowedModelBases, setCompressionSafetyScope } from '../src/core/applicability.js';\nimport { mergeCompressionProfileOptions, resolveCompressionProfile } from '../src/core/safety-policy.js';\n"""
if old not in text:
    raise SystemExit('antigravity imports not found')
text = text.replace(old, new, 1)

case_marker = "it('coding-safe images only old profitable Antigravity history and keeps recent turns native'"
case_start = text.find(case_marker)
if case_start < 0:
    raise SystemExit('coding-safe Antigravity test not found')
proxy_marker = """    const proxy = createProxy({\n      googleEnvelope: 'antigravity',\n      upstream: 'https://cloudcode-pa.googleapis.com',\n"""
proxy_start = text.find(proxy_marker, case_start)
if proxy_start < 0:
    raise SystemExit('coding-safe Antigravity proxy block not found')
insertion = proxy_marker + "      transform: mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe')),\n"
text = text[:proxy_start] + text[proxy_start:].replace(proxy_marker, insertion, 1)
p.write_text(text)
print('production coding-safe Antigravity integration test fixed')
