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

await build({
  ...sharedBuild,
  entryPoints: ['src/agy-execution.ts'],
  outfile: 'dist/agy-execution.js',
});

console.log('✓ built dist/node.js + dist/agy.js + dist/agy-execution.js');

const versionSmoke = spawnSync(process.execPath, ['dist/node.js', '--version'], { encoding: 'utf8' });
const printedVersion = (versionSmoke.stdout ?? '').trim();
if (versionSmoke.status !== 0 || printedVersion !== pkg.version) {
  console.error(
    `✗ version smoke check failed: 'node dist/node.js --version' printed ` +
      `${JSON.stringify(printedVersion)} (exit ${versionSmoke.status}), expected ${JSON.stringify(pkg.version)}`,
  );
  process.exit(1);
}

const exportSmokes = [
  ['dist/agy.js', 'runAgyEntry'],
  ['dist/agy-execution.js', 'runAgyBatchEntry'],
];
for (const [file, exported] of exportSmokes) {
  const smoke = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import('./${file}').then((m) => { if (typeof m.${exported} !== 'function') process.exit(1); })`,
  ], { encoding: 'utf8' });
  if (smoke.status !== 0) {
    console.error(`✗ ${file} smoke check failed (exit ${smoke.status})`);
    process.exit(1);
  }
}

console.log(`✓ version smoke check: --version prints ${pkg.version}`);
console.log('✓ AGY smoke checks: command entrypoints exported');
