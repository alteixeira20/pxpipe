// Build library ESM + declarations, then bundle each Node CLI entrypoint.
// The Worker target can still be built by wrangler directly from src/worker.ts,
// while dist/worker.js is emitted for package consumers by tsc.
import { build } from 'esbuild';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const OUT = 'dist';
if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Run tsc's JS entry directly with the current Node binary rather than via
// pnpm. This avoids Windows launcher/escaping differences and keeps the build
// independent from the command used to invoke it.
const tscBin = require.resolve('typescript/bin/tsc');
const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
if (tsc.error) {
  console.error(`✗ failed to run tsc: ${tsc.error.message}`);
  process.exit(1);
}
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
console.log('✓ emitted dist/ library modules + declarations');

const sharedBuild = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  define: { __PXPIPE_VERSION__: JSON.stringify(pkg.version) },
  external: [],
};

await build({
  ...sharedBuild,
  entryPoints: ['src/node.ts'],
  outfile: 'dist/node.js',
  banner: { js: '#!/usr/bin/env node' },
});

await build({
  ...sharedBuild,
  entryPoints: ['src/agy.ts'],
  outfile: 'dist/agy.js',
});

console.log('✓ built dist/node.js + dist/agy.js');

// Smoke checks pin the shipped entrypoints rather than source-only behavior.
const versionSmoke = spawnSync(process.execPath, ['dist/node.js', '--version'], { encoding: 'utf8' });
const printedVersion = (versionSmoke.stdout ?? '').trim();
if (versionSmoke.status !== 0 || printedVersion !== pkg.version) {
  console.error(
    `✗ version smoke check failed: 'node dist/node.js --version' printed ` +
      `${JSON.stringify(printedVersion)} (exit ${versionSmoke.status}), expected ${JSON.stringify(pkg.version)}`,
  );
  process.exit(1);
}

const agySmoke = spawnSync(process.execPath, [
  '--input-type=module',
  '--eval',
  "import('./dist/agy.js').then((m) => { if (typeof m.runAgyEntry !== 'function') process.exit(1); })",
], { encoding: 'utf8' });
if (agySmoke.status !== 0) {
  console.error(`✗ AGY entrypoint smoke check failed (exit ${agySmoke.status})`);
  process.exit(1);
}

console.log(`✓ version smoke check: --version prints ${pkg.version}`);
console.log('✓ AGY smoke check: runAgyEntry exported');
