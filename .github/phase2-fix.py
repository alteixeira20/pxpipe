from pathlib import Path

p = Path('src/core/google.ts')
text = p.read_text()
old = """async function compressGoogleToolResults(\n  contents: GoogleContent[],\n  modelName: string,\n  options: {\n    compressToolResults?: boolean;\n    minToolResultChars?: number;\n    maxImagesPerToolResult?: number;\n    reflow?: boolean;\n  },\n): Promise<GoogleToolResultPlan> {\n"""
new = """async function compressGoogleToolResults(\n  contents: GoogleContent[],\n  modelName: string,\n  options: TransformOptions,\n): Promise<GoogleToolResultPlan> {\n"""
if old not in text:
    raise SystemExit('compressGoogleToolResults signature not found')
p.write_text(text.replace(old, new, 1))
print('phase2 type contract fixed')
