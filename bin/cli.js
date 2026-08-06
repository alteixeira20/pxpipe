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

const batchDispatch = argv[0] === 'agy-batch';

const featherlessDispatch =
  (argv[0] === 'models' && argv[1] === 'featherless')
  || (argv[0] === 'doctor' && argv[1] === 'featherless');

let entry = '../dist/node.js';

if (batchDispatch) {
  entry = '../dist/agy-execution.js';
} else if (agyDispatch) {
  entry = '../dist/agy.js';
} else if (featherlessDispatch) {
  entry = '../dist/featherless-cli.js';
}

import(entry)
  .then(async (module) => {
    if (batchDispatch) {
      await module.runAgyBatchEntry(argv.slice(1));
    } else if (agyDispatch) {
      await module.runAgyEntry(argv);
    } else if (featherlessDispatch) {
      await module.runFeatherlessCli(argv);
    }
  })
  .catch((error) => {
    console.error('[pxpipe] failed to start:', error);
    console.error('[pxpipe] did you forget to `npm run build`?');
    process.exit(1);
  });
