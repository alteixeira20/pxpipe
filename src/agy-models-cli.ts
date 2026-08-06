import { discoverAgyModels } from './agy-models.js';

function parseFlags(args: readonly string[]): { refresh: boolean; json: boolean } {
  let refresh = false;
  let json = false;
  for (const arg of args) {
    if (arg === '--refresh') refresh = true;
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      throw new Error('help');
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return { refresh, json };
}

function printHelp(): void {
  console.log(`pxpipe models agy — discover models exposed by the installed AGY CLI

Usage:
  pxpipe models agy
  pxpipe models agy --json
  pxpipe models agy --refresh [--json]

The command runs only AGY's local --version and models commands. It performs no
model inference request and consumes no model quota.
`);
}

export async function runAgyModelsCli(argv: readonly string[]): Promise<void> {
  try {
    if (argv[0] !== 'models' || argv[1] !== 'agy') {
      throw new Error('usage: pxpipe models agy [--refresh] [--json]');
    }
    const flags = parseFlags(argv.slice(2));
    const result = discoverAgyModels({ refresh: flags.refresh });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        source: result.source,
        cachePath: result.cachePath,
        binary: {
          path: result.catalog.binaryPath,
          version: result.catalog.binaryVersion,
          mtimeMs: result.catalog.binaryMtimeMs,
        },
        fetchedAt: result.catalog.fetchedAt,
        modelCount: result.catalog.models.length,
        models: result.catalog.models,
      })}\n`);
      return;
    }

    for (const model of result.catalog.models) {
      console.log([
        model.id,
        `family=${model.family}`,
        `protocol_hint=${model.protocolHint}`,
        `compression=${model.compressionSupport}`,
      ].join('\t'));
    }
    console.error(
      `[pxpipe] AGY models: ${result.catalog.models.length}; `
      + `source=${result.source}; version=${result.catalog.binaryVersion}`,
    );
  } catch (error) {
    if ((error as Error).message === 'help') {
      printHelp();
      return;
    }
    console.error(`[pxpipe] AGY models: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
