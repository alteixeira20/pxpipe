#!/usr/bin/env node

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const warpCommand = separator >= 0 ? argv[separator + 1] : undefined;

const isAgyWord = (word) =>
  /(?:^|[/\\])agy(?:\.exe)?$/i.test(word ?? '');

const agyDispatch =
  argv[0] === 'agy'
  || (argv[0] === 'doctor' && argv[1] === 'agy')
  || (argv[0] === 'warp' && isAgyWord(warpCommand));

const codexDispatch =
  argv[0] === 'codex'
  || (argv[0] === 'doctor' && argv[1] === 'codex');

const batchDispatch = argv[0] === 'agy-batch';
const agyModelsDispatch = argv[0] === 'models' && argv[1] === 'agy';

const featherlessDispatch =
  (argv[0] === 'models' && argv[1] === 'featherless')
  || (argv[0] === 'doctor' && argv[1] === 'featherless');

let entry = '../dist/node.js';

if (batchDispatch) {
  entry = '../dist/agy-execution.js';
} else if (agyModelsDispatch) {
  entry = '../dist/agy-models-cli.js';
} else if (agyDispatch) {
  entry = '../dist/agy-entry.js';
} else if (codexDispatch) {
  entry = '../dist/codex-entry.js';
} else if (featherlessDispatch) {
  entry = '../dist/featherless-cli.js';
}

import(entry)
  .then(async (module) => {
    if (batchDispatch) {
      await module.runAgyBatchEntry(argv.slice(1));
    } else if (agyModelsDispatch) {
      await module.runAgyModelsCli(argv);
    } else if (agyDispatch) {
      await module.runAgyEntryV2(argv);
    } else if (codexDispatch) {
      await module.runCodexEntry(argv);
    } else if (featherlessDispatch) {
      await module.runFeatherlessCli(argv);
    }
  })
  .catch((error) => {
    console.error('[pxpipe] failed to start:', error);
    console.error('[pxpipe] did you forget to `npm run build`?');
    process.exit(1);
  });
