from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected snippet not found in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


replace(
    'src/agy-models.ts',
    """  return /^(?:claude-|gemini-|gpt[-_]|o\\d)/i.test(candidate)\n    || /[0-9/:.]/.test(candidate);\n""",
    """  return /\\d/.test(candidate)\n    || /[/:.]/.test(candidate)\n    || /(?:^|[-_])latest(?:$|[-_])/i.test(candidate);\n""",
)
replace(
    'src/agy-models.ts',
    """      for (const match of line.matchAll(KNOWN_MODEL_TOKEN)) {\n        addModel(unique, match[0]);\n        if (unique.size >= MAX_MODELS) break;\n      }\n""",
    """      for (const match of line.matchAll(KNOWN_MODEL_TOKEN)) {\n        if (plausibleSingleModelId(match[0])) addModel(unique, match[0]);\n        if (unique.size >= MAX_MODELS) break;\n      }\n""",
)
replace(
    'src/agy-models.ts',
    """    for (const match of line.matchAll(KNOWN_MODEL_TOKEN)) {\n      addModel(unique, match[0]);\n      if (unique.size >= MAX_MODELS) break;\n    }\n""",
    """    for (const match of line.matchAll(KNOWN_MODEL_TOKEN)) {\n      if (plausibleSingleModelId(match[0])) addModel(unique, match[0]);\n      if (unique.size >= MAX_MODELS) break;\n    }\n""",
)

replace(
    'src/core/google.ts',
    """  const historyPlan = historyRenderLossy ? null : plannedHistory;\n  let contents = originalContents;\n""",
    """  const historyPlan = historyRenderLossy ? null : plannedHistory;\n  if (options.collapseHistory !== false && !historyPlan) {\n    const keepTail = Math.max(0, Math.floor(\n      options.googleHistory?.keepTail ?? profile.history.keepTail,\n    ));\n    info.historyReason = historyRenderLossy\n      ? 'render_lossy'\n      : originalContents.length > keepTail ? 'not_profitable' : 'no_history';\n  }\n  let contents = originalContents;\n""",
)

print('0.13 materializer fixes applied')
